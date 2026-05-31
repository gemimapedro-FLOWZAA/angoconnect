/**
 * AngoConnect — Endpoint para criar workspace
 * ===========================================================================
 * `POST /api/workspaces` — wrapper limpo sobre a RPC
 * `public.create_workspace_with_owner(p_name, p_slug)` (migration 0005).
 *
 * Fluxo:
 *   1. Auth (server client). Sem user → 401.
 *   2. Body Zod: { name, slug }.
 *      - name: 2-80 caracteres.
 *      - slug: 3-40 chars, regex `^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])?$`.
 *   3. Chama `rpc('create_workspace_with_owner', { p_name, p_slug })`.
 *      A RPC é SECURITY DEFINER e usa `auth.uid()` internamente:
 *        - Cria workspace (owner_id = auth.uid()).
 *        - Insere row em workspace_members (role 'owner').
 *        - Insere log de créditos `signup_bonus` (+50).
 *        - Devolve uma linha com os campos do workspace.
 *   4. Mapeamento de erros Postgres:
 *        42501 (unauthorized)     → 401  UNAUTHENTICATED
 *        22023 (invalid_input)    → 400  INVALID_INPUT
 *        23505 (unique violation) → 409  SLUG_TAKEN
 *        outros                    → 500  WORKSPACE_CREATE_FAILED
 *
 * Resposta 200: apiOk(workspace, { meta: { credits_signup_bonus: 50 } })
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { apiError, apiOk } from '@/lib/api-response';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Validação
// ---------------------------------------------------------------------------

const SLUG_REGEX = /^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])?$/;

const createWorkspaceSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, { message: 'Nome tem de ter pelo menos 2 caracteres' })
    .max(80, { message: 'Nome tem no máximo 80 caracteres' }),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(SLUG_REGEX, {
      message:
        'Slug inválido: usar a-z, 0-9 e hífenes (não começar/terminar com hífen, 3-40 chars)',
    }),
});

type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;

// ---------------------------------------------------------------------------
// Tipagem mínima da linha devolvida pela RPC.
// ---------------------------------------------------------------------------

interface CreatedWorkspaceRow {
  id: string;
  name: string;
  slug: string;
  plan: 'starter' | 'growth' | 'pro';
  credits_remaining: number;
  owner_id: string;
  created_at: string;
  updated_at: string;
}

/** Postgres error com sqlstate (shape do supabase-js PostgrestError). */
interface PgErrorLike {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1) Auth ---------------------------------------------------------------
  const supabase = createClient();
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();

  if (userErr || !user) {
    return apiError('Não autenticado', 401, 'UNAUTHENTICATED');
  }

  // 2) Body Zod -----------------------------------------------------------
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return apiError('Body não é JSON válido', 400, 'INVALID_JSON');
  }

  const parsed = createWorkspaceSchema.safeParse(rawBody);
  if (!parsed.success) {
    return apiError('Body inválido — ver issues', 400, 'INVALID_BODY', {
      issues: parsed.error.issues,
    });
  }
  const body: CreateWorkspaceInput = parsed.data;

  // 3) RPC ----------------------------------------------------------------
  // Cast localizado: createServerClient<Database> de @supabase/ssr não
  // está a inferir Functions correctamente (mesmo problema que tivemos com
  // apify_runs em M1.3). Desaparece quando regenerarmos tipos via
  // `supabase gen types typescript --local`.
  const { data, error } = await supabase.rpc(
    'create_workspace_with_owner' as never,
    {
      p_name: body.name,
      p_slug: body.slug,
    } as never
  );

  if (error) {
    const pg = error as unknown as PgErrorLike;
    const code = pg.code;

    if (code === '42501') {
      return apiError('Não autorizado', 401, 'UNAUTHENTICATED');
    }
    if (code === '22023') {
      return apiError(
        pg.message ?? 'Entrada inválida',
        400,
        'INVALID_INPUT'
      );
    }
    if (code === '23505') {
      return apiError(
        'Slug já está em uso — escolhe outro',
        409,
        'SLUG_TAKEN'
      );
    }
    console.error('[api/workspaces] RPC create_workspace_with_owner falhou', {
      code,
      message: pg.message,
      details: pg.details,
    });
    return apiError(
      'Falha a criar workspace',
      500,
      'WORKSPACE_CREATE_FAILED',
      { dbError: pg.message }
    );
  }

  // A RPC devolve uma tabela (array) — pegamos no primeiro elemento.
  const rows = data as unknown as CreatedWorkspaceRow[] | null;
  const workspace = rows?.[0] ?? null;

  if (!workspace) {
    console.error('[api/workspaces] RPC sem dados', { data });
    return apiError(
      'RPC create_workspace_with_owner não devolveu dados',
      500,
      'WORKSPACE_CREATE_EMPTY'
    );
  }

  return apiOk(workspace, { credits_signup_bonus: 50 });
}
