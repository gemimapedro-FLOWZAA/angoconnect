/**
 * AngoConnect — PATCH /api/sequences/[id]
 * ===========================================================================
 * Actualiza uma sequence existente.
 *
 * Regras:
 *   - Se sequence está `draft` → qualquer campo permitido.
 *   - Se sequence está `active`:
 *      - Pode alterar `name` ou `status` para 'paused'.
 *      - NÃO pode alterar `steps` se já houver enrolments (devolve 409
 *        `sequence_locked`). Justificação: avançar steps depois de enrolments
 *        criados quebraria a continuidade (current_step deixaria de
 *        corresponder ao step pretendido).
 *   - Se `paused` ou `archived` → permite re-activar ou voltar a draft.
 *
 * Body parcial (qualquer combinação válida):
 *   { name?, status?, steps? }
 *
 * Erros:
 *   UNAUTHENTICATED       401
 *   INVALID_*             400
 *   NOT_FOUND             404
 *   NOT_WORKSPACE_MEMBER  403
 *   SEQUENCE_LOCKED       409
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiError, apiOk } from '@/lib/api-response';
import { sequenceStepSchema } from '@/lib/sequences/schemas';
import { createClient } from '@/lib/supabase/server';
import type { Json, SequenceStatus } from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Zod
// ---------------------------------------------------------------------------

const patchSequenceSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    status: z.enum(['draft', 'active', 'paused', 'archived']).optional(),
    steps: z.array(sequenceStepSchema).min(1).max(20).optional(),
  })
  .refine(
    (b) => b.name !== undefined || b.status !== undefined || b.steps !== undefined,
    { message: 'Body deve conter pelo menos um campo (name/status/steps)' }
  );

type PatchBody = z.infer<typeof patchSequenceSchema>;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function PATCH(
  request: NextRequest,
  context: { params: { id: string } }
) {
  // 0) Validar UUID na URL
  const idSchema = z.string().uuid({ message: 'id tem de ser UUID' });
  const idParsed = idSchema.safeParse(context.params.id);
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

  // 2) Body Zod
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return apiError('Body não é JSON válido', 400, 'INVALID_JSON');
  }

  const parsed = patchSequenceSchema.safeParse(rawBody);
  if (!parsed.success) {
    return apiError('Body inválido — ver issues', 400, 'INVALID_BODY', {
      issues: parsed.error.issues,
    });
  }
  const body: PatchBody = parsed.data;

  // 3) Lookup sequence + membership (RLS faz a parte de membership, mas
  // queremos um 404 distinto de 403).
  const { data: existing, error: lookupErr } = await supabase
    .from('sequences')
    .select('id, workspace_id, status')
    .eq('id', sequenceId)
    .maybeSingle()
    .overrideTypes<
      { id: string; workspace_id: string; status: SequenceStatus } | null,
      { merge: false }
    >();

  if (lookupErr) {
    console.error('[sequences/[id]] lookup falhou', lookupErr);
    return apiError(
      'Falha a procurar sequence',
      500,
      'LOOKUP_FAILED'
    );
  }
  if (!existing) {
    // Pode ser não existir OU RLS a esconder — devolvemos 404 sempre.
    return apiError('Sequence não encontrada', 404, 'NOT_FOUND');
  }

  const currentStatus: SequenceStatus = existing.status;

  // 4) Bloqueio para steps em sequences active
  if (body.steps !== undefined && currentStatus === 'active') {
    // Verifica se já há enrolments — se houver, bloqueia.
    const { count, error: countErr } = await supabase
      .from('sequence_enrollments')
      .select('id', { count: 'exact', head: true })
      .eq('sequence_id', sequenceId);

    if (countErr) {
      console.error('[sequences/[id]] count enrolments falhou', countErr);
      return apiError(
        'Falha a verificar enrolments',
        500,
        'ENROLMENT_COUNT_FAILED'
      );
    }

    if ((count ?? 0) > 0) {
      return apiError(
        'Não é possível alterar steps de uma sequence active com enrolments',
        409,
        'SEQUENCE_LOCKED',
        { enrolmentCount: count }
      );
    }
  }

  // 5) UPDATE
  const update: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (body.name !== undefined) update.name = body.name;
  if (body.status !== undefined) update.status = body.status;
  if (body.steps !== undefined) update.steps = body.steps as unknown as Json;

  const { data: row, error: updErr } = await supabase
    .from('sequences')
    .update(update as never)
    .eq('id', sequenceId)
    .select(
      'id, workspace_id, name, status, steps, created_by, created_at, updated_at'
    )
    .single();

  if (updErr || !row) {
    console.error('[sequences/[id]] update falhou', updErr);
    return apiError(
      'Falha a actualizar sequence',
      500,
      'DB_UPDATE_FAILED',
      { dbError: updErr?.message }
    );
  }

  return apiOk(row);
}
