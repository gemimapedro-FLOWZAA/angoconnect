/**
 * AngoConnect — Webhook Apify
 * ===========================================================================
 * Endpoint que recebe notificações da plataforma Apify quando um actor termina
 * uma run. Em caso de sucesso vai buscar o dataset (Apify Data API), ingere
 * companies (catálogo público para IRGC, privado para LinkedIn/enricher) e
 * contactos (M1.3) via service_role. Actualiza o audit trail em `apify_runs`.
 *
 * Path canónico: `/api/apify/webhook` (CLAUDE.md → "Estrutura de pastas").
 *
 * ---------------------------------------------------------------------------
 * Configuração
 * ---------------------------------------------------------------------------
 * Configura `APIFY_WEBHOOK_SECRET` em `.env.local` com:
 *
 *   openssl rand -hex 32
 *
 * e usa o mesmo valor no Apify Console (Integrations → Webhooks → Headers):
 *
 *   Header name:  X-Apify-Secret
 *   Header value: <o mesmo valor que está em APIFY_WEBHOOK_SECRET>
 *
 * Configura também `APIFY_TOKEN` (Personal API token em Apify → Settings →
 * Integrations → API tokens) para que o backend consiga ler o dataset.
 *
 * ---------------------------------------------------------------------------
 * Segurança
 * ---------------------------------------------------------------------------
 * A comparação do secret usa `timingSafeEqual` (ver
 * `lib/security/verify-webhook.ts`) para prevenir timing attacks.
 *
 * ---------------------------------------------------------------------------
 * Eventos suportados
 * ---------------------------------------------------------------------------
 *   - ACTOR.RUN.SUCCEEDED → fetch dataset + ingest companies + contactos +
 *                           UPDATE apify_runs status='succeeded'.
 *   - ACTOR.RUN.FAILED    → UPDATE apify_runs status='failed' + error_message.
 *   - ACTOR.RUN.ABORTED   → UPDATE apify_runs status='aborted'.
 *   - ACTOR.RUN.TIMED_OUT → UPDATE apify_runs status='timed_out'.
 *   - Restantes           → skipped (no-op).
 */

import type { NextRequest } from 'next/server';
import { ZodError } from 'zod';
import { apiError, apiOk } from '@/lib/api-response';
import {
  ApifyClientError,
  ApifyTimeoutError,
} from '@/lib/apify/client';
import { fetchDatasetItems } from '@/lib/apify/datasets';
import { ingestPublicCatalog } from '@/lib/ingest/companies';
import { ingestContacts } from '@/lib/ingest/contacts';
import { verifyWebhookSecret } from '@/lib/security/verify-webhook';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  apifyWebhookPayloadSchema,
  irgcDatasetItemSchema,
  type ApifyWebhookPayload,
  type IRGCDatasetItem,
} from '@/lib/validators/apify-dataset';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Header canónico definido no CLAUDE.md → "Apify — convenções". */
const WEBHOOK_SECRET_HEADER = 'x-apify-secret';
const DATASET_FETCH_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Tipo parcial do row de apify_runs (placeholder até types Supabase gerados)
// ---------------------------------------------------------------------------

interface ApifyRunRow {
  id: string;
  workspace_id: string | null;
  actor_id: string;
}

// ---------------------------------------------------------------------------
// Mapping eventType → status final no audit trail
// ---------------------------------------------------------------------------

const FAILURE_STATUS_MAP: Partial<
  Record<ApifyWebhookPayload['eventType'], 'failed' | 'aborted' | 'timed_out'>
