/**
 * AngoConnect — GET /api/companies
 * ===========================================================================
 * Endpoint de Search & Discovery: lista companies visíveis ao workspace com
 * filtros + paginação + ordenação.
 *
 * Query params:
 *   workspaceId   uuid                                    (obrigatório)
 *   scope         'public'|'private'|'all'  (default all)
 *   sector        string[] (oil_gas, banking, ...)        (opcional, multi)
 *   provincia     string[] (Luanda, Benguela, ...)        (opcional, multi)
 *   size          string[] (micro, small, ...)            (opcional, multi)
 *   source        string[] (irgc, linkedin, ...)          (opcional, multi)
 *   q             string                                  (search ilike no name)
 *   hasContacts   boolean                                  (apenas com contactos)
 *   page          int >= 1                  (default 1)
 *   pageSize      int 10..100               (default 50)
 *   sort          'name'|'created_at'|'contacts_count' (default name)
 *   order         'asc'|'desc'              (default asc)
 *
 * Modelo de visibilidade:
 *   - scope=public  → apenas workspace_id IS NULL
 *   - scope=private → apenas workspace_id = ${workspaceId}
 *   - scope=all     → ambos (public OR private deste workspace)
 *
 * Resposta:
 *   {
 *     data: Company[]   (cada uma com contacts_count),
 *     meta: { total, page, pageSize, totalPages }
 *   }
 *
 * Erros:
 *   UNAUTHENTICATED       401
 *   INVALID_QUERY         400
 *   NOT_WORKSPACE_MEMBER  403
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

// ---------------------------------------------------------------------------
// Zod — query params (vindos de NextRequest.nextUrl.searchParams)
// ---------------------------------------------------------------------------

const SECTOR_VALUES: readonly CompanySector[] = [
  'oil_gas',
  'banking',
  'telecom',
  'construction',
  'retail',
  'agro',
  'healthcare',
  'education',
  'logistics',
  'tech',
  'government',
  'other',
];

const SIZE_VALUES: readonly CompanySize[] = [
  'micro',
  'small',
  'medium',
  'large',
  'enterprise',
];

const SOURCE_VALUES: readonly CompanySource[] = [
  'irgc',
  'linkedin',
  'bue',
  'news',
  'manual',
  'email_enricher',
];

const PROVINCIA_VALUES: readonly AngolaProvincia[] = [
  'Bengo',
  'Benguela',
  'Bié',
  'Cabinda',
  'Cuando Cubango',
  'Cuanza Norte',
  'Cuanza Sul',
  'Cunene',
  'Huambo',
  'Huíla',
  'Luanda',
  'Lunda Norte',
  'Lunda Sul',
  'Malanje',
  'Moxico',
  'Namibe',
  'Uíge',
  'Zaire',
];

const querySchema = z.object({
  workspaceId: z.string().uuid({ message: 'workspaceId tem de ser UUID' }),
  scope: z.enum(['public', 'private', 'all']).default('all'),
  sector: z
    .array(z.enum(SECTOR_VALUES as unknown as [CompanySector, ...CompanySector[]]))
    .optional(),
  provincia: z
    .array(
      z.enum(
        PROVINCIA_VALUES as unknown as [AngolaProvincia, ...AngolaProvincia[]]
      )
    )
    .optional(),
  size: z
    .array(z.enum(SIZE_VALUES as unknown as [CompanySize, ...CompanySize[]]))
    .optional(),
  source: z
    .array(
      z.enum(SOURCE_VALUES as unknown as [CompanySource, ...CompanySource[]])
    )
    .optional(),
  q: z.string().trim().min(1).max(120).optional(),
  hasContacts: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(50),
  sort: z.enum(['name', 'created_at', 'contacts_count']).default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
});

type ParsedQuery = z.infer<typeof querySchema>;

// ---------------------------------------------------------------------------
// Tipos de retorno
// ---------------------------------------------------------------------------

interface CompanyListRow {
  id: string;
  workspace_id: string | null;
  name: string;
  nif: string | null;
  sector: CompanySector | null;
  provincia: AngolaProvincia | null;
  size: CompanySize | null;
  website: string | null;
  source: CompanySource | null;
  created_at: string;
}

interface CompanyListItem extends CompanyListRow {
  contacts_count: number;
  is_in_catalog: boolean;
}

// ---------------------------------------------------------------------------
// Helper: extrai params multi-valor de URLSearchParams (?sector=a&sector=b)
// ---------------------------------------------------------------------------

function multiParam(params: URLSearchParams, key: string): string[] | undefined {
  const all = params.getAll(key);
  return all.length > 0 ? all : undefined;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

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

  // 2) Parse query
  const sp = request.nextUrl.searchParams;
  const rawQuery = {
    workspaceId: sp.get('workspaceId') ?? '',
    scope: sp.get('scope') ?? undefined,
    sector: multiParam(sp, 'sector'),
    provincia: multiParam(sp, 'provincia'),
    size: multiParam(sp, 'size'),
    source: multiParam(sp, 'source'),
    q: sp.get('q') ?? undefined,
    hasContacts: sp.get('hasContacts') ?? undefined,
    page: sp.get('page') ?? undefined,
    pageSize: sp.get('pageSize') ?? undefined,
    sort: sp.get('sort') ?? undefined,
    order: sp.get('order') ?? undefined,
  };

  const parsed = querySchema.safeParse(rawQuery);
  if (!parsed.success) {
    return apiError('Query inválida — ver issues', 400, 'INVALID_QUERY', {
      issues: parsed.error.issues,
    });
  }
  const q: ParsedQuery = parsed.data;

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

  // 4) Build base query.
  //    Estratégia: 1ª query traz companies + filtros + paginação + count
  //    exacto. 2ª query agrega contacts_count por id num único in() — evita
  //    N+1 e o pitfall do PostgREST com count agregado em joins quando se
  //    precisa de filtrar/sortear por essa contagem (ver decisões abaixo).
  //
  //    DECISÃO: o sort por contacts_count e o filtro hasContacts implicam
  //    fazer a agregação ANTES da paginação. Quando esses estão presentes,
  //    o caminho muda: pré-buscamos a agregação completa, ordenamos em SQL
  //    via uma view inline, e usamos isso para paginar.
  //    Para manter a complexidade contida, usamos uma estratégia simples
  //    em duas fases:
  //      a) Se sort != 'contacts_count' AND hasContacts === undefined:
  //         paginar a query principal por (sort, order) e depois agregar
  //         contacts_count em batch.
  //      b) Caso contrário: SELECT id, ws_id, count(contacts) FROM companies
  //         JOIN contacts ... (via groupBy seria ideal mas o PostgREST não
  //         devolve count "wide"). Workaround: usar RPC dedicada seria
  //         ideal; por agora fazemos a agregação em memória com cap.

  const baseSelect =
    'id, workspace_id, name, nif, sector, provincia, size, website, source, created_at';

  // Scope filter
  let scopeFilter: 'public' | 'private' | 'all' = q.scope;
  let queryBuilder = supabase
    .from('companies')
    .select(baseSelect, { count: 'exact' });

  if (scopeFilter === 'public') {
    queryBuilder = queryBuilder.is('workspace_id', null);
  } else if (scopeFilter === 'private') {
    queryBuilder = queryBuilder.eq('workspace_id', q.workspaceId);
  } else {
    // scope=all → public OR private deste ws
    queryBuilder = queryBuilder.or(
      `workspace_id.is.null,workspace_id.eq.${q.workspaceId}`
    );
  }

  if (q.sector && q.sector.length > 0) {
    queryBuilder = queryBuilder.in('sector', q.sector);
  }
  if (q.provincia && q.provincia.length > 0) {
    queryBuilder = queryBuilder.in('provincia', q.provincia);
  }
  if (q.size && q.size.length > 0) {
    queryBuilder = queryBuilder.in('size', q.size);
  }
  if (q.source && q.source.length > 0) {
    queryBuilder = queryBuilder.in('source', q.source);
  }
  if (q.q) {
    // ilike — o índice GIN trigram (idx_companies_name_trgm) acelera.
    queryBuilder = queryBuilder.ilike('name', `%${q.q}%`);
  }

  // Sort — quando é contacts_count, ordenamos depois da agregação em memória.
  // Para outros campos, ordenamos no SQL.
  const sortInSql = q.sort !== 'contacts_count';
  if (sortInSql) {
    queryBuilder = queryBuilder.order(q.sort, { ascending: q.order === 'asc' });
  }

  // Paginação — quando é sort=contacts_count OR hasContacts, NÃO paginamos
  // aqui (precisamos da lista completa para ordenar/filtrar por count).
  // Em troca aplicamos hard limit de segurança e devolvemos meta com
  // total = lista após filtro.
  const paginatedInSql = sortInSql && q.hasContacts === undefined;
  if (paginatedInSql) {
    const from = (q.page - 1) * q.pageSize;
    const to = from + q.pageSize - 1;
    queryBuilder = queryBuilder.range(from, to);
  } else {
    // Hard cap de segurança: 2000 rows quando precisa de agregar tudo.
    queryBuilder = queryBuilder.range(0, 1999);
  }

  const { data: rows, count, error: queryErr } = await queryBuilder
    .overrideTypes<CompanyListRow[], { merge: false }>();

  if (queryErr) {
    console.error('[companies] query falhou', queryErr);
    return apiError(
      'Falha a procurar companies',
      500,
      'DB_QUERY_FAILED',
      { dbError: queryErr.message }
    );
  }

  const baseRows: CompanyListRow[] = rows ?? [];

  // 5) Agrega contacts_count para os ids retornados.
  //    Workaround pelo PostgREST: SELECT company_id, count(*) em GROUP BY
  //    não é trivialmente expressável. Em vez disso fazemos:
  //      a) SELECT id de contacts WHERE company_id IN (...) AND visibilidade.
  //      b) Tally em memória.
  let countsByCompany = new Map<string, number>();
  if (baseRows.length > 0) {
    const companyIds = baseRows.map((r) => r.id);
    // Contactos visíveis: workspace_id IS NULL OU == workspaceId.
    const { data: contactRows, error: contactsErr } = await supabase
      .from('contacts')
      .select('company_id, workspace_id')
      .in('company_id', companyIds)
      .or(`workspace_id.is.null,workspace_id.eq.${q.workspaceId}`)
      .overrideTypes<
        Array<{ company_id: string; workspace_id: string | null }>,
        { merge: false }
      >();

    if (contactsErr) {
      console.error('[companies] agregação de contactos falhou', contactsErr);
      // Não rebenta o endpoint — devolve contacts_count = 0.
    } else {
      for (const c of contactRows ?? []) {
        countsByCompany.set(
          c.company_id,
          (countsByCompany.get(c.company_id) ?? 0) + 1
        );
      }
    }
  }

  // 6) Enriquece, filtra (hasContacts), ordena (contacts_count), pagina.
  let enriched: CompanyListItem[] = baseRows.map((r) => ({
    ...r,
    contacts_count: countsByCompany.get(r.id) ?? 0,
    is_in_catalog: r.workspace_id === null,
  }));

  if (q.hasContacts) {
    enriched = enriched.filter((c) => c.contacts_count > 0);
  }

  if (!sortInSql) {
    // sort=contacts_count
    enriched.sort((a, b) =>
      q.order === 'asc'
        ? a.contacts_count - b.contacts_count
        : b.contacts_count - a.contacts_count
    );
  }

  // Paginação em memória quando não foi feita no SQL.
  const total = paginatedInSql ? count ?? 0 : enriched.length;
  let pageItems = enriched;
  if (!paginatedInSql) {
    const from = (q.page - 1) * q.pageSize;
    const to = from + q.pageSize;
    pageItems = enriched.slice(from, to);
  }

  const totalPages = Math.max(1, Math.ceil(total / q.pageSize));

  return apiOk(pageItems, {
    total,
    page: q.page,
    pageSize: q.pageSize,
    totalPages,
  });
}
