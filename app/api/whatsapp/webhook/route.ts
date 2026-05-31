/**
 * AngoConnect — GET + POST /api/whatsapp/webhook
 * ===========================================================================
 * Webhook para a Meta WhatsApp Cloud API.
 *
 * GET (handshake)
 *   Meta envia `hub.mode=subscribe&hub.verify_token=...&hub.challenge=...`.
 *   Lookup do `webhook_verify_token` em `workspace_whatsapp_config` — se match
 *   e mode='subscribe', devolve `hub.challenge` em text/plain. Senão 403.
 *
 * POST (events)
 *   Body assinado via header `x-hub-signature-256: sha256=<hex>`. HMAC SHA256
 *   do raw body com `META_APP_SECRET`. Comparação constant-time via
 *   `timingSafeEqual`.
 *
 *   Payload típico:
 *     { object: 'whatsapp_business_account',
 *       entry: [{
 *         id: <waba_id>,
 *         changes: [{
 *           field: 'messages',
 *           value: {
 *             messages?: [{ from, id, timestamp, type, text?: { body } }],
 *             statuses?: [{ id, status, recipient_id, timestamp }],
 *             contacts?: [{ wa_id, profile: { name } }],
 *           }
 *         }]
 *       }] }
 *
 *   Mapeamento statuses:
 *     sent       → wa_sent      (já registado no envio — skip se duplicado)
 *     delivered  → wa_delivered
 *     read       → wa_read
 *     failed     → wa_failed
 *
 *   Mensagens RECEBIDAS (messages[]) tratamos como replies:
 *     - match contact por `contacts.phone` (E.164 com ou sem +)
 *     - match enrolment pelo último `wa_sent` desse contact
 *     - INSERT wa_replied
 *
 *   Idempotência: dedup por (wa_message_id, event_type) — SELECT prévio.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/api-response';
import { createAdminClient } from '@/lib/supabase/admin';
import type { Json } from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Tipos do payload Meta
// ---------------------------------------------------------------------------

type MetaStatusType = 'sent' | 'delivered' | 'read' | 'failed';

interface MetaStatus {
  id: string;
  status: MetaStatusType;
  recipient_id?: string;
  timestamp?: string;
  errors?: Array<{ code: number; title: string; message?: string }>;
}

interface MetaIncomingMessage {
  from: string;
  id: string;
  timestamp?: string;
  type: string;
  text?: { body: string };
  // Outros tipos (image, audio, document, …) ignorados aqui — body fica null.
  [k: string]: unknown;
}

interface MetaChangeValue {
  messaging_product?: 'whatsapp';
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  messages?: MetaIncomingMessage[];
  statuses?: MetaStatus[];
  contacts?: Array<{ wa_id: string; profile?: { name?: string } }>;
}

interface MetaChange {
  field: string;
  value: MetaChangeValue;
}

interface MetaEntry {
  id: string;
  changes: MetaChange[];
}

interface MetaWebhookPayload {
  object?: string;
  entry?: MetaEntry[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_TO_EVENT: Record<MetaStatusType, string> = {
  sent: 'wa_sent',
  delivered: 'wa_delivered',
  read: 'wa_read',
  failed: 'wa_failed',
};

/**
 * Normaliza um número Meta wa_id para os formatos que podemos ter em
 * `contacts.phone`. wa_id vem sem `+`, só dígitos. Retornamos ambos
 * (com e sem +) para fazer match flexível.
 */
function phoneCandidates(waId: string): string[] {
  const digits = waId.replace(/[^\d]/g, '');
  if (!digits) return [];
  return [`+${digits}`, digits];
}

/**
 * Verifica assinatura `x-hub-signature-256`. Format: `sha256=<hex>`.
 * HMAC-SHA256 do raw body com `META_APP_SECRET`. Constant-time compare.
 */
