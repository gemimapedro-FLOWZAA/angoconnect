/**
 * AngoConnect — GET /api/companies/[id]/contacts
 * ===========================================================================
 * Lista contactos de uma company, com email/phone mascarado se NÃO estiver
 * revelado para o workspace.
 *
 * Query params:
 *   workspaceId  uuid               (obrigatório)
 *   page         int >= 1           (default 1)
 *   pageSize     int 10..100        (default 50)
 *
 * Resposta:
 *   {
 *     data: Contact[] (com is_revealed + reveal_cost),
 *     meta: { total, page, pageSize, totalPages, reveal_cost: 1 }
 *   }
 *
 * Regras de masking (lib/masking):
 *   - Contactos privados (workspace_id = ws) → sempre em claro.
 *   - Contactos públicos (workspace_id IS NULL):
 *       * Se em revealed_contacts → em claro, is_revealed=true.
 *       * Caso contrário → email/phone mascarados, is_revealed=false.
 *
 * Erros:
 *   UNAUTHENTICATED       401
 *   INVALID_QUERY         400
 *   INVALID_ID            400
 *   NOT_WORKSPACE_MEMBER  403
 *   NOT_FOUND             404 (company inexistente ou não visível)
 *   DB_QUERY_FAILED       500
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiError, apiOk } from '@/lib/api-response';
import { createClient } from '@/lib/supabase/server';
import {
  assertWorkspaceMembership,
  getRevealedContactIds,
  getVisibleCompany,
} from '@/lib/companies/queries';
import { applyContactMasking } from '@/lib/masking';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REVEAL_COST = 1;

interface ContactRow {
  id: string;
  company_id: string;
  workspace_id: string | null;
  full_name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
  confidence_score: number | null;
  email_verified: boolean;
  source: string | null;
  created_at: string;
}

const querySchema = z.object({
  workspaceId: z.string().uuid({ message: 'workspaceId tem de ser UUID' }),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(50),
});

export async function GET(
  request: NextRequest,
  context: { params: { id: string } }
) {
  // 0) Valida id
  const idParsed = z.string().uuid().safeParse(context.params.id);
  if (!idParsed.success) {
    return apiError('Company id inválido', 400, 'INVALID_ID', {
      issues: idParsed.error.issues,
    });
  }
  const companyId = idParsed.data;

  // 1) Parse query
  const sp = request.nextUrl.searchParams;
  const parsed = querySchema.safeParse({
    workspaceId: sp.get('workspaceId') ?? '',
    page: sp.get('page') ?? undefined,
    pageSize: sp.get('pageSize') ?? undefined,
  });
  if (!parsed.success) {
    return apiError('Query inválida', 400, 'INVALID_QUERY', {
      issues: parsed.error.issues,
    });
  }
  const q = parsed.data;

  // 2) Auth
  const supabase = createClient();
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    return apiError('Não autenticado', 401, 'UNAUTHENTICATED');
  }

  // 3) Membership
  const isMember = await assertWorkspaceMembership(
    supabase,
    q.workspaceId,
    user.id
  );
  if (!isMember) {
    return apiError(
      'Não é membro deste workspace',
      403,
      'NOT_WORKSPACE_MEMBER'
    );
  }

  // 4) Verifica que a company existe e é visível
  const company = await getVisibleCompany(supabase, companyId, q.workspaceId);
  if (!company) {
    return apiError('Company não encontrada', 404, 'NOT_FOUND');
  }

  // 5) Lista contactos visíveis (públicos OU do workspace) para esta company.
  const from = (q.page - 1) * q.pageSize;
  const to = from + q.pageSize - 1;

  const { data: contacts, count, error: contactsErr } = await supabase
    .from('contacts')
    .select(
      'id, company_id, workspace_id, full_name, title, email, phone, linkedin_url, confidence_score, email_verified, source, created_at',
      { count: 'exact' }
    )
    .eq('company_id', companyId)
    .or(`workspace_id.is.null,workspace_id.eq.${q.workspaceId}`)
    .order('full_name', { ascending: true })
    .range(from, to)
    .overrideTypes<ContactRow[], { merge: false }>();

  if (contactsErr) {
    console.error('[companies/contacts] query falhou', contactsErr);
    return apiError(
      'Falha a procurar contactos',
      500,
      'DB_QUERY_FAILED',
      { dbError: contactsErr.message }
    );
  }

  const rows: ContactRow[] = contacts ?? [];

  // 6) Lookup batch de revealed_contacts.
  //    Só precisamos verificar os IDs dos contactos públicos (privados do ws
  //    já estão visíveis).
  const publicIds = rows
    .filter((c) => c.workspace_id === null)
    .map((c) => c.id);
  const revealedSet = await getRevealedContactIds(
    supabase,
    q.workspaceId,
    publicIds
  );

  // 7) Aplica masking e devolve.
  const data = rows.map((c) => {
    const isPrivate = c.workspace_id === q.workspaceId;
    const isRevealed = isPrivate || revealedSet.has(c.id);

    const base = {
      id: c.id,
      company_id: c.company_id,
      full_name: c.full_name,
      title: c.title,
      email: c.email,
      phone: c.phone,
      linkedin_url: c.linkedin_url,
      confidence_score: c.confidence_score,
      email_verified: c.email_verified,
      source: c.source,
      created_at: c.created_at,
      is_in_catalog: c.workspace_id === null,
      reveal_cost: REVEAL_COST,
    };

    const masked = applyContactMasking(base, isRevealed);
    return masked;
  });

  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / q.pageSize));

  return apiOk(data, {
    total,
    page: q.page,
    pageSize: q.pageSize,
    totalPages,
    reveal_cost: REVEAL_COST,
  });
}
