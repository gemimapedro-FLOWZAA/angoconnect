/**
 * AngoConnect — GET /api/companies/[id]
 * ===========================================================================
 * Detalhe de uma company. Retorna campos completos + contagens.
 *
 * Query params:
 *   workspaceId  uuid  (obrigatório — para contexto de "revealed" e ws privado)
 *
 * Resposta:
 *   {
 *     data: {
 *       company: { id, name, nif, sector, provincia, size, website,
 *                  source, description, logo_url, source_url, created_at },
 *       contacts_count: number,
 *       revealed_count: number,
 *       is_in_catalog: boolean
 *     }
 *   }
 *
 * Erros:
 *   UNAUTHENTICATED       401
 *   INVALID_QUERY         400
 *   INVALID_ID            400
 *   NOT_WORKSPACE_MEMBER  403
 *   NOT_FOUND             404
 *   DB_QUERY_FAILED       500
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiError, apiOk } from '@/lib/api-response';
import { createClient } from '@/lib/supabase/server';
import { assertWorkspaceMembership } from '@/lib/companies/queries';
import type {
  AngolaProvincia,
  CompanySector,
  CompanySize,
  CompanySource,
} from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CompanyDetailRow {
  id: string;
  workspace_id: string | null;
  name: string;
  nif: string | null;
  sector: CompanySector | null;
  provincia: AngolaProvincia | null;
  size: CompanySize | null;
  website: string | null;
  description: string | null;
  logo_url: string | null;
  source: CompanySource | null;
  source_url: string | null;
  created_at: string;
  updated_at: string;
}

export async function GET(
  request: NextRequest,
  context: { params: { id: string } }
) {
  // 0) Valida id na URL
  const idParsed = z.string().uuid().safeParse(context.params.id);
  if (!idParsed.success) {
    return apiError('Company id inválido', 400, 'INVALID_ID', {
      issues: idParsed.error.issues,
    });
  }
  const companyId = idParsed.data;

  // 1) workspaceId
  const wsParsed = z
    .string()
    .uuid()
    .safeParse(request.nextUrl.searchParams.get('workspaceId') ?? '');
  if (!wsParsed.success) {
    return apiError(
      'workspaceId em falta ou inválido',
      400,
      'INVALID_QUERY',
      { issues: wsParsed.error.issues }
    );
  }
  const workspaceId = wsParsed.data;

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
    workspaceId,
    user.id
  );
  if (!isMember) {
    return apiError(
      'Não é membro deste workspace',
      403,
      'NOT_WORKSPACE_MEMBER'
    );
  }

  // 4) Lookup company. RLS impede leitura de companies privadas de outro ws.
  const { data: company, error: companyErr } = await supabase
    .from('companies')
    .select(
      'id, workspace_id, name, nif, sector, provincia, size, website, description, logo_url, source, source_url, created_at, updated_at'
    )
    .eq('id', companyId)
    .maybeSingle()
    .overrideTypes<CompanyDetailRow | null, { merge: false }>();

  if (companyErr) {
    console.error('[companies/[id]] lookup falhou', companyErr);
    return apiError(
      'Falha a procurar company',
      500,
      'DB_QUERY_FAILED',
      { dbError: companyErr.message }
    );
  }
  if (!company) {
    return apiError('Company não encontrada', 404, 'NOT_FOUND');
  }

  // Visibilidade extra (defesa: pode ser privada de outro ws mas RLS é
  // tolerante a service-role; aqui é supabase tipado com auth do user).
  const isPublic = company.workspace_id === null;
  const isOwned = company.workspace_id === workspaceId;
  if (!isPublic && !isOwned) {
    return apiError('Company não encontrada', 404, 'NOT_FOUND');
  }

  // 5) Counts:
  //    - contacts_count: total de contactos visíveis ao workspace para esta
  //                      company (públicos OU privados do ws).
  //    - revealed_count: total de contactos desta company que já foram
  //                      revelados pelo workspace.
  const { count: contactsCount, error: countErr } = await supabase
    .from('contacts')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .or(`workspace_id.is.null,workspace_id.eq.${workspaceId}`);

  if (countErr) {
    console.error('[companies/[id]] contacts count falhou', countErr);
  }

  // revealed_count: JOIN entre revealed_contacts e contacts (por company_id).
  // Estratégia: vai buscar revealed_contacts do ws cujo contact_id pertence
  // a esta company. Usa-se um inner-join via FK virtual select.
  let revealedCount = 0;
  const { data: revealedRows, error: revealedErr } = await supabase
    .from('contacts')
    .select('id, revealed_contacts!inner(workspace_id)')
    .eq('company_id', companyId)
    .eq('revealed_contacts.workspace_id', workspaceId)
    .overrideTypes<
      Array<{ id: string }>,
      { merge: false }
    >();

  if (revealedErr) {
    // PostgREST pode não conseguir resolver a junção se a FK não for
    // explicitamente declarada. Fallback: 2 queries.
    const { data: revealedIds } = await supabase
      .from('revealed_contacts')
      .select('contact_id')
      .eq('workspace_id', workspaceId)
      .overrideTypes<Array<{ contact_id: string }>, { merge: false }>();

    if (revealedIds && revealedIds.length > 0) {
      const ids = revealedIds.map((r) => r.contact_id);
      const { count: rc } = await supabase
        .from('contacts')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .in('id', ids);
      revealedCount = rc ?? 0;
    }
  } else {
    revealedCount = revealedRows?.length ?? 0;
  }

  return apiOk({
    company: {
      id: company.id,
      name: company.name,
      nif: company.nif,
      sector: company.sector,
      provincia: company.provincia,
      size: company.size,
      website: company.website,
      description: company.description,
      logo_url: company.logo_url,
      source: company.source,
      source_url: company.source_url,
      created_at: company.created_at,
    },
    contacts_count: contactsCount ?? 0,
    revealed_count: revealedCount,
    is_in_catalog: isPublic,
  });
}