function verifyMetaSignature(
  body: string,
  header: string | null,
  secret: string
): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const received = header.slice('sha256='.length);
  const expected = createHmac('sha256', secret).update(body).digest('hex');

  const a = Buffer.from(received, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// GET — handshake
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const mode = sp.get('hub.mode');
  const verifyToken = sp.get('hub.verify_token');
  const challenge = sp.get('hub.challenge');

  if (mode !== 'subscribe' || !verifyToken || !challenge) {
    return apiError(
      'Parâmetros de handshake em falta',
      400,
      'INVALID_HANDSHAKE'
    );
  }

  const admin = createAdminClient();
  // Escape hatch — tabela ainda fora dos stubs tipados (migration 0011).
  const { data, error } = await (admin as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (col: string, val: unknown) => {
          maybeSingle: () => Promise<{
            data: unknown | null;
            error: { message: string } | null;
          }>;
        };
      };
    };
  })
    .from('workspace_whatsapp_config')
    .select('workspace_id, webhook_verify_token, is_active')
    .eq('webhook_verify_token', verifyToken)
    .maybeSingle();

  if (error) {
    console.error('[whatsapp/webhook] lookup verify_token falhou', error);
    return apiError('Lookup falhou', 500, 'DB_ERROR');
  }

  if (!data) {
    return apiError('verify_token inválido', 403, 'INVALID_VERIFY_TOKEN');
  }

  // Devolve challenge em text/plain como a Meta espera.
  return new NextResponse(challenge, {
    status: 200,
    headers: { 'content-type': 'text/plain' },
  });
}

