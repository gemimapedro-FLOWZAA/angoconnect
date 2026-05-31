/**
 * AngoConnect — POST /api/sequences/[id]/unenrol
 * ===========================================================================
 * Desinscreve enrolments (marca como `completed`).
 *
 * Body obrigatório:
 *   { enrolmentIds: uuid[] (1..1000) }
 *
 * NOTA: a RPC `unenrol` NÃO devolve créditos (decisão SQL — refunds via suporte
 * com `add_credits(reason='refund')`).
 *
 * Resposta: { unenrolled_count: number }
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiError, apiOk } from '@/lib/api-response';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const unenrolBodySchema = z.object({
  enrolmentIds: z
    .array(z.string().uuid())
    .min(1, 'pelo menos 1 enrolment')
    .max(1000, 'máximo 1000 por chamada'),
});

interface PostgresErrorShape {
  code?: string;
  message?: string;
}

export async function POST(
  request: NextRequest,
  context: { params: { id: string } }
) {
  // 0) UUID na URL
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

  // 2) Body
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return apiError('Body não é JSON válido', 400, 'INVALID_JSON');
  }

  const parsed = unenrolBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return apiError('Body inválido', 400, 'INVALID_BODY', {
      issues: parsed.error.issues,
    });
  }
  const { enrolmentIds } = parsed.data;

  // 3) Workspace membership
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

  // 4) RPC unenrol — devolve int (count).
  const { data: rpcData, error: rpcErr } = await supabase.rpc(
    'unenrol' as never,
    { p_enrolment_ids: enrolmentIds } as never
  );

  if (rpcErr) {
    const pgErr = rpcErr as PostgresErrorShape;
    console.error('[sequences/unenrol] RPC falhou', pgErr);
    if (pgErr.code === '42501') {
      return apiError('Unauthorized', 401, 'UNAUTHORIZED');
    }
    return apiError(
      `unenrol falhou: ${pgErr.message ?? 'unknown'}`,
      500,
      'RPC_ERROR'
    );
  }

  const unenrolledCount =
    typeof rpcData === 'number' ? rpcData : Number(rpcData ?? 0);

  return apiOk({ unenrolled_count: unenrolledCount });
}
