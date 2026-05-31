/**
 * AngoConnect — GET /api/cron/process-sequences
 * ===========================================================================
 * Cron drainer chamado a cada minuto (ver `vercel.json`).
 *
 * Responsabilidades:
 *   1. Auth: `Authorization: Bearer ${CRON_SECRET}` (timing-safe).
 *   2. Lock cooperativo via Redis (`SET cron:process-sequences NX EX 50`)
 *      para evitar overlap caso uma execução demore mais que 60s.
 *   3. Scan: lê até 100 enrolments com `status='active' AND next_action_at <= now()`
 *      (usa o índice parcial `sequence_enrollments_due_idx` da migration 0007).
 *   4. Enfileira cada um na BullMQ queue com `jobId = ${enrolmentId}-${stepIndex}`
 *      — a unicidade garante dedupe se este cron e o worker standalone
 *      processarem ao mesmo tempo, ou se a query devolver o mesmo row em
 *      duas execuções consecutivas.
 *
 * Em ambiente Vercel SaaS (sem worker persistente), este cron faz duplo dever:
 *   - drainer (lê DB → fila)
 *   - executor (processa fila imediatamente após enqueue)
 *
 * Por agora ficamos só pelo drainer; o executor corre via worker (`npm run worker`)
 * OU é invocado por outro path (Vercel Background Functions, futuro). Como o
 * cron corre a cada minuto, o lag máximo de envio é ~60s.
 */

import type { NextRequest } from 'next/server';
import { apiError, apiOk } from '@/lib/api-response';
import {
  SEND_EMAIL_JOB_NAME,
  SEND_WHATSAPP_JOB_NAME,
  sequenceQueue,
  type SequenceJobData,
  type SequenceJobName,
} from '@/lib/queue/queues';
import { redisConnection } from '@/lib/redis';
import { verifyWebhookSecret } from '@/lib/security/verify-webhook';
import { createAdminClient } from '@/lib/supabase/admin';
import type { Json } from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Quantos enrolments processar por tick. */
const SCAN_LIMIT = 100;

/** TTL do lock — deve ser menor que o intervalo de cron (60s). */
const LOCK_TTL_SECONDS = 50;
const LOCK_KEY = 'cron:process-sequences';

interface EnrolmentDue {
  id: string;
  current_step: number;
  sequence_id: string;
}

interface SequenceStepsRow {
  id: string;
  steps: Json;
}

/**
 * Extrai o canal do step actual a partir do JSON. Defesa: se o shape estiver
 * partido, default 'email'.
 */
function channelForStep(stepsJson: Json, stepIndex: number): 'email' | 'whatsapp' {
  if (!Array.isArray(stepsJson)) return 'email';
  const raw = stepsJson[stepIndex];
  if (
    raw &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    (raw as { channel?: unknown }).channel === 'whatsapp'
  ) {
    return 'whatsapp';
  }
  return 'email';
}

export async function GET(request: NextRequest) {
  // -----------------------------------------------------------------------
  // 1) Auth — timing-safe
  // -----------------------------------------------------------------------
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error('[cron/process-sequences] CRON_SECRET não configurada');
    return apiError(
      'CRON_SECRET não configurada no servidor',
      500,
      'CRON_SECRET_NOT_CONFIGURED'
    );
  }

  const authHeader = request.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length)
    : null;

  if (!verifyWebhookSecret(token, expected)) {
    return apiError('Unauthorized', 401, 'UNAUTHENTICATED');
  }

  // -----------------------------------------------------------------------
  // 2) Lock cooperativo
  // -----------------------------------------------------------------------
  // `SET key value NX EX seconds` é atómico no Redis. Se já existe key,
  // devolve null e saímos.
  let lockAcquired = false;
  try {
    const setResult = await redisConnection.set(
      LOCK_KEY,
      String(Date.now()),
      'EX',
      LOCK_TTL_SECONDS,
      'NX'
    );
    lockAcquired = setResult === 'OK';
  } catch (err) {
    console.error('[cron/process-sequences] erro a adquirir lock', err);
    // Continua sem lock — pior caso: dupla execução, mas BullMQ jobId dedupe.
  }

  if (!lockAcquired) {
    return apiOk({
      skipped: true,
      reason: 'lock_held',
      scanned: 0,
      enqueued: 0,
    });
  }

  // -----------------------------------------------------------------------
  // 3) Scan DB
  // -----------------------------------------------------------------------
  const admin = createAdminClient();
  const nowIso = new Date().toISOString();

  const { data, error } = await admin
    .from('sequence_enrollments')
    .select('id, current_step, sequence_id')
    .eq('status', 'active')
    .lte('next_action_at', nowIso)
    .order('next_action_at', { ascending: true })
    .limit(SCAN_LIMIT);

  if (error) {
    console.error('[cron/process-sequences] scan falhou', error);
    return apiError(
      'Scan da fila falhou',
      500,
      'SCAN_FAILED',
      { dbError: error.message }
    );
  }

  const due = (data ?? []) as EnrolmentDue[];

  // -----------------------------------------------------------------------
  // 4) Lookup steps das sequences únicas para escolher job name
  //    (email vs whatsapp). Batch select para evitar N+1.
  // -----------------------------------------------------------------------
  const uniqueSequenceIds = Array.from(new Set(due.map((r) => r.sequence_id)));
  const stepsBySequence = new Map<string, Json>();

  if (uniqueSequenceIds.length > 0) {
    const { data: seqRows, error: seqErr } = await admin
      .from('sequences')
      .select('id, steps')
      .in('id', uniqueSequenceIds);

    if (seqErr) {
      console.error(
        '[cron/process-sequences] lookup sequences falhou',
        seqErr
      );
      // Continua sem channel info — default email (mantém compat retro).
    } else {
      for (const row of (seqRows ?? []) as SequenceStepsRow[]) {
        stepsBySequence.set(row.id, row.steps);
      }
    }
  }

  // -----------------------------------------------------------------------
  // 5) Enqueue (com jobId determinístico para dedupe)
  // -----------------------------------------------------------------------
  let enqueued = 0;
  let emailCount = 0;
  let whatsappCount = 0;
  for (const row of due) {
    const jobId = `${row.id}-${row.current_step}`;
    const payload: SequenceJobData = {
      enrolmentId: row.id,
      stepIndex: row.current_step,
    };

    const stepsJson = stepsBySequence.get(row.sequence_id) ?? null;
    const channel = stepsJson
      ? channelForStep(stepsJson, row.current_step)
      : 'email';
    const jobName: SequenceJobName =
      channel === 'whatsapp' ? SEND_WHATSAPP_JOB_NAME : SEND_EMAIL_JOB_NAME;

    try {
      await sequenceQueue.add(jobName, payload, { jobId });
      enqueued += 1;
      if (channel === 'whatsapp') whatsappCount += 1;
      else emailCount += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.toLowerCase().includes('already exists')) {
        continue;
      }
      console.error('[cron/process-sequences] enqueue falhou', err, {
        jobId,
      });
    }
  }

  console.info('[cron/process-sequences] tick', {
    scanned: due.length,
    enqueued,
    emailCount,
    whatsappCount,
  });

  return apiOk({
    enqueued,
    scanned: due.length,
    emailCount,
    whatsappCount,
  });
}
