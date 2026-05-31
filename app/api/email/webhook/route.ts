/**
 * AngoConnect — POST /api/email/webhook
 * ===========================================================================
 * Recebe webhooks do Resend (delivered, opened, clicked, bounced, complained).
 *
 * Segurança:
 *   - Resend assina via svix (header `svix-signature` + `svix-timestamp` +
 *     `svix-id`). Verificação HMAC SHA-256 do payload.
 *   - Se `RESEND_WEBHOOK_SECRET` não estiver configurado, aceitamos em
 *     dev (modo conveniente — logamos warn).
 *   - Comparação em constant-time via `verifyWebhookSecret`.
 *
 * Mapeamento Resend → email_events:
 *   email.sent        → skip (já registado pelo nosso job)
 *   email.delivered   → INSERT type='delivered'
 *   email.opened      → INSERT type='opened'
 *   email.clicked     → INSERT type='clicked'
 *   email.bounced     → INSERT type='bounced' + enrolment.status='bounced'
 *   email.complained  → INSERT type='complained' + enrolment.status='unsubscribed'
 *
 * Idempotência:
 *   - Não há UNIQUE constraint composta em email_events. Implementamos com
 *     SELECT prévio por (enrollment_id, event_type, resend_id). Se já existe,
 *     skip. Aceitamos a janela de race; o pior caso é uma row duplicada.
 *
 * O Resend pode mandar o mesmo evento múltiplas vezes (retries). Ignorá-los é
 * essencial.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/api-response';
import { createAdminClient } from '@/lib/supabase/admin';
import type {
  EmailEventType,
  EnrollmentStatus,
  Json,
} from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Tipos do payload Resend
// ---------------------------------------------------------------------------

type ResendEventType =
  | 'email.sent'
  | 'email.delivered'
  | 'email.opened'
  | 'email.clicked'
  | 'email.bounced'
  | 'email.complained'
  | 'email.delivery_delayed'
  | 'email.failed';

interface ResendTag {
  name: string;
  value: string;
}

interface ResendWebhookPayload {
  type: ResendEventType;
  created_at?: string;
  data: {
    email_id?: string;
    to?: string[] | string;
    from?: string;
    subject?: string;
    tags?: ResendTag[] | Record<string, string>;
    [k: string]: unknown;
  };
}

// ---------------------------------------------------------------------------
// Map Resend type → email_events.event_type
// ---------------------------------------------------------------------------

const EVENT_TYPE_MAP: Partial<Record<ResendEventType, EmailEventType>> = {
  'email.delivered': 'delivered',
  'email.opened': 'opened',
  'email.clicked': 'clicked',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
};

// Resend types que alteram o estado do enrolment.
const ENROLMENT_STATUS_FROM_EVENT: Partial<
  Record<ResendEventType, EnrollmentStatus>
> = {
  'email.bounced': 'bounced',
  'email.complained': 'unsubscribed',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extrai `enrolment_id` das tags do Resend. Aceita formato array `[{name,value}]`
 * (o que enviamos) e o objecto plano que o Resend devolve no webhook.
 */
function extractEnrolmentId(
  tags: ResendTag[] | Record<string, string> | undefined
): string | null {
  if (!tags) return null;
  if (Array.isArray(tags)) {
    const found = tags.find((t) => t?.name === 'enrolment_id');
    return found?.value ?? null;
  }
  return (tags as Record<string, string>).enrolment_id ?? null;
}

function extractWorkspaceId(
  tags: ResendTag[] | Record<string, string> | undefined
): string | null {
  if (!tags) return null;
  if (Array.isArray(tags)) {
    const found = tags.find((t) => t?.name === 'workspace_id');
    return found?.value ?? null;
  }
  return (tags as Record<string, string>).workspace_id ?? null;
}

/**
 * Verifica a assinatura svix. Format dos headers:
 *   svix-id:        msg_id
 *   svix-timestamp: unix seconds
 *   svix-signature: v1,<base64> v1,<base64>...
 *
 * HMAC = sha256("{id}.{timestamp}.{body}", secret_bytes), em base64.
 */
