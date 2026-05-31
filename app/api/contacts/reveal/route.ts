/**
 * AngoConnect — POST /api/contacts/reveal
 * ===========================================================================
 * Revela contactos públicos para o workspace. Debita 1 crédito por contacto
 * via RPC `reveal_contacts` — idempotente (revelar 2× não cobra 2×).
 *
 * Body:
 *   { workspaceId: uuid, contactIds: uuid[] (1..200) }
 *
 * Fluxo:
 *   1. Auth + workspace membership (defesa em profundidade; a RPC valida
 *      novamente via is_workspace_member).
 *   2. Chama RPC `reveal_contacts(p_workspace_id, p_contact_ids)`.
 *   3. Devolve o resumo {revealed_count, already_revealed_count,
 *      credits_debited, new_balance}.
 *
 * Mapa de erros (SQLSTATE):
 *   P0001 (insufficient_credits) → 402 INSUFFICIENT_CREDITS
 *   42501 (unauthorized)         → 401 UNAUTHORIZED
 *   22023 (invalid_parameter)    → 400 INVALID_PARAMETER
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiError, apiOk } from '@/lib/api-response';
import { createClient } from '@/lib/supabase/server';
import { assertWorkspaceMembership } from '@/lib/companies/queries';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  workspaceId: z.string().uuid({ message: 'workspaceId tem de ser UUID' }),
  contactIds: z
    .array(z.string().uuid())
    .min(1, 'pelo menos 1 contacto')
    .max(200, 'máximo 200 contactos por chamada'),
});

interface RpcReturn {
  revealed_count: number;
  already_revealed_count: number;
  credits_debited: number;
  new_balance: number;
}

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

export async function POST(request: NextRequest) {
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

  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return apiError('Body inválido — ver issues', 400, 'INVALID_BODY', {
      issues: parsed.error.issues,
    });
  }
  const body = parsed.data;

  // 3) Membership (defesa em profundidade)
  const isMember = await assertWorkspaceMembership(
    supabase,
    body.workspaceId,
    user.id
  );
  if (!isMember) {
    return apiError(
      'Não é membro deste workspace',
      403,
      'NOT_WORKSPACE_MEMBER'
    );
  }

  // 4) Chama RPC.
  //    `as never` na chamada — mesmo padrão usado em /sequences/enrol.
  const { data: rpcData, error: rpcErr } = await supabase.rpc(
    'reveal_contacts' as never,
    {
      p_workspace_id: body.workspaceId,
      p_contact_ids: body.contactIds,
    } as never
  );

  if (rpcErr) {
    const mapped = mapRpcError(rpcErr as PostgresErrorShape);
    console.error('[contacts/reveal] RPC falhou', {
      sqlstate: rpcErr.code,
      message: rpcErr.message,
      details: rpcErr.details,
    });
    return apiError(
      `Reveal falhou: ${rpcErr.message}`,
      mapped.status,
      mapped.code,
      mapped.detail !== undefined ? { detail: mapped.detail } : undefined
    );
  }

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

  return apiOk({
    revealed_count: rpcRow.revealed_count,
    already_revealed_count: rpcRow.already_revealed_count,
    credits_debited: rpcRow.credits_debited,
    new_balance: rpcRow.new_balance,
  });
}
