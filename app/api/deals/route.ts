/**
 * AngoConnect — GET + POST /api/deals
 * ===========================================================================
 * CRM Deals (M3.3 — Kanban + Analytics).
 *
 * GET /api/deals
 *   Query:
 *     workspaceId  uuid                              (obrigatório)
 *     stageId?     uuid                              (filtra por stage)
 *     status?      'open' | 'won' | 'lost'
 *     ownerId?     uuid
 *     q?           string (search em contact name/notes via ilike)
 *     page         int >= 1                  (default 1)
 *     pageSize     int 10..200               (default 50)
 *     sort         'updated_at'|'created_at'|'value_akz'|'expected_close_date'
 *                                            (default 'updated_at')
 *     order        'asc'|'desc'              (default 'desc')
 *
 *   Resposta:
 *     {
 *       data: Deal[]   (com contact, company, owner aninhados),
 *       meta: { total, page, pageSize, totalPages }
 *     }
 *
 * POST /api/deals
 *   Body:
 *     { workspaceId, contactId, stageId?, valueAkz?, expectedCloseDate?,
 *       ownerId?, notes? }
 *   Defaults:
 *     - stageId = primeiro stage visível por position (privado primeiro,
 *       depois system "Novo")
 *     - ownerId = user.id
 *     - companyId = contact.company_id (derivado)
 *     - source = 'manual'
 *
 * Erros:
 *   UNAUTHENTICATED       401
 *   INVALID_QUERY/BODY    400
 *   INVALID_JSON          400
 *   NOT_WORKSPACE_MEMBER  403
 *   NOT_FOUND             404 (contact ou stage default não encontrado)
 *   DEAL_ALREADY_EXISTS   409 (UNIQUE workspace_id+contact_id, SQLSTATE 23505)
 *   DB_QUERY/INSERT       500
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiError, apiOk } from '@/lib/api-response';
import { createClient } from '@/lib/supabase/server';
import type { DealSource, DealStatus, Json } from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Shape canónico de deal (nested contact/company/owner) — vive em
// `lib/crm/shapes.ts` porque Next.js não permite exports não-handlers em route.ts
import { DEAL_SELECT, type DealNested } from '@/lib/crm/shapes';

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

const SORT_FIELDS = [
  'updated_at',
  'created_at',
  'value_akz',
  'expected_close_date',
] as const;

const listDealsSchema = z.object({
  workspaceId: z.string().uuid({ message: 'workspaceId tem de ser UUID' }),
  stageId: z.string().uuid().optional(),
  status: z.enum(['open', 'won', 'lost']).optional(),
  ownerId: z.string().uuid().optional(),
  q: z.string().trim().min(1).max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(200).default(50),
  sort: z.enum(SORT_FIELDS).default('updated_at'),
  order: z.enum(['asc', 'desc']).default('desc'),
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
  const sp = request.nextUrl.searchParams;
  const parsed = listDealsSchema.safeParse({
    workspaceId: sp.get('workspaceId') ?? undefined,
    stageId: sp.get('stageId') ?? undefined,
    status: sp.get('status') ?? undefined,
    ownerId: sp.get('ownerId') ?? undefined,
    q: sp.get('q') ?? undefined,
    page: sp.get('page') ?? undefined,
    pageSize: sp.get('pageSize') ?? undefined,
    sort: sp.get('sort') ?? undefined,
    order: sp.get('order') ?? undefined,
  });
  if (!parsed.success) {
    return apiError('Query inválida — ver issues', 400, 'INVALID_QUERY', {
      issues: parsed.error.issues,
    });
  }
  const q = parsed.data;

  // 3) Membership
  const { data: member, error: memberErr } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('workspace_id', q.workspaceId)
    .eq('user_id', user.id)
    .maybeSingle()
    .overrideTypes<{ workspace_id: string } | null, { merge: false }>();

  if (memberErr) {
    console.error('[deals] erro a verificar workspace_members', memberErr);
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

  // 4) Build query com nested select
  let query = supabase
    .from('deals')
    .select(DEAL_SELECT, { count: 'exact' })
    .eq('workspace_id', q.workspaceId);

  if (q.stageId) query = query.eq('stage_id', q.stageId);
  if (q.status) query = query.eq('status', q.status);
  if (q.ownerId) query = query.eq('owner_id', q.ownerId);

  if (q.q) {
    // Search em notes (campo do próprio deal) — search em contact.full_name
    // teria de ser via RPC ou view; por agora limitamos a notes para manter
    // a query simples e indexável.
    query = query.ilike('notes', `%${q.q}%`);
  }

  query = query.order(q.sort, { ascending: q.order === 'asc' });

  const from = (q.page - 1) * q.pageSize;
  const to = from + q.pageSize - 1;
  query = query.range(from, to);

  const { data, count, error } = await query.overrideTypes<
    DealNested[],
    { merge: false }
  >();

  if (error) {
    console.error('[deals] list falhou', error);
    return apiError('Falha a listar deals', 500, 'DB_QUERY_FAILED', {
      dbError: error.message,
    });
  }

  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / q.pageSize));

  return apiOk(data ?? [], {
    total,
    page: q.page,
    pageSize: q.pageSize,
    totalPages,
  });
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

const createDealSchema = z.object({
  workspaceId: z.string().uuid({ message: 'workspaceId tem de ser UUID' }),
  contactId: z.string().uuid({ message: 'contactId tem de ser UUID' }),
  stageId: z.string().uuid().optional(),
  valueAkz: z.number().nonnegative().max(1e15).optional(),
  expectedCloseDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'expectedCloseDate tem de ser YYYY-MM-DD')
    .optional(),
  ownerId: z.string().uuid().optional(),
  notes: z.string().trim().max(10_000).optional(),
});

type CreateDealBody = z.infer<typeof createDealSchema>;

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

  const parsed = createDealSchema.safeParse(rawBody);
  if (!parsed.success) {
    return apiError('Body inválido — ver issues', 400, 'INVALID_BODY', {
      issues: parsed.error.issues,
    });
  }
  const body: CreateDealBody = parsed.data;

  // 3) Membership
  const { data: member, error: memberErr } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('workspace_id', body.workspaceId)
    .eq('user_id', user.id)
    .maybeSingle()
    .overrideTypes<{ workspace_id: string } | null, { merge: false }>();

  if (memberErr) {
    console.error('[deals] erro a verificar workspace_members', memberErr);
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

  // 4) Lookup contact → deriva company_id (e valida que existe)
  const { data: contactRow, error: contactErr } = await supabase
    .from('contacts')
    .select('id, company_id')
    .eq('id', body.contactId)
    .maybeSingle()
    .overrideTypes<{ id: string; company_id: string } | null, { merge: false }>();

  if (contactErr) {
    console.error('[deals] contact lookup falhou', contactErr);
    return apiError('Falha a procurar contacto', 500, 'LOOKUP_FAILED');
  }
  if (!contactRow) {
    return apiError('Contacto não encontrado', 404, 'NOT_FOUND', {
      entity: 'contact',
    });
  }

  // 5) Default stageId — primeiro stage visível por (workspace_id privado, position)
  let stageId = body.stageId;
  if (!stageId) {
    const { data: stageRow, error: stageErr } = await supabase
      .from('deal_stages')
      .select('id')
      .or(`workspace_id.is.null,workspace_id.eq.${body.workspaceId}`)
      .order('workspace_id', { ascending: true, nullsFirst: false })
      .order('position', { ascending: true })
      .limit(1)
      .maybeSingle()
      .overrideTypes<{ id: string } | null, { merge: false }>();

    if (stageErr) {
      console.error('[deals] default stage lookup falhou', stageErr);
      return apiError(
        'Falha a procurar stage default',
        500,
        'DB_QUERY_FAILED'
      );
    }
    if (!stageRow) {
      return apiError(
        'Nenhum stage disponível — seeds em falta',
        404,
        'NOT_FOUND',
        { entity: 'stage' }
      );
    }
    stageId = stageRow.id;
  }

  // 6) INSERT — mapeia 23505 (UNIQUE workspace_id+contact_id) para 409.
  const { data: row, error: insertErr } = await supabase
    .from('deals')
    .insert({
      workspace_id: body.workspaceId,
      stage_id: stageId,
      contact_id: body.contactId,
      company_id: contactRow.company_id ?? null,
      owner_id: body.ownerId ?? user.id,
      value_akz: body.valueAkz ?? null,
      expected_close_date: body.expectedCloseDate ?? null,
      status: 'open',
      source: 'manual',
      notes: body.notes ?? null,
    } as never)
    .select(DEAL_SELECT)
    .single()
    .overrideTypes<DealNested | null, { merge: false }>();

  if (insertErr || !row) {
    if ((insertErr as { code?: string } | null)?.code === '23505') {
      return apiError(
        'Já existe um deal para este contacto neste workspace',
        409,
        'DEAL_ALREADY_EXISTS',
        { dbError: insertErr?.message }
      );
    }
    console.error('[deals] insert falhou', insertErr);
    // Json default para evitar warning sobre type
    const meta: Json = { dbError: insertErr?.message ?? null };
    return apiError('Falha a criar deal', 500, 'DB_INSERT_FAILED', {
      dbError: meta,
    });
  }

  return apiOk(row);
}