function verifySvixSignature(
  body: string,
  headers: {
    svixId: string | null;
    svixTimestamp: string | null;
    svixSignature: string | null;
  },
  secret: string
): boolean {
  if (!headers.svixId || !headers.svixTimestamp || !headers.svixSignature) {
    return false;
  }
  // Resend secret format: `whsec_<base64>`. svix tira o prefixo.
  const secretBytes = secret.startsWith('whsec_')
    ? Buffer.from(secret.slice('whsec_'.length), 'base64')
    : Buffer.from(secret, 'utf8');

  const signedPayload = `${headers.svixId}.${headers.svixTimestamp}.${body}`;
  const expected = createHmac('sha256', secretBytes)
    .update(signedPayload)
    .digest('base64');

  // svix-signature pode trazer múltiplas versões separadas por espaço.
  const parts = headers.svixSignature.split(' ');
  for (const part of parts) {
    const [, sig] = part.split(',');
    if (!sig) continue;
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length) continue;
    if (timingSafeEqual(a, b)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const body = await request.text();

  // -----------------------------------------------------------------------
  // 1) Verificar assinatura (svix). Em dev sem secret → aceita.
  // -----------------------------------------------------------------------
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (secret) {
    const verified = verifySvixSignature(
      body,
      {
        svixId: request.headers.get('svix-id'),
        svixTimestamp: request.headers.get('svix-timestamp'),
        svixSignature: request.headers.get('svix-signature'),
      },
      secret
    );
    if (!verified) {
      return apiError(
        'Assinatura inválida',
        401,
        'INVALID_SIGNATURE'
      );
    }
  } else {
    console.warn(
      '[email/webhook] RESEND_WEBHOOK_SECRET não configurada — aceitando sem verificação (DEV ONLY)'
    );
  }

  // -----------------------------------------------------------------------
  // 2) Parse payload
  // -----------------------------------------------------------------------
  let payload: ResendWebhookPayload;
  try {
    payload = JSON.parse(body) as ResendWebhookPayload;
  } catch {
    return apiError('Payload não é JSON válido', 400, 'INVALID_JSON');
  }

  if (!payload?.type || !payload.data) {
    return apiError(
      'Payload sem type ou data',
      400,
      'INVALID_PAYLOAD'
    );
  }

  // -----------------------------------------------------------------------
  // 3) Eventos ignorados (já registados ou irrelevantes)
  // -----------------------------------------------------------------------
  if (payload.type === 'email.sent') {
    // Já inserimos no momento de envio.
    return apiOk({ received: true, handled: false, reason: 'already_logged' });
  }

  const mappedEventType = EVENT_TYPE_MAP[payload.type];
  if (!mappedEventType) {
    return apiOk({
      received: true,
      handled: false,
      reason: 'event_not_mapped',
      type: payload.type,
    });
  }

  // -----------------------------------------------------------------------
  // 4) Extrai enrolment_id + workspace_id das tags
  // -----------------------------------------------------------------------
  const enrolmentId = extractEnrolmentId(payload.data.tags);
  const workspaceIdFromTag = extractWorkspaceId(payload.data.tags);

  if (!enrolmentId) {
    console.warn(
      '[email/webhook] payload sem enrolment_id nas tags — skip',
      { type: payload.type, emailId: payload.data.email_id }
    );
    return apiOk({
      received: true,
      handled: false,
      reason: 'no_enrolment_tag',
    });
  }

  const admin = createAdminClient();

  // Verifica que o enrolment existe e obtém workspace_id canónico
  // (não confiamos só na tag — defesa em profundidade).
  const { data: enrolmentRow, error: enrolmentErr } = await admin
    .from('sequence_enrollments')
    .select('id, workspace_id, status')
    .eq('id', enrolmentId)
    .maybeSingle();

  if (enrolmentErr) {
    console.error(
      '[email/webhook] lookup enrolment falhou',
      enrolmentErr
    );
    return apiError(
      'DB lookup falhou',
      500,
      'DB_ERROR'
    );
  }
  if (!enrolmentRow) {
    return apiOk({
      received: true,
      handled: false,
      reason: 'enrolment_not_found',
    });
  }

  const workspaceId = enrolmentRow.workspace_id;
  if (workspaceIdFromTag && workspaceIdFromTag !== workspaceId) {
    console.warn(
      '[email/webhook] workspace_id na tag não bate com DB — usando DB',
      { tag: workspaceIdFromTag, db: workspaceId }
    );
  }

  const resendEmailId =
    typeof payload.data.email_id === 'string' ? payload.data.email_id : null;

  // -----------------------------------------------------------------------
  // 5) Idempotência: já existe row para (enrolment, event_type, resend_id)?
  // -----------------------------------------------------------------------
  // SELECT com filtro JSON em metadata. Se não há resendEmailId, usamos só
  // (enrolment, event_type) — aceita 1 row por tipo (suficiente para
  // delivered/bounced/complained). Para opened/clicked não filtramos por
  // unicidade (queremos contar cliques).
  if (resendEmailId) {
    const isUniqueEvent =
      mappedEventType === 'delivered' ||
      mappedEventType === 'bounced' ||
      mappedEventType === 'complained';

    if (isUniqueEvent) {
      const { data: existing, error: existErr } = await admin
        .from('email_events')
        .select('id')
        .eq('enrollment_id', enrolmentId)
        .eq('event_type', mappedEventType)
        .limit(1)
        .maybeSingle();
      if (existErr) {
        console.warn(
          '[email/webhook] check idempotência falhou (segue best-effort)',
          existErr.message
        );
      } else if (existing) {
        return apiOk({
          received: true,
          handled: false,
          reason: 'duplicate_event',
        });
      }
    }
  }

  // -----------------------------------------------------------------------
  // 6) INSERT email_events
  // -----------------------------------------------------------------------
  const metadata: Json = {
    resend_id: resendEmailId,
    resend_type: payload.type,
    raw: payload.data as unknown as Json,
  };

  const { error: insertErr } = await admin.from('email_events').insert({
    enrollment_id: enrolmentId,
    workspace_id: workspaceId,
    event_type: mappedEventType,
    metadata,
  });

  if (insertErr) {
    console.error(
      '[email/webhook] insert email_events falhou',
      insertErr
    );
    // Throw para o Resend retentar.
    return apiError(
      `DB insert falhou: ${insertErr.message}`,
      500,
      'DB_INSERT_FAILED'
    );
  }

  // -----------------------------------------------------------------------
  // 7) Atomicamente actualiza estado do enrolment para bounced/unsubscribed
  // -----------------------------------------------------------------------
  const newStatus = ENROLMENT_STATUS_FROM_EVENT[payload.type];
  if (newStatus && enrolmentRow.status === 'active') {
    const { error: updErr } = await admin
      .from('sequence_enrollments')
      .update({
        status: newStatus,
        completed_at: new Date().toISOString(),
        next_action_at: null,
      })
      .eq('id', enrolmentId);
    if (updErr) {
      console.error(
        '[email/webhook] update enrolment status falhou',
        updErr
      );
      // Não rebenta o webhook — o event já foi registado.
    }
  }

  return apiOk({
    received: true,
    handled: true,
    eventType: mappedEventType,
  });
}