// ---------------------------------------------------------------------------
// POST — eventos
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  // 1) Verificar assinatura. Em dev sem META_APP_SECRET → aceita com warn.
  const secret = process.env.META_APP_SECRET;
  if (secret) {
    const ok = verifyMetaSignature(
      rawBody,
      request.headers.get('x-hub-signature-256'),
      secret
    );
    if (!ok) {
      return apiError('Assinatura inválida', 401, 'INVALID_SIGNATURE');
    }
  } else {
    console.warn(
      '[whatsapp/webhook] META_APP_SECRET não configurada — aceitando sem verificação (DEV ONLY)'
    );
  }

  // 2) Parse JSON
  let payload: MetaWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as MetaWebhookPayload;
  } catch {
    return apiError('Payload não é JSON válido', 400, 'INVALID_JSON');
  }

  if (payload.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) {
    // A Meta envia outros tipos de webhook (instagram, etc.) — ignoramos.
    return apiOk({ received: true, handled: false, reason: 'object_mismatch' });
  }

  const admin = createAdminClient();
  let statusesProcessed = 0;
  let messagesProcessed = 0;

  for (const entry of payload.entry) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages') continue;
      const value = change.value ?? {};

      // ---------------------------------------------------------------
      // STATUSES — actualizações de mensagens que NÓS enviámos.
      // ---------------------------------------------------------------
      for (const status of value.statuses ?? []) {
        const eventType = STATUS_TO_EVENT[status.status];
        if (!eventType) continue;

        // Lookup do envio original via metadata->>'wa_message_id'.
        // Usamos `filter` com `cs` (contains) para JSON. Alternativa: ->> equals.
        const { data: priorSent, error: priorErr } = await admin
          .from('email_events')
          .select('id, enrollment_id, workspace_id')
          .eq('event_type', 'wa_sent' as never)
          .filter('metadata->>wa_message_id', 'eq', status.id)
          .limit(1)
          .maybeSingle();

        if (priorErr) {
          console.warn(
            '[whatsapp/webhook] lookup wa_sent falhou',
            priorErr.message
          );
          continue;
        }
        if (!priorSent) {
          // Status para uma mensagem que não conhecemos — pode ser de outro
          // sistema ou de antes do tracking. Skip silenciosamente.
          continue;
        }

        // Dedup por (enrolment, event_type, wa_message_id)
        const { data: dup } = await admin
          .from('email_events')
          .select('id')
          .eq('enrollment_id', priorSent.enrollment_id)
          .eq('event_type', eventType as never)
          .filter('metadata->>wa_message_id', 'eq', status.id)
          .limit(1)
          .maybeSingle();
        if (dup) continue;

        const meta: Json = {
          wa_message_id: status.id,
          recipient_id: status.recipient_id ?? null,
          timestamp: status.timestamp ?? null,
          errors: status.errors ?? null,
        };

        const { error: insErr } = await admin.from('email_events').insert({
          enrollment_id: priorSent.enrollment_id,
          workspace_id: priorSent.workspace_id,
          event_type: eventType as never,
          metadata: meta,
        });
        if (insErr) {
          console.error(
            '[whatsapp/webhook] insert status event falhou',
            insErr.message
          );
        } else {
          statusesProcessed += 1;
        }

        // Marca enrolment como bounced se falhou definitivamente.
        if (eventType === 'wa_failed') {
          await admin
            .from('sequence_enrollments')
            .update({
              status: 'bounced',
              completed_at: new Date().toISOString(),
              next_action_at: null,
            })
            .eq('id', priorSent.enrollment_id)
            .eq('status', 'active');
        }
      }

      // ---------------------------------------------------------------
      // MESSAGES — mensagens RECEBIDAS dos contactos. Tratamos como replies.
      // ---------------------------------------------------------------
      for (const msg of value.messages ?? []) {
        const candidates = phoneCandidates(msg.from);
        if (candidates.length === 0) continue;

        // Lookup contact por phone (qualquer formato). Usamos `or`.
        const orClause = candidates
          .map((p) => `phone.eq.${p}`)
          .join(',');

        const { data: contactRow, error: contactErr } = await admin
          .from('contacts')
          .select('id, workspace_id')
          .or(orClause)
          .limit(1)
          .maybeSingle();

        if (contactErr) {
          console.warn(
            '[whatsapp/webhook] lookup contact por phone falhou',
            contactErr.message
          );
          continue;
        }
        if (!contactRow) continue;

        // Encontra o último wa_sent enrolment para esse contact.
        // 1. enrolments do contact
        const { data: enrolments, error: enrolErr } = await admin
          .from('sequence_enrollments')
          .select('id, workspace_id, status')
          .eq('contact_id', contactRow.id);

        if (enrolErr || !enrolments || enrolments.length === 0) continue;

        const enrolIds = enrolments.map(
          (r) => (r as { id: string }).id
        );

        // 2. último wa_sent
        const { data: lastSent } = await admin
          .from('email_events')
          .select('id, enrollment_id, workspace_id, occurred_at')
          .in('enrollment_id', enrolIds)
          .eq('event_type', 'wa_sent' as never)
          .order('occurred_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (!lastSent) continue;

        // Dedup por (enrolment, wa_replied, msg.id)
        const { data: dup } = await admin
          .from('email_events')
          .select('id')
          .eq('enrollment_id', lastSent.enrollment_id)
          .eq('event_type', 'wa_replied' as never)
          .filter('metadata->>wa_message_id', 'eq', msg.id)
          .limit(1)
          .maybeSingle();
        if (dup) continue;

        const body =
          msg.type === 'text' && msg.text?.body ? msg.text.body : null;

        const meta: Json = {
          wa_message_id: msg.id,
          from: msg.from,
          type: msg.type,
          body,
          timestamp: msg.timestamp ?? null,
        };

        const { error: insErr } = await admin.from('email_events').insert({
          enrollment_id: lastSent.enrollment_id,
          workspace_id: lastSent.workspace_id,
          event_type: 'wa_replied' as never,
          metadata: meta,
        });
        if (insErr) {
          console.error(
            '[whatsapp/webhook] insert wa_replied falhou',
            insErr.message
          );
        } else {
          messagesProcessed += 1;
          // Marca enrolment como replied (mesmo padrão que email reply).
          // O trigger handle_email_reply_create_deal vai disparar.
          await admin
            .from('sequence_enrollments')
            .update({
              status: 'replied',
              completed_at: new Date().toISOString(),
              next_action_at: null,
            })
            .eq('id', lastSent.enrollment_id)
            .eq('status', 'active');
        }
      }
    }
  }

  return apiOk({
    received: true,
    handled: true,
    statusesProcessed,
    messagesProcessed,
  });
}
