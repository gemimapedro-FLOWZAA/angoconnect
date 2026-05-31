/**
 * AngoConnect — Endpoint para disparar runs de Actors Apify
 * ===========================================================================
 * `POST /api/apify/trigger` — autenticado, valida workspace_id, escreve em
 * `apify_runs` (audit trail) e dispara o Actor via Apify API. Resposta
 * inclui o `apify_run_id` e o `apify_runs.id` interno.
 *
 * ---------------------------------------------------------------------------
 * Fluxo
 * ---------------------------------------------------------------------------
 *   1. Auth: cliente Supabase server-side (cookies do SSR) → `auth.getUser()`.
 *      Sem user, 401.
 *   2. Body Zod: { actorId, workspaceId (uuid), input }.
 *   3. Workspace check: `workspace_members` confirma que `user.id` é membro.
 *      Se não, 403.
 *   4. INSERT em `apify_runs` (status='queued') usando o cliente autenticado
 *      (RLS valida em profundidade).
 *   5. Dispatch via Apify API: `POST /v2/acts/{ACTOR_TASK_ID}/runs` com
 *      `body: input`. Timeout 15s. Em caso de falha, marca run como 'failed'
 *      e propaga 502.
 *   6. UPDATE em `apify_runs` (admin client) com `apify_run_id`, `dataset_id`,
 *      `started_at`, status='running'.
 *   7. Resposta: `apiOk({ runId, datasetId, status: 'running' }, { meta: ... })`.
 *
 * ---------------------------------------------------------------------------
 * Configuração
 * ---------------------------------------------------------------------------
 * Necessárias em `.env.local`:
 *   APIFY_TOKEN
 *   APIFY_ACTOR_IRGC            (formato `username~actor-name` ou Actor ID)
 *   APIFY_ACTOR_LINKEDIN
 *   APIFY_ACTOR_EMAIL_ENRICHER
 *   APIFY_ACTOR_NEWS
 *   APIFY_ACTOR_BUE
 *
 * Se a env var não estiver definida para o `actorId` pedido, devolve 500
 * com o código `ACTOR_NOT_CONFIGURED`.
 *
 * ---------------------------------------------------------------------------
 * Notas técnicas
 * ---------------------------------------------------------------------------
 *  - O INSERT inicial usa o cliente autenticado (RLS) para que a tentativa
 *    falhe explicitamente se o utilizador não for membro do workspace
 *    (defesa em profundidade — o check explícito em `workspace_members`
 *    já apanhou o caso, mas é bom ter as duas barreiras).
 *  - O UPDATE pós-dispatch usa o admin client (service_role) — UPDATE em
 *    `apify_runs` está reservado a service_role per migration 0004.
 *  - Não fazemos débito de créditos aqui: M3 trata disso na exportação.
 *  - Idempotência: cada call cria um row novo em `apify_runs`. Não há
 *    idempotency-key por agora (ver "Riscos pendentes" no relatório).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { apiError, apiOk } from '@/lib/api-response';
import {
  ApifyClientError,
  ApifyTimeoutError,
  apifyPost,
} from '@/lib/apify/client';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import type { Json } from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Whitelist de Actors aceites. */
const ALLOWED_ACTORS = [
  'irgc-scraper',
  'linkedin-scraper',
  'email-enricher',
  'news-scraper',
  'bue-scraper',
] as const;
type ActorId = (typeof ALLOWED_ACTORS)[number];

/** Mapping actorId → env var que contém o Actor/Task ID na Apify. */
const ACTOR_ENV_VAR: Record<ActorId, string> = {
  'irgc-scraper': 'APIFY_ACTOR_IRGC',
  'linkedin-scraper': 'APIFY_ACTOR_LINKEDIN',
  'email-enricher': 'APIFY_ACTOR_EMAIL_ENRICHER',
  'news-scraper': 'APIFY_ACTOR_NEWS',
  'bue-scraper': 'APIFY_ACTOR_BUE',
};

/** Timeout do dispatch para a Apify API. */
const APIFY_DISPATCH_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Validação Zod do body
// ---------------------------------------------------------------------------

const triggerBodySchema = z.object({
  actorId: z.enum(ALLOWED_ACTORS),
  workspaceId: z.string().uuid({ message: 'workspaceId tem de ser UUID' }),
  input: z.record(z.string(), z.unknown()).default({}),
});

type TriggerBody = z.infer<typeof triggerBodySchema>;

// ---------------------------------------------------------------------------
// Shape mínimo da resposta da Apify ao criar um run
// ---------------------------------------------------------------------------
// docs: https://docs.apify.com/api/v2#/reference/actors/run-collection/run-actor
//
// A resposta real é `{ data: { id, defaultDatasetId, ... } }` — extraímos
// apenas o que precisamos. Resto é descartado.

interface ApifyRunResponse {
  data: {
    id: string;
    defaultDatasetId: string;
    status?: string;
    startedAt?: string;
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest): Promise<NextResponse> {
  // -----------------------------------------------------------------------
  // 1) Auth
  // -----------------------------------------------------------------------
  const supabase = createClient();
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    return apiError('Não autenticado', 401, 'UNAUTHENTICATED');
  }

