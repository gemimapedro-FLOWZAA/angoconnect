/**
 * AngoConnect — PATCH + DELETE /api/deals/[id]
 * ===========================================================================
 * Actualiza ou apaga um deal do CRM (M3.3).
 *
 * PATCH /api/deals/:id
 *   Body parcial: { stageId?, valueAkz?, expectedCloseDate?, ownerId?,
 *                   status?, notes? }
 *   Se `stageId` muda, chama RPC `move_deal_to_stage` (aplica lógica
 *   automática de status: stage.is_won → status='won', stage.is_lost →
 *   status='lost'). Outras mudanças = UPDATE directo.
 *
 *   Quando stageId E outros campos são alterados na mesma chamada:
 *     1º RPC para mover stage (e aplicar status auto)
 *     2º UPDATE para os restantes campos
 *   Se o body também especifica `status`, o status do body sobrepõe-se ao
 *   automático (intenção explícita do utilizador).
 *
 * DELETE /api/deals/:id
 *   Hard delete (não preserva histórico — deals são entidades mutáveis,
 *   ao contrário de credits_log).
 *
 * Erros:
 *   UNAUTHENTICATED       401
 *   INVALID_ID/BODY/JSON  400
 *   NOT_FOUND             404
 *   RPC_FAILED            500 (move_deal_to_stage devolveu erro)
 *   DB_UPDATE/DELETE      500
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiError, apiOk } from '@/lib/api-response';
import { type DealNested, DEAL_SELECT } from '@/lib/crm/shapes';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// GET — deal + history de email_events (M3.4)
// ---------------------------------------------------------------------------

interface DealHistoryEvent {
  id: string;
  type: string;
  timestamp: string;
  enrollment_id: string | null;
  sequence_name: string | null;
  metadata: unknown;
}

interface EnrolmentWithSequence {
  id: string;
  contact_id: string;
  sequence: { id: string; name: string } | null;
}

interface EmailEventRow {
  id: string;
  event_type: string;
  occurred_at: string;
  enrollment_id: string;
  metadata: unknown;
}

export async function GET(
  _request: NextRequest,
  context: { params: { id: string } }
) {
  const dealId = context.params.id;
  if (!/^[0-9a-f-]{36}$/i.test(dealId)) {
    return apiError('ID inválido', 400, 'INVALID_ID');
  }

  const supabase = createClient();
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    return apiError('Não autenticado', 401, 'UNAUTHENTICATED');
  }

  const { data: deal, error: dealErr } = await supabase
    .from('deals')
    .select(DEAL_SELECT)
    .eq('id', dealId)
    .maybeSingle()
    .overrideTypes<DealNested | null, { merge: false }>();

  if (dealErr) {
    console.error('[deals GET]', dealErr);
    return apiError('Falha a obter deal', 500, 'DB_QUERY_FAILED');
  }
  if (!deal) {
    return apiError('Deal não encontrado', 404, 'NOT_FOUND');
  }

  // history: email_events ligados aos enrolments do contact do deal
  const contactId = deal.contact?.id ?? null;
  let history: DealHistoryEvent[] = [];
  if (contactId) {
    const { data: enrolments, error: enrErr } = await supabase
      .from('sequence_enrollments')
      .select('id, contact_id, sequence:sequences(id, name)')
      .eq('contact_id', contactId)
      .overrideTypes<EnrolmentWithSequence[], { merge: false }>();

    if (enrErr) {
      console.warn('[deals GET] enrolments lookup falhou', enrErr.message);
    }

    const enrolMap = new Map<string, { id: string; name: string } | null>();
    for (const e of enrolments ?? []) {
      enrolMap.set(e.id, e.sequence);
    }
    const enrolIds = [...enrolMap.keys()];

    if (enrolIds.length > 0) {
      const { data: events, error: evErr } = await supabase
        .from('email_events')
        .select('id, event_type, occurred_at, enrollment_id, metadata')
        .in('enrollment_id', enrolIds)
        .order('occurred_at', { ascending: false })
        .limit(50)
        .overrideTypes<EmailEventRow[], { merge: false }>();

      if (evErr) {
        console.warn('[deals GET] events lookup falhou', evErr.message);
      } else {
        history = (events ?? []).map((e) => ({
          id: e.id,
          type: e.event_type,
          timestamp: e.occurred_at,
          enrollment_id: e.enrollment_id,
          sequence_name: enrolMap.get(e.enrollment_id)?.name ?? null,
          metadata: e.metadata,
        }));
      }
    }
  }

  return apiOk({ deal, history });
}

// ---------------------------------------------------------------------------
// PATCH
// ---------------------------------------------------------------------------

const patchDealSchema = z
  .object({
    stageId: z.string().uuid().optional(),
    valueAkz: z.number().nonnegative().max(1e15).nullable().optional(),
    expectedCloseDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'expectedCloseDate tem de ser YYYY-MM-DD')
      .nullable()
      .optional(),
    ownerId: z.string().uuid().nullable().optional(),
    status: z.enum(['open', 'won', 'lost']).optional(),
    notes: z.string().trim().max(10_000).nullable().optional(),
  })
  .refine(
    (b) =>
      b.stageId !== undefined ||
      b.valueAkz !== undefined ||
      b.expectedCloseDate !== undefined ||
      b.ownerId !== undefined ||
      b.status !== undefined ||
      b.notes !== undefined,
    {
      message:
        'Body deve conter pelo menos um campo (stageId/valueAkz/expectedCloseDate/ownerId/status/notes)',
    }
  );

type PatchDealBody = z.infer<typeof patchDealSchema>;

export async function PATCH(
  request: NextRequest,
  context: { params: { id: string } }
) {
  // 0) Validar UUID
  const idParsed = z.string().uuid().safeParse(context.params.id);
  if (!idParsed.success) {
    return apiError('Deal id inválido', 400, 'INVALID_ID', {
      issues: idParsed.error.issues,
    });
  }
  const dealId = idParsed.data;

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

  const parsed = patchDealSchema.safeParse(rawBody);
  if (!parsed.success) {
    return apiError('Body inválido — ver issues', 400, 'INVALID_BODY', {
      issues: parsed.error.issues,
    });
  }
  const body: PatchDealBody = parsed.data;

  // 3) Lookup — 404 se RLS esconder
  const { data: existing, error: lookupErr } = await supabase
    .from('deals')
    .select('id, workspace_id, stage_id')
    .eq('id', dealId)
    .maybeSingle()
    .overrideTypes<
      { id: string; workspace_id: string; stage_id: string } | null,
      { merge: false }
    >();

  if (lookupErr) {
    console.error('[deals/[id]] lookup falhou', lookupErr);
    return apiError('Falha a procurar deal', 500, 'LOOKUP_FAILED');
  }
  if (!existing) {
    return apiError('Deal não encontrado', 404, 'NOT_FOUND');
  }

  // 4) Se stageId muda → RPC `move_deal_to_stage` (aplica status auto)
  if (body.stageId !== undefined && body.stageId !== existing.stage_id) {
    const { error: rpcErr } = await supabase.rpc(
      'move_deal_to_stage',
      {
        p_deal_id: dealId,
        p_stage_id: body.stageId,
      } as never
    );

    if (rpcErr) {
      console.error('[deals/[id]] move_deal_to_stage falhou', rpcErr);
      return apiError(
        'Falha a mover deal para o stage',
        500,
        'RPC_FAILED',
        { dbError: rpcErr.message }
      );
    }
  }

  // 5) UPDATE para campos restantes (incluindo status se body o especificou).
  //    `status` do body sobrepõe-se ao automático do RPC.
  const update: Record<string, unknown> = {};
  if (body.valueAkz !== undefined) update.value_akz = body.valueAkz;
  if (body.expectedCloseDate !== undefined)
    update.expected_close_date = body.expectedCloseDate;
  if (body.ownerId !== undefined) update.owner_id = body.ownerId;
  if (body.status !== undefined) update.status = body.status;
  if (body.notes !== undefined) update.notes = body.notes;

  const needsDirectUpdate = Object.keys(update).length > 0;

  if (needsDirectUpdate) {
    update.updated_at = new Date().toISOString();
    const { error: updErr } = await supabase
      .from('deals')
      .update(update as never)
      .eq('id', dealId);

    if (updErr) {
      console.error('[deals/[id]] update falhou', updErr);
      return apiError('Falha a actualizar deal', 500, 'DB_UPDATE_FAILED', {
        dbError: updErr.message,
      });
    }
  }

  // 6) Re-fetch row final com nested select para devolver shape consistente.
  const { data: row, error: refetchErr } = await supabase
    .from('deals')
    .select(DEAL_SELECT)
    .eq('id', dealId)
    .single()
    .overrideTypes<DealNested | null, { merge: false }>();

  if (refetchErr || !row) {
    console.error('[deals/[id]] refetch falhou', refetchErr);
    return apiError('Falha a obter deal actualizado', 500, 'DB_QUERY_FAILED', {
      dbError: refetchErr?.message,
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
    return apiError('Deal id inválido', 400, 'INVALID_ID', {
      issues: idParsed.error.issues,
    });
  }
  const dealId = idParsed.data;

  // 1) Auth
  const supabase = createClient();
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    return apiError('Não autenticado', 401, 'UNAUTHENTICATED');
  }

  // 2) Lookup — devolve 404 distinto de 403/RLS
  const { data: existing, error: lookupErr } = await supabase
    .from('deals')
    .select('id')
    .eq('id', dealId)
    .maybeSingle()
    .overrideTypes<{ id: string } | null, { merge: false }>();

  if (lookupErr) {
    console.error('[deals/[id]] lookup falhou', lookupErr);
    return apiError('Falha a procurar deal', 500, 'LOOKUP_FAILED');
  }
  if (!existing) {
    return apiError('Deal não encontrado', 404, 'NOT_FOUND');
  }

  // 3) DELETE (RLS confirma membership)
  const { error: delErr } = await supabase
    .from('deals')
    .delete()
    .eq('id', dealId);

  if (delErr) {
    console.error('[deals/[id]] delete falhou', delErr);
    return apiError('Falha a apagar deal', 500, 'DB_DELETE_FAILED', {
      dbError: delErr.message,
    });
  }

  return apiOk({ deleted: true, id: dealId });
}
