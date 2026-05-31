/**
 * AngoConnect — GET + POST /api/deal-stages
 * ===========================================================================
 * Endpoints para gerir os stages do pipeline CRM (M3.3 — Kanban).
 *
 * GET /api/deal-stages?workspaceId=uuid
 *   Lista stages visíveis ao workspace (system + privados).
 *   Ordenados por (workspace_id IS NULL ASC, position ASC) — privados
 *   aparecem primeiro se existirem, depois system.
 *   Resposta: { data: Stage[] }
 *
 * POST /api/deal-stages
 *   Cria um stage privado do workspace (is_system=false).
 *   Body:
 *     { workspaceId, name, position?, color?, is_won?, is_lost? }
 *   Defaults:
 *     - position = max(position privadas)+1
 *     - color = 'slate'
 *   Recusa is_won AND is_lost simultâneo → 400.
 *
 * Erros:
 *   UNAUTHENTICATED       401
 *   INVALID_QUERY/BODY    400
 *   INVALID_JSON          400
 *   INVALID_WON_LOST      400 (is_won e is_lost ambos true)
 *   NOT_WORKSPACE_MEMBER  403
 *   DB_QUERY_FAILED       500
 *   DB_INSERT_FAILED      500
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiError, apiOk } from '@/lib/api-response';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Shape canónico de stage — vive em `lib/crm/shapes.ts` (Next.js não permite
// exports não-handlers em route.ts)
// ---------------------------------------------------------------------------

import { STAGE_SELECT, type DealStageRow } from '@/lib/crm/shapes';

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

const listStagesSchema = z.object({
  workspaceId: z.string().uuid({ message: 'workspaceId tem de ser UUID' }),
});

export async function GET(request: NextRequest) {
  // 1) Auth
  const supabase = createClient();
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    return apiError('Não autenticado', 401, 'UNAUTHENTICATED');
  }

  // 2) Query Zod
  const { searchParams } = new URL(request.url);
  const parsed = listStagesSchema.safeParse({
    workspaceId: searchParams.get('workspaceId') ?? undefined,
  });
  if (!parsed.success) {
    return apiError('Query inválida', 400, 'INVALID_QUERY', {
      issues: parsed.error.issues,
    });
  }
  const { workspaceId } = parsed.data;

  // 3) Membership (defesa em profundidade; RLS já isola)
  const { data: member, error: memberErr } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('workspace_id', workspaceId)
    .eq('user_id', user.id)
    .maybeSingle()
    .overrideTypes<{ workspace_id: string } | null, { merge: false }>();

  if (memberErr) {
    console.error('[deal-stages] erro a verificar workspace_members', memberErr);
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

  // 4) Query — system (workspace_id NULL) + privadas (= workspaceId).
  //    Order: workspace_id ASC com NULLS LAST faz com que privados (não-null)
  //    venham primeiro, mas o PostgREST não tem flag NULLS LAST simples por
  //    coluna; pedimos `nullsFirst: false`.
  const { data, error } = await supabase
    .from('deal_stages')
    .select(STAGE_SELECT)
    .or(`workspace_id.is.null,workspace_id.eq.${workspaceId}`)
    .order('workspace_id', { ascending: true, nullsFirst: false })
    .order('position', { ascending: true })
    .overrideTypes<DealStageRow[], { merge: false }>();

  if (error) {
    console.error('[deal-stages] list falhou', error);
    return apiError('Falha a listar stages', 500, 'DB_QUERY_FAILED', {
      dbError: error.message,
    });
  }

  return apiOk(data ?? []);
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

const createStageSchema = z
  .object({
    workspaceId: z.string().uuid({ message: 'workspaceId tem de ser UUID' }),
    name: z.string().trim().min(1).max(40),
    position: z.number().int().min(0).max(999).optional(),
    color: z.string().trim().min(1).max(20).optional(),
    is_won: z.boolean().optional(),
    is_lost: z.boolean().optional(),
  })
  .refine((b) => !(b.is_won === true && b.is_lost === true), {
    message: 'is_won e is_lost não podem ser ambos true',
    path: ['is_won'],
  });

type CreateStageBody = z.infer<typeof createStageSchema>;

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

  // 2) Body Zod
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return apiError('Body não é JSON válido', 400, 'INVALID_JSON');
  }

  const parsed = createStageSchema.safeParse(rawBody);
  if (!parsed.success) {
    // Detecta caso específico is_won AND is_lost
    const hasWonLostIssue = parsed.error.issues.some(
      (i) => i.message === 'is_won e is_lost não podem ser ambos true'
    );
    if (hasWonLostIssue) {
      return apiError(
        'is_won e is_lost não podem ser ambos true',
        400,
        'INVALID_WON_LOST'
      );
    }
    return apiError('Body inválido — ver issues', 400, 'INVALID_BODY', {
      issues: parsed.error.issues,
    });
  }
  const body: CreateStageBody = parsed.data;

  // 3) Workspace membership
  const { data: member, error: memberErr } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('workspace_id', body.workspaceId)
    .eq('user_id', user.id)
    .maybeSingle()
    .overrideTypes<{ workspace_id: string } | null, { merge: false }>();

  if (memberErr) {
    console.error('[deal-stages] erro a verificar workspace_members', memberErr);
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

  // 4) Determinar `position` default = max(position das privadas)+1
  //    (Não conta system stages — privadas são uma sequência separada
  //    visualmente, mas no fim a UI ordena por position global na coluna.)
  let position = body.position;
  if (position === undefined) {
    const { data: maxRow, error: maxErr } = await supabase
      .from('deal_stages')
      .select('position')
      .eq('workspace_id', body.workspaceId)
      .order('position', { ascending: false })
      .limit(1)
      .maybeSingle()
      .overrideTypes<{ position: number } | null, { merge: false }>();

    if (maxErr) {
      console.error('[deal-stages] max position lookup falhou', maxErr);
      return apiError(
        'Falha a calcular position do stage',
        500,
        'DB_QUERY_FAILED'
      );
    }
    position = (maxRow?.position ?? 0) + 1;
  }

  // 5) INSERT — is_system sempre false via API; RLS confirma membership.
  const { data: row, error: insertErr } = await supabase
    .from('deal_stages')
    .insert({
      workspace_id: body.workspaceId,
      name: body.name,
      position,
      color: body.color ?? 'slate',
      is_won: body.is_won ?? false,
      is_lost: body.is_lost ?? false,
      is_system: false,
    } as never)
    .select(STAGE_SELECT)
    .single()
    .overrideTypes<DealStageRow | null, { merge: false }>();

  if (insertErr || !row) {
    console.error('[deal-stages] insert falhou', insertErr);
    return apiError('Falha a criar stage', 500, 'DB_INSERT_FAILED', {
      dbError: insertErr?.message,
    });
  }

  return apiOk(row);
}