  // -----------------------------------------------------------------------
  // 2) Body + Zod
  // -----------------------------------------------------------------------
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return apiError('Body não é JSON válido', 400, 'INVALID_JSON');
  }

  const parsed = triggerBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return apiError(
      'Body inválido — ver issues',
      400,
      'INVALID_BODY',
      { issues: parsed.error.issues }
    );
  }
  const body: TriggerBody = parsed.data;

  // -----------------------------------------------------------------------
  // 3) Workspace membership (defesa em profundidade — RLS faz o resto)
  // -----------------------------------------------------------------------
  const { data: member, error: memberErr } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('workspace_id', body.workspaceId)
    .eq('user_id', user.id)
    .maybeSingle()
    .overrideTypes<{ workspace_id: string } | null, { merge: false }>();

  if (memberErr) {
    console.error('[apify-trigger] erro a verificar workspace_members', memberErr);
    return apiError(
      'Falha a verificar permissões do workspace',
      500,
      'WORKSPACE_CHECK_FAILED'
    );
  }
  if (!member) {
    return apiError(
      'Não é membro deste workspace',
      403,
      'NOT_WORKSPACE_MEMBER'
    );
  }

  // -----------------------------------------------------------------------
  // 4) Env var do Actor
  // -----------------------------------------------------------------------
  const envVarName = ACTOR_ENV_VAR[body.actorId];
  const actorTaskId = process.env[envVarName];
  if (!actorTaskId) {
    console.error(
      `[apify-trigger] env var ${envVarName} ausente para actor ${body.actorId}`
    );
    return apiError(
      `Actor ${body.actorId} not configured`,
      500,
      'ACTOR_NOT_CONFIGURED'
    );
  }

  // -----------------------------------------------------------------------
  // 5) INSERT inicial em apify_runs (admin client; membership já validada
  //    explicitamente em workspace_members acima)
  // -----------------------------------------------------------------------
  // O cliente admin é usado tanto para o INSERT inicial como para os UPDATEs
  // subsequentes em apify_runs, porque o RLS de update está restrito a
  // service_role (migration 0004). O check explícito de workspace_members
  // (passo 3) é a barreira de autorização — fazer também o INSERT com auth
  // client seria defesa-em-profundidade mas obriga a RLS policy de INSERT.
  const admin = createAdminClient();

  const { data: insertedRun, error: insertErr } = await admin
    .from('apify_runs')
    .insert({
      workspace_id: body.workspaceId,
      actor_id: body.actorId,
      status: 'queued',
      input: body.input as Json,
      triggered_by: user.id,
    })
    .select('id')
    .single();

  if (insertErr || !insertedRun) {
    console.error('[apify-trigger] insert apify_runs falhou', insertErr);
    return apiError(
      'Falha a registar run no audit trail',
      500,
      'APIFY_RUN_INSERT_FAILED',
      { dbError: insertErr?.message }
    );
  }
  const internalRunId = insertedRun.id;

  // -----------------------------------------------------------------------
  // 6) Dispatch via Apify API
  // -----------------------------------------------------------------------

  let runResponse: ApifyRunResponse;
  try {
    runResponse = await apifyPost<ApifyRunResponse>(
      `/acts/${encodeURIComponent(actorTaskId)}/runs`,
      body.input,
      { timeoutMs: APIFY_DISPATCH_TIMEOUT_MS }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Marca o run como failed no audit trail.
    await admin
      .from('apify_runs')
      .update({
        status: 'failed',
        error_message: message,
        finished_at: new Date().toISOString(),
      })
      .eq('id', internalRunId);

    if (err instanceof ApifyTimeoutError) {
      return apiError(
        'Timeout ao disparar Actor na Apify',
        504,
        'APIFY_DISPATCH_TIMEOUT',
        { internalRunId, timeoutMs: APIFY_DISPATCH_TIMEOUT_MS }
      );
    }
    if (err instanceof ApifyClientError) {
      return apiError(
        'Falha ao disparar Actor na Apify',
        502,
        'APIFY_DISPATCH_FAILED',
        { internalRunId, status: err.status, apifyBody: err.responseBody }
      );
    }
    console.error('[apify-trigger] erro inesperado no dispatch', err);
    return apiError(
      'Erro inesperado no dispatch para Apify',
      500,
      'APIFY_DISPATCH_UNEXPECTED',
      { internalRunId }
    );
  }

  // Sanity-check da resposta — a Apify devolve `{ data: { id, ... } }`.
  if (
    !runResponse?.data ||
    typeof runResponse.data.id !== 'string' ||
    typeof runResponse.data.defaultDatasetId !== 'string'
  ) {
    await admin
      .from('apify_runs')
      .update({
        status: 'failed',
        error_message: 'Resposta inesperada da Apify ao criar run',
        finished_at: new Date().toISOString(),
      })
      .eq('id', internalRunId);
    return apiError(
      'Resposta inesperada da Apify',
      502,
      'APIFY_INVALID_RESPONSE',
      { internalRunId }
    );
  }

  const { id: apifyRunId, defaultDatasetId: datasetId } = runResponse.data;

  // -----------------------------------------------------------------------
  // 7) UPDATE em apify_runs com IDs reais (admin client)
  // -----------------------------------------------------------------------
  const { error: updateErr } = await admin
    .from('apify_runs')
    .update({
      apify_run_id: apifyRunId,
      dataset_id: datasetId,
      status: 'running',
      started_at: new Date().toISOString(),
    })
    .eq('id', internalRunId);

  if (updateErr) {
    // O dispatch já correu — não rebenta a resposta. Loga e segue.
    // O webhook subsequente pode não encontrar o row pelo `apify_run_id`
    // (porque o UPDATE falhou), mas isso é tratado lá com fallback.
    console.error(
      '[apify-trigger] update pós-dispatch falhou',
      updateErr,
      { internalRunId, apifyRunId }
    );
  }

  // -----------------------------------------------------------------------
  // 8) Resposta
  // -----------------------------------------------------------------------
  return apiOk(
    {
      runId: apifyRunId,
      datasetId,
      status: 'running' as const,
    },
    { internalRunId }
  );
}
