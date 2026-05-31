/**
 * AngoConnect — PATCH + DELETE /api/deal-stages/[id]
 * ===========================================================================
 * Actualiza ou apaga um stage privado do workspace. Stages de sistema
 * (is_system=true, workspace_id NULL) são imutáveis via API.
 *
 * PATCH /api/deal-stages/:id
 *   Body parcial: { name?, position?, color?, is_won?, is_lost? }
 *   Permite reorder via position. Recusa is_won AND is_lost simultâneo → 400.
 *
 * DELETE /api/deal-stages/:id
 *   FK ON DELETE RESTRICT do deals.stage_id mapeia para 409 STAGE_HAS_DEALS.
 *
 * Erros:
 *   UNAUTHENTICATED       401
 *   INVALID_ID/BODY/JSON  400
 *   INVALID_WON_LOST      400
 *   NOT_FOUND             404
 *   SYSTEM_STAGE          403 (tentar editar/apagar system stage)
 *   STAGE_HAS_DEALS       409 (FK 23503 ou contagem prévia > 0)
 *   DB_UPDATE/DELETE      500
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiError, apiOk } from '@/lib/api-response';
import { type DealStageRow, STAGE_SELECT } from '@/lib/crm/shapes';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// PATCH
// ---------------------------------------------------------------------------

const patchStageSchema = z
  .object({
    name: z.string().trim().min(1).max(40).optional(),
    position: z.number().int().min(0).max(999).optional(),
    color: z.string().trim().min(1).max(20).optional(),
    is_won: z.boolean().optional(),
    is_lost: z.boolean().optional(),
  })
  .refine(
    (b) =>
      b.name !== undefined ||
      b.position !== undefined ||
      b.color !== undefined ||
      b.is_won !== undefined ||
      b.is_lost !== undefined,
    {
      message:
        'Body deve conter pelo menos um campo (name/position/color/is_won/is_lost)',
    }
  )
  .refine((b) => !(b.is_won === true && b.is_lost === true), {
    message: 'is_won e is_lost não podem ser ambos true',
    path: ['is_won'],
  });

type PatchStageBody = z.infer<typeof patchStageSchema>;

export async function PATCH(
  request: NextRequest,
  context: { params: { id: string } }
) {
  // 0) Validar UUID
  const idParsed = z.string().uuid().safeParse(context.params.id);
  if (!idParsed.success) {
    return apiError('Stage id inválido', 400, 'INVALID_ID', {
      issues: idParsed.error.issues,
    });
  }
  const stageId = idParsed.data;

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

  const parsed = patchStageSchema.safeParse(rawBody);
  if (!parsed.success) {
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
  const body: PatchStageBody = parsed.data;

  // 3) Lookup — 404 se RLS esconder ou não existir
  const { data: existing, error: lookupErr } = await supabase
    .from('deal_stages')
    .select('id, workspace_id, is_system')
    .eq('id', stageId)
    .maybeSingle()
    .overrideTypes<
      { id: string; workspace_id: string | null; is_system: boolean } | null,
      { merge: false }
    >();

  if (lookupErr) {
    console.error('[deal-stages/[id]] lookup falhou', lookupErr);
    return apiError('Falha a procurar stage', 500, 'LOOKUP_FAILED');
  }
  if (!existing) {
    return apiError('Stage não encontrado', 404, 'NOT_FOUND');
  }

  // 4) System check — stages de sistema não são editáveis
  if (existing.is_system || existing.workspace_id === null) {
    return apiError(
      'Stages de sistema não podem ser editados',
      403,
      'SYSTEM_STAGE'
    );
  }

  // 5) UPDATE
  const update: Record<string, unknown> = {};
  if (body.name !== undefined) update.name = body.name;
  if (body.position !== undefined) update.position = body.position;
  if (body.color !== undefined) update.color = body.color;
  if (body.is_won !== undefined) update.is_won = body.is_won;
  if (body.is_lost !== undefined) update.is_lost = body.is_lost;

  const { data: row, error: updErr } = await supabase
    .from('deal_stages')
    .update(update as never)
    .eq('id', stageId)
    .select(STAGE_SELECT)
    .single()
    .overrideTypes<DealStageRow | null, { merge: false }>();

  if (updErr || !row) {
    console.error('[deal-stages/[id]] update falhou', updErr);
    return apiError('Falha a actualizar stage', 500, 'DB_UPDATE_FAILED', {
      dbError: updErr?.message,
    });
  }

  return apiOk(row);
}

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

export async function DELETE(
  _request: NextRequest,
  context: { params: { id: string } }
) {
  // 0) Validar UUID
  const idParsed = z.string().uuid().safeParse(context.params.id);
  if (!idParsed.success) {
    return apiError('Stage id inválido', 400, 'INVALID_ID', {
      issues: idParsed.error.issues,
    });
  }
  const stageId = idParsed.data;

  // 1) Auth
  const supabase = createClient();
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    return apiError('Não autenticado', 401, 'UNAUTHENTICATED');
  }

  // 2) Lookup — sistema/RLS
  const { data: existing, error: lookupErr } = await supabase
    .from('deal_stages')
    .select('id, workspace_id, is_system')
    .eq('id', stageId)
    .maybeSingle()
    .overrideTypes<
      { id: string; workspace_id: string | null; is_system: boolean } | null,
      { merge: false }
    >();

  if (lookupErr) {
    console.error('[deal-stages/[id]] lookup falhou', lookupErr);
    return apiError('Falha a procurar stage', 500, 'LOOKUP_FAILED');
  }
  if (!existing) {
    return apiError('Stage não encontrado', 404, 'NOT_FOUND');
  }

  if (existing.is_system || existing.workspace_id === null) {
    return apiError(
      'Stages de sistema não podem ser apagados',
      403,
      'SYSTEM_STAGE'
    );
  }

  // 3) Pré-check de deals no stage — devolve 409 explícito antes do FK error.
  //    FK ON DELETE RESTRICT garante consistência mesmo em race conditions.
  const { count: dealsCount, error: countErr } = await supabase
    .from('deals')
    .select('id', { count: 'exact', head: true })
    .eq('stage_id', stageId);

  if (countErr) {
    console.error('[deal-stages/[id]] count deals falhou', countErr);
    return apiError('Falha a contar deals do stage', 500, 'DB_QUERY_FAILED');
  }
  if ((dealsCount ?? 0) > 0) {
    return apiError(
      'Stage tem deals associados — mover deals antes de apagar',
      409,
      'STAGE_HAS_DEALS',
      { dealCount: dealsCount }
    );
  }

  // 4) DELETE — apanha 23503 (FK violation) por defesa em profundidade.
  const { error: delErr } = await supabase
    .from('deal_stages')
    .delete()
    .eq('id', stageId);

  if (delErr) {
    // Postgres FK violation = SQLSTATE 23503. Mapeia para STAGE_HAS_DEALS.
    if ((delErr as { code?: string }).code === '23503') {
      return apiError(
        'Stage tem deals associados — mover deals antes de apagar',
        409,
        'STAGE_HAS_DEALS',
        { dbError: delErr.message }
      );
    }
    console.error('[deal-stages/[id]] delete falhou', delErr);
    return apiError('Falha a apagar stage', 500, 'DB_DELETE_FAILED', {
      dbError: delErr.message,
    });
  }

  return apiOk({ deleted: true, id: stageId });
}
