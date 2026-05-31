/**
 * AngoConnect — Estado do utilizador autenticado
 * ===========================================================================
 * `GET /api/me`
 *
 * Devolve a identidade do utilizador autenticado e a lista de workspaces
 * de que é membro, com role e plano. Usado pelo header para popular o
 * contador de créditos e o seletor de workspace.
 *
 * Resposta:
 *   {
 *     data: {
 *       user: { id: string; email: string | null },
 *       workspaces: Array<{
 *         id: string;
 *         name: string;
 *         slug: string;
 *         role: 'owner' | 'admin' | 'member';
 *         plan: 'starter' | 'growth' | 'pro';
 *         credits_remaining: number;
 *       }>
 *     },
 *     error: null,
 *     meta: { count: number }
 *   }
 *
 * Nota: este endpoint é puramente leitura. RLS garante isolamento.
 * Para reduzir a carga (chamado em cada navegação) pode ser cacheado
 * client-side com `react-query` por 30s.
 */

import { NextResponse } from 'next/server';
import { apiError, apiOk } from '@/lib/api-response';
import { createClient } from '@/lib/supabase/server';
import type {
  WorkspacePlan,
  WorkspaceRole,
} from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface WorkspaceMembershipRow {
  role: WorkspaceRole;
  workspace: {
    id: string;
    name: string;
    slug: string;
    plan: WorkspacePlan;
    credits_remaining: number;
  } | null;
}

export async function GET(): Promise<NextResponse> {
  const supabase = createClient();

  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();

  if (userErr || !user) {
    return apiError('Não autenticado', 401, 'UNAUTHENTICATED');
  }

  // Join workspace_members → workspaces. RLS já filtra por user.
  // Devolvemos `role` da junção + campos do workspace embutidos.
  const { data: rows, error: rowsErr } = await supabase
    .from('workspace_members')
    .select(
      `
      role,
      workspace:workspaces (
        id,
        name,
        slug,
        plan,
        credits_remaining
      )
    `
    )
    .eq('user_id', user.id)
    .overrideTypes<WorkspaceMembershipRow[], { merge: false }>();

  if (rowsErr) {
    console.error('[api/me] erro a ler workspace_members', rowsErr);
    return apiError(
      'Falha a carregar workspaces',
      500,
      'WORKSPACES_FETCH_FAILED',
      { dbError: rowsErr.message }
    );
  }

  const workspaces = (rows ?? [])
    .filter((row): row is WorkspaceMembershipRow & {
      workspace: NonNullable<WorkspaceMembershipRow['workspace']>;
    } => row.workspace !== null)
    .map((row) => ({
      id: row.workspace.id,
      name: row.workspace.name,
      slug: row.workspace.slug,
      role: row.role,
      plan: row.workspace.plan,
      credits_remaining: row.workspace.credits_remaining,
    }));

  return apiOk(
    {
      user: {
        id: user.id,
        email: user.email ?? null,
      },
      workspaces,
    },
    { count: workspaces.length }
  );
}
