/**
 * AngoConnect — POST /api/sequences/[id]/pause
 * ===========================================================================
 * Pausa enrolments de uma sequence.
 *
 * Body opcional:
 *   { enrolmentIds?: uuid[] }
 *
 * Se `enrolmentIds` é omitido (ou vazio), pausamos TODOS os enrolments
 * `active` da sequence. A RPC `pause_enrolments` valida workspace membership
 * por dentro (filtra rows via `is_workspace_member`), portanto a chamada é
 * segura mesmo passando IDs de outros workspaces (são silenciosamente
 * ignorados).
 *
 * Resposta: { paused_count: number }
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiError, apiOk } from '@/lib/api-response';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const pauseBodySchema = z
  .object({
    enrolmentIds: z.array(z.string().uuid()).max(1000).optional(),
  })
  .partial();

interface PostgresErrorShape {
  code?: string;
  message?: string;
}

export async function POST(
  request: NextRequest,
  context: { params: { id: string } }
) {
  // 0) UUID
  const idParsed = z.string().uuid().safeParse(context.params.id);
  if (!idParsed.success) {
    return apiError('Sequence id inválido', 400, 'INVALID_ID');
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

  // 2) Body opcional
  let body: z.infer<typeof pauseBodySchema> = {};
  const ct = request.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      // Tolerante: body inválido conta como omissão.
      raw = {};
    }
    const parsed = pauseBodySchema.safeParse(raw ?? {});
    if (!parsed.success) {
      return apiError('Body inválido', 400, 'INVALID_BODY', {
        issues: parsed.error.issues,
      });
    }
    body = parsed.data;
  }

  // 3) Workspace membership + lookup sequence
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
    return apiError('Falha a procurar sequence', 500, 'LOOKUP_FAILED');
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

  // 4) Resolver enrolmentIds — se omitidos, busca todos os active.
  let enrolmentIds: string[];
  if (body.enrolmentIds && body.enrolmentIds.length > 0) {
    enrolmentIds = body.enrolmentIds;
  } else {
    const { data: rows, error: rowsErr } = await supabase
      .from('sequence_enrollments')
      .select('id')
      .eq('sequence_id', sequenceId)
      .eq('status', 'active')
      .limit(10_000)
      .overrideTypes<Array<{ id: string }>, { merge: false }>();

    if (rowsErr) {
      console.error('[sequences/pause] scan active enrolments falhou', rowsErr);
      return apiError(
        'Falha a procurar enrolments',
        500,
        'SCAN_FAILED'
      );
    }
    enrolmentIds = (rows ?? []).map((r) => r.id);
  }

  if (enrolmentIds.length === 0) {
    return apiOk({ paused_count: 0 });
  }

  // 5) RPC pause_enrolments — devolve int (count).
  const { data: rpcData, error: rpcErr } = await supabase.rpc(
    'pause_enrolments' as never,
    { p_enrolment_ids: enrolmentIds } as never
  );

  if (rpcErr) {
    const pgErr = rpcErr as PostgresErrorShape;
    console.error('[sequences/pause] RPC falhou', pgErr);
    if (pgErr.code === '42501') {
      return apiError('Unauthorized', 401, 'UNAUTHORIZED');
    }
    return apiError(
      `pause_enrolments falhou: ${pgErr.message ?? 'unknown'}`,
      500,
      'RPC_ERROR'
    );
  }

  const pausedCount =
    typeof rpcData === 'number' ? rpcData : Number(rpcData ?? 0);

  return apiOk({ paused_count: pausedCount });
}