> = {
  'ACTOR.RUN.FAILED': 'failed',
  'ACTOR.RUN.ABORTED': 'aborted',
  'ACTOR.RUN.TIMED_OUT': 'timed_out',
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  // -----------------------------------------------------------------------
  // 1) Verifica header de assinatura (constant-time)
  // -----------------------------------------------------------------------
  const expectedSecret = process.env.APIFY_WEBHOOK_SECRET;
  if (!expectedSecret) {
    console.error('[apify-webhook] APIFY_WEBHOOK_SECRET não configurada');
    return apiError(
      'Webhook secret não configurada no servidor',
      500,
      'WEBHOOK_SECRET_NOT_CONFIGURED'
    );
  }

  const receivedSecret = request.headers.get(WEBHOOK_SECRET_HEADER);
  if (!verifyWebhookSecret(receivedSecret, expectedSecret)) {
    return apiError(
      'Invalid webhook signature',
      401,
      'WEBHOOK_INVALID_SIGNATURE'
    );
  }

  // -----------------------------------------------------------------------
  // 2) Parse + valida payload
  // -----------------------------------------------------------------------
  let rawPayload: unknown;
  try {
    rawPayload = await request.json();
  } catch {
    return apiError('Payload não é JSON válido', 400, 'WEBHOOK_INVALID_JSON');
  }

  const parsed = apifyWebhookPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return apiError(
      'Payload do webhook não corresponde ao schema esperado',
      400,
      'WEBHOOK_INVALID_PAYLOAD',
      { issues: parsed.error.issues }
    );
  }

  const payload = parsed.data;
  const { eventType, resource, eventData } = payload;

  const admin = createAdminClient();

  // -----------------------------------------------------------------------
  // 3) Lookup do apify_runs (via apify_run_id = resource.id)
  // -----------------------------------------------------------------------
  // Pode não existir (e.g. runs disparados manualmente via Apify CLI/Console)
  // — nesse caso continuamos a processar como catálogo público (workspaceId
  // = null) e não actualizamos audit trail.
  const { data: runRow, error: runLookupErr } = await admin
    .from('apify_runs')
    .select('id, workspace_id, actor_id')
    .eq('apify_run_id', resource.id)
    .maybeSingle()
    .overrideTypes<ApifyRunRow | null, { merge: false }>();

  if (runLookupErr) {
    console.error('[apify-webhook] lookup apify_runs falhou', runLookupErr);
    // Não falha o webhook — segue best-effort sem audit trail update.
  }
  const internalRunId = runRow?.id ?? null;
  const workspaceIdFromRun = runRow?.workspace_id ?? null;

  // -----------------------------------------------------------------------
  // 4) Tratamento de eventos de falha (FAILED / ABORTED / TIMED_OUT)
  // -----------------------------------------------------------------------
  const failureStatus = FAILURE_STATUS_MAP[eventType];
  if (failureStatus) {
    if (internalRunId) {
      const errorMessage = extractStatusMessage(rawPayload);
      const { error: updErr } = await admin
        .from('apify_runs')
        .update({
          status: failureStatus,
          finished_at: new Date().toISOString(),
          error_message: errorMessage,
        })
        .eq('id', internalRunId);
      if (updErr) {
        console.error('[apify-webhook] update audit trail falhou', updErr);
      }
    }
    return apiOk({
      ack: true,
      eventType,
      status: failureStatus,
      runId: resource.id,
      internalRunId,
    });
  }

  // -----------------------------------------------------------------------
  // 5) Skip se evento != SUCCEEDED (e.g. CREATED, RESURRECTED)
  // -----------------------------------------------------------------------
  if (eventType !== 'ACTOR.RUN.SUCCEEDED') {
    return apiOk({
      skipped: true,
      reason: 'event_not_processed',
      eventType,
      runId: resource.id,
      internalRunId,
    });
  }

  // -----------------------------------------------------------------------
  // 6) Fetch do dataset (com timeout de 30s)
  // -----------------------------------------------------------------------
  let rawItems: unknown[];
  try {
    rawItems = await fetchDatasetItems(resource.defaultDatasetId, {
      timeoutMs: DATASET_FETCH_TIMEOUT_MS,
    });
  } catch (err) {
    // Em caso de falha no fetch, marcamos o run como failed (porque o
    // SUCCEEDED da Apify foi consumido mas a ingest nunca completou).
    if (internalRunId) {
      const message = err instanceof Error ? err.message : String(err);
      await admin
        .from('apify_runs')
        .update({
          status: 'failed',
          finished_at: new Date().toISOString(),
          error_message: `fetch dataset falhou: ${message}`,
        })
        .eq('id', internalRunId);
    }

    if (err instanceof ApifyTimeoutError) {
      console.error('[apify-webhook] timeout', err.message);
      return apiError(
        'Timeout ao obter dataset do Apify',
        504,
        'APIFY_FETCH_TIMEOUT',
        { datasetId: resource.defaultDatasetId, timeoutMs: DATASET_FETCH_TIMEOUT_MS }
      );
    }
    if (err instanceof ApifyClientError) {
      console.error('[apify-webhook] apify client error', err.status, err.message);
      return apiError(
        'Falha ao obter dataset do Apify',
        502,
        'APIFY_FETCH_FAILED',
        { datasetId: resource.defaultDatasetId, status: err.status }
      );
    }
    console.error('[apify-webhook] erro inesperado no fetch', err);
    return apiError(
      'Erro inesperado ao obter dataset',
      500,
      'APIFY_FETCH_UNEXPECTED'
    );
  }

  // -----------------------------------------------------------------------
  // 7) Valida cada item individualmente — items inválidos vão para `errors`
  //    e o resto continua a ser ingerido (best-effort).
  // -----------------------------------------------------------------------
  const validItems: IRGCDatasetItem[] = [];
  const validationErrors: Array<{ index: number; error: string }> = [];

  for (let i = 0; i < rawItems.length; i++) {
    const parseRes = irgcDatasetItemSchema.safeParse(rawItems[i]);
    if (parseRes.success) {
      validItems.push(parseRes.data);
    } else {
      validationErrors.push({
        index: i,
        error: zodErrorMessage(parseRes.error),
      });
    }
  }

  // -----------------------------------------------------------------------
  // 8) Ingest de companies — passa workspaceId do run para que o
  //    ingestor decida o scope correcto por source (IRGC → null,
  //    LinkedIn/enricher → workspaceIdFromRun).
  // -----------------------------------------------------------------------
  const companiesResult = await ingestPublicCatalog(validItems, {
    apifyRunId: resource.id,
    workspaceId: workspaceIdFromRun,
  });

  // -----------------------------------------------------------------------
  // 9) Ingest de contactos (M1.3) — só se houver ao menos um item com
  //    `raw.contacts`. O caller (este webhook) injecta o workspaceId que
  //    contactos privados precisam; IRGC tipicamente não traz contactos.
  // -----------------------------------------------------------------------
  const contactsResult = await ingestContacts(validItems, {
    apifyRunId: resource.id,
    workspaceId: workspaceIdFromRun,
  });

  // -----------------------------------------------------------------------
  // 10) UPDATE final em apify_runs (status='succeeded')
  // -----------------------------------------------------------------------
  if (internalRunId) {
    const totalIngested =
      companiesResult.ingested +
      companiesResult.updated +
      contactsResult.contactsIngested +
      contactsResult.contactsUpdated;

    const { error: updErr } = await admin
      .from('apify_runs')
      .update({
        status: 'succeeded',
        finished_at: new Date().toISOString(),
        ingested_items: totalIngested,
        dataset_id: resource.defaultDatasetId,
      })
      .eq('id', internalRunId);
    if (updErr) {
      console.error('[apify-webhook] update succeeded falhou', updErr);
    }
  }

  return apiOk({
    runId: resource.id,
    actorRunId: eventData.actorRunId,
    eventType,
    datasetId: resource.defaultDatasetId,
    internalRunId,
    totalItems: rawItems.length,
    validItems: validItems.length,
    invalidItems: validationErrors.length,
    companies: {
      ingested: companiesResult.ingested,
      updated: companiesResult.updated,
      skipped: companiesResult.skipped,
    },
    contacts: {
      ingested: contactsResult.contactsIngested,
      updated: contactsResult.contactsUpdated,
      skipped: contactsResult.skipped,
    },
    errors: [
      ...validationErrors,
      ...companiesResult.errors,
      ...contactsResult.errors.map((e) => ({
        index: e.index,
        error: `contacts: ${e.error}`,
      })),
    ],
  });
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

/** Resume um ZodError numa única string compacta. */
function zodErrorMessage(err: ZodError): string {
  return err.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}

/**
 * Extrai `resource.statusMessage` do payload cru (não tipado).
 *
 * O Apify só envia `statusMessage` em alguns eventos (FAILED / ABORTED) e
 * não está no schema Zod do payload — por isso lemos do raw.
 */
function extractStatusMessage(raw: unknown): string | null {
  if (raw && typeof raw === 'object' && 'resource' in raw) {
    const resource = (raw as { resource?: unknown }).resource;
    if (resource && typeof resource === 'object' && 'statusMessage' in resource) {
      const msg = (resource as { statusMessage?: unknown }).statusMessage;
      if (typeof msg === 'string' && msg.trim().length > 0) {
        return msg.trim();
      }
    }
  }
  return null;
}
