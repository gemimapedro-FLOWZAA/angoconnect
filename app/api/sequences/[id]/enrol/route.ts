/**
 * AngoConnect — POST /api/sequences/[id]/enrol
 * ===========================================================================
 * Inscreve um batch de contactos numa sequence.
 *
 * Body:
 *   { contactIds: uuid[] (1..500) }
 *
 * Fluxo:
 *   1. Auth + workspace membership (validado por dentro da RPC via
 *      `is_workspace_member` — mas fazemos check defensivo aqui).
 *   2. Chama RPC `enrol_contacts_into_sequence(p_sequence_id, p_contact_ids)`.
 *      A RPC faz: validações + INSERT enrolments + DEBIT créditos numa
 *      transacção. Lock pessimista no workspace.
 *   3. Após sucesso, dispara jobs BullMQ imediatos para enrolments com
 *      `next_action_at <= now()` — i.e., steps com `day_offset = 0`.
 *      Isto evita esperar 1 min pelo cron.
 *
 * Erros mapeados (RPC SQLSTATE):
 *   42501 → 401 / 403 (unauthorized — pode ser sem auth OU não-membro)
 *   22023 → 400 (validação)
 *   P0001 → 402 INSUFFICIENT_CREDITS (insufficient_credits)
 *
 * Resposta sucesso:
 *   {
 *     enrolled_count: number,
 *     skipped_count: number,
 *     credits_debited: number,
 *     new_balance: number
 *   }
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiError, apiOk } from '@/lib/api-response';
import {
  SEND_EMAIL_JOB_NAME,
  sequenceQueue,
  type SendEmailJobData,
} from '@/lib/queue/queues';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Zod
// ---------------------------------------------------------------------------

const enrolBodySchema = z.object({
  contactIds: z
    .array(z.string().uuid())
    .min(1, 'pelo menos 1 contacto')
    .max(500, 'máximo 500 contactos por chamada'),
});

type EnrolBody = z.infer<typeof enrolBodySchema>;

// ---------------------------------------------------------------------------
// Tipo do retorno da RPC
// ---------------------------------------------------------------------------

interface RpcReturn {
  enrolled_count: number;
  skipped_count: number;
  credits_debited: number;
  new_balance: number;
}

// ---------------------------------------------------------------------------
// Map SQLSTATE → HTTP
// ---------------------------------------------------------------------------

interface PostgresErrorShape {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
}

function mapRpcError(
  err: PostgresErrorShape
): { status: number; code: string; detail?: unknown } {
  const sqlstate = err.code ?? '';
  const msg = err.message ?? '';

  if (sqlstate === 'P0001' || msg.includes('insufficient_credits')) {
    return {
      status: 402,
      code: 'INSUFFICIENT_CREDITS',
      detail: err.details ?? err.message,
    };
  }
  if (sqlstate === '42501') {
    return { status: 401, code: 'UNAUTHORIZED' };
  }
  if (sqlstate === '22023') {
    return {
      status: 400,
      code: 'INVALID_PARAMETER',
      detail: err.details ?? err.message,
    };
  }
  return { status: 500, code: 'RPC_ERROR', detail: err.message };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function POST(
  request: NextRequest,
  context: { params: { id: string } }
) {
  // 0) UUID na URL
  const idParsed = z.string().uuid().safeParse(context.params.id);
  if (!idParsed.success) {
    return apiError(
      'Sequence id inválido',
      400,
      'INVALID_ID',
      { issues: idParsed.error.issues }
    );
  }
  const sequenceId = idParsed.data;

  // 1) Auth
  const supabase = createClient();
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    return apiError('Não autenticado', 401, 'UNAUTHENTICATED');
  }

  // 2) Body
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return apiError('Body não é JSON válido', 400, 'INVALID_JSON');
  }

  const parsed = enrolBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return apiError('Body inválido — ver issues', 400, 'INVALID_BODY', {
      issues: parsed.error.issues,
    });
  }
  const body: EnrolBody = parsed.data;

  // 3) Workspace membership — defesa em profundidade.
  // A RPC vai validar isto outra vez, mas queremos 403 distinto de 401.
  const { data: seqRow, error: seqErr } = await supabase
    .from('sequences')
    .select('id, workspace_id')
    .eq('id', sequenceId)
    .maybeSingle()
    .overrideTypes<
      { id: string; workspace_id: string } | null,
      { merge: false }
    >();

  if (seqErr) {
    console.error('[sequences/enrol] lookup sequence falhou', seqErr);
    return apiError(
      'Falha a procurar sequence',
      500,
      'LOOKUP_FAILED'
    );
  }
  if (!seqRow) {
    return apiError('Sequence não encontrada', 404, 'NOT_FOUND');
  }

  const { data: member } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('workspace_id', seqRow.workspace_id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!member) {
    return apiError(
      'Não é membro deste workspace',
      403,
      'NOT_WORKSPACE_MEMBER'
    );
  }

  // 4) Chama RPC
  // Cast `as never` no mesmo padrão de M2.1/M2.2 — o TS infere mal o shape
  // de tabelas de retorno em createServerClient<Database>.rpc.
  const { data: rpcData, error: rpcErr } = await supabase.rpc(
    'enrol_contacts_into_sequence' as never,
    {
      p_sequence_id: sequenceId,
      p_contact_ids: body.contactIds,
    } as never
  );

  if (rpcErr) {
    const mapped = mapRpcError(rpcErr as PostgresErrorShape);
    console.error('[sequences/enrol] RPC falhou', {
      sqlstate: rpcErr.code,
      message: rpcErr.message,
      details: rpcErr.details,
    });
    return apiError(
      `Enrol falhou: ${rpcErr.message}`,
      mapped.status,
      mapped.code,
      mapped.detail !== undefined ? { detail: mapped.detail } : undefined
    );
  }

  // RPC devolve setof — pode vir como array de 1 row ou como objecto.
  const rpcRow: RpcReturn | null = Array.isArray(rpcData)
    ? ((rpcData[0] as RpcReturn | undefined) ?? null)
    : ((rpcData as RpcReturn | null) ?? null);

  if (!rpcRow) {
    return apiError(
      'RPC devolveu resposta vazia',
      500,
      'RPC_EMPTY_RESPONSE'
    );
  }

  // 5) Disparar jobs imediatos para enrolments com next_action_at <= now()
  //
  // Buscamos enrolments deste user para esta sequence onde os contactos
  // estão entre os passados no body — limita o scan.
  let enqueuedJobs = 0;
  if (rpcRow.enrolled_count > 0) {
    const admin = createAdminClient();
    const nowIso = new Date().toISOString();

    const { data: dueRows, error: dueErr } = await admin
      .from('sequence_enrollments')
      .select('id, current_step')
      .eq('sequence_id', sequenceId)
      .in('contact_id', body.contactIds)
      .eq('status', 'active')
      .lte('next_action_at', nowIso)
      .overrideTypes<
        Array<{ id: string; current_step: number }>,
        { merge: false }
      >();

    if (dueErr) {
      console.error('[sequences/enrol] scan due enrolments falhou', dueErr);
      // Não rebenta — o cron vai apanhar.
    } else {
      for (const row of dueRows ?? []) {
        const jobId = `${row.id}-${row.current_step}`;
        const data: SendEmailJobData = {
          enrolmentId: row.id,
          stepIndex: row.current_step,
        };
        try {
          await sequenceQueue.add(SEND_EMAIL_JOB_NAME, data, { jobId });
          enqueuedJobs += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.toLowerCase().includes('already exists')) continue;
          console.error('[sequences/enrol] enqueue falhou', err, { jobId });
        }
      }
    }
  }

  return apiOk(
    {
      enrolled_count: rpcRow.enrolled_count,
      skipped_count: rpcRow.skipped_count,
      credits_debited: rpcRow.credits_debited,
      new_balance: rpcRow.new_balance,
    },
    { enqueued_jobs: enqueuedJobs }
  );
}
