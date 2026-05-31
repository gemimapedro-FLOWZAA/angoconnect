'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Pagination } from '@/components/ui/pagination';
import {
  CompaniesTable,
  type CompanyRow,
} from '@/components/companies/companies-table';
import {
  FiltersSidebar,
  INITIAL_FILTERS,
  type FiltersState,
  type FiltersScope,
} from '@/components/companies/filters-sidebar';
import { CompanySheet } from '@/components/companies/company-sheet';
import { ExportToSequenceDialog } from '@/components/companies/export-to-sequence-dialog';
import { useSelectedCompanies } from '@/components/companies/selected-companies-context';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { formatNumber } from '@/lib/format';

const PAGE_SIZE = 50;

interface CompaniesResponse {
  data?: CompanyRow[];
  meta?: {
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  };
  error?: { code?: string; message?: string };
}

/**
 * Constrói FiltersState a partir dos parâmetros de URL. Permite shareable
 * links e back/forward consistente.
 */
function filtersFromSearchParams(params: URLSearchParams): FiltersState {
  const scopeRaw = params.get('scope');
  const scope: FiltersScope =
    scopeRaw === 'public' || scopeRaw === 'private' ? scopeRaw : 'all';

  return {
    q: params.get('q') ?? '',
    sectors: params.getAll('sector'),
    provincias: params.getAll('provincia'),
    sizes: params.getAll('size'),
    sources: params.getAll('source'),
    hasContacts: params.get('hasContacts') === 'true',
    scope,
  };
}

function pageFromSearchParams(params: URLSearchParams): number {
  const raw = params.get('page');
  if (!raw) return 1;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * Serializa filtros + página para query string. Omite chaves com valor
 * default para manter URLs limpas.
 */
function filtersToSearchParams(filters: FiltersState, page: number): string {
  const params = new URLSearchParams();
  if (filters.q.trim()) params.set('q', filters.q.trim());
  filters.sectors.forEach((s) => params.append('sector', s));
  filters.provincias.forEach((p) => params.append('provincia', p));
  filters.sizes.forEach((s) => params.append('size', s));
  filters.sources.forEach((s) => params.append('source', s));
  if (filters.hasContacts) params.set('hasContacts', 'true');
  if (filters.scope !== 'all') params.set('scope', filters.scope);
  if (page > 1) params.set('page', String(page));
  return params.toString();
}

/** Constrói o URL do endpoint `/api/companies` com base no estado. */
function buildApiQuery(
  workspaceId: string,
  filters: FiltersState,
  page: number
): string {
  const params = new URLSearchParams();
  params.set('workspaceId', workspaceId);
  params.set('page', String(page));
  params.set('pageSize', String(PAGE_SIZE));
  if (filters.q.trim()) params.set('q', filters.q.trim());
  filters.sectors.forEach((s) => params.append('sector', s));
  filters.provincias.forEach((p) => params.append('provincia', p));
  filters.sizes.forEach((s) => params.append('size', s));
  filters.sources.forEach((s) => params.append('source', s));
  if (filters.hasContacts) params.set('hasContacts', 'true');
  params.set('scope', filters.scope);
  return `/api/companies?${params.toString()}`;
}

export interface SearchClientProps {
  workspaceId: string;
  initialCreditsRemaining: number | null;
}

export function SearchClient({
  workspaceId,
  initialCreditsRemaining,
}: SearchClientProps) {
  const router = useRouter();
  const urlParams = useSearchParams();

  // Estado principal — derivado dos search params mas mantido localmente para
  // permitir actualizações optimistas.
  const [filters, setFilters] = React.useState<FiltersState>(() =>
    filtersFromSearchParams(new URLSearchParams(urlParams.toString()))
  );
  const [page, setPage] = React.useState<number>(() =>
    pageFromSearchParams(new URLSearchParams(urlParams.toString()))
  );

  const [companies, setCompanies] = React.useState<CompanyRow[]>([]);
  const [total, setTotal] = React.useState(0);
  const [totalPages, setTotalPages] = React.useState(1);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  // Cross-page selection — vem do provider (sessionStorage). Substitui o
  // useState local que tínhamos em M3.1.
  const {
    selectedIds,
    toggleSelect,
    selectMany,
    unselectMany,
    clear: clearSelection,
  } = useSelectedCompanies();

  const [openCompanyId, setOpenCompanyId] = React.useState<string | null>(null);
  const [exportOpen, setExportOpen] = React.useState(false);

  const [credits, setCredits] = React.useState<number | null>(
    initialCreditsRemaining
  );

  // Debounce dos filtros (especialmente search) para evitar fetch por tecla.
  const debouncedFilters = useDebouncedValue(filters, 300);

  // Sincroniza URL quando filtros/página mudam.
  React.useEffect(() => {
    const qs = filtersToSearchParams(filters, page);
    const next = qs ? `?${qs}` : '';
    // Evita push em cada keystroke do search input — o componente já faz
    // commit por blur/enter, e o debounce só dispara fetch.
    router.replace(`/search${next}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, page]);

  // Reset page para 1 quando filtros mudam (mas não na primeira render).
  const firstRenderRef = React.useRef(true);
  React.useEffect(() => {
    if (firstRenderRef.current) {
      firstRenderRef.current = false;
      return;
    }
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    debouncedFilters.q,
    debouncedFilters.sectors,
    debouncedFilters.provincias,
    debouncedFilters.sizes,
    debouncedFilters.sources,
    debouncedFilters.hasContacts,
    debouncedFilters.scope,
  ]);

  // Fetch dos companies sempre que filtros (debounced) ou página mudam.
  React.useEffect(() => {
    let cancelled = false;

    async function fetchCompanies() {
      setLoading(true);
      setError(null);

      try {
        const res = await fetch(
          buildApiQuery(workspaceId, debouncedFilters, page)
        );
        const body = (await res
          .json()
          .catch(() => ({}))) as CompaniesResponse;

        if (cancelled) return;

        if (!res.ok) {
          setError(
            body.error?.message ?? 'Não foi possível carregar empresas.'
          );
          setCompanies([]);
          setTotal(0);
          setTotalPages(1);
        } else {
          setCompanies(body.data ?? []);
          setTotal(body.meta?.total ?? 0);
          setTotalPages(Math.max(1, body.meta?.totalPages ?? 1));
        }
      } catch {
        if (!cancelled) {
          setError('Erro de rede. Verifica a tua ligação.');
          setCompanies([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchCompanies();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, debouncedFilters, page]);

  function selectAllOnPage(allSelected: boolean) {
    const ids = companies.map((c) => c.id);
    if (allSelected) selectMany(ids);
    else unselectMany(ids);
  }

  function openExport() {
    if (selectedIds.size === 0) return;
    setExportOpen(true);
  }

  // Detecta o trigger ?export=1 vindo do header global. Abre o dialog se
  // houver selecção e remove o param do URL para evitar reabrir em
  // navegações posteriores.
  React.useEffect(() => {
    const wantsExport = urlParams.get('export') === '1';
    if (!wantsExport) return;
    if (selectedIds.size > 0) {
      setExportOpen(true);
    }
    // Remove o param ?export=1 mantendo o restante state
    const next = new URLSearchParams(urlParams.toString());
    next.delete('export');
    const qs = next.toString();
    router.replace(qs ? `/search?${qs}` : '/search', { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlParams]);

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Pesquisar empresas
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Encontra empresas angolanas, revela contactos e exporta para
              sequências de outreach.
            </p>
          </div>
          {credits !== null ? (
            <span className="rounded-md bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
              {formatNumber(credits)} créditos
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-6 lg:flex-row">
        {/* Sidebar */}
        <FiltersSidebar value={filters} onChange={setFilters} />

        {/* Main */}
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          {/* Action bar (sticky) */}
          <div className="sticky top-0 z-20 -mx-1 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-card/90 px-3 py-2 backdrop-blur">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="font-medium">
                {loading && total === 0
                  ? 'A carregar…'
                  : `${formatNumber(total)} empresa${total === 1 ? '' : 's'}`}
              </span>
              {selectedIds.size > 0 ? (
                <Badge variant="default">
                  {formatNumber(selectedIds.size)} seleccionada
                  {selectedIds.size === 1 ? '' : 's'}
                </Badge>
              ) : null}
              {selectedIds.size > 0 ? (
                <button
                  type="button"
                  onClick={clearSelection}
                  className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                >
                  Limpar selecção
                </button>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <Button
                onClick={openExport}
                disabled={selectedIds.size === 0}
                size="sm"
              >
                Exportar para sequência
              </Button>
            </div>
          </div>

          {error ? (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
            >
              {error}
            </div>
          ) : null}

          {/* Table */}
          <CompaniesTable
            companies={companies}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
            onSelectAll={selectAllOnPage}
            onCompanyClick={(id) => setOpenCompanyId(id)}
            loading={loading}
          />

          {/* Pagination */}
          {totalPages > 1 ? (
            <Pagination
              currentPage={page}
              totalPages={totalPages}
              onPageChange={(p) => {
                setPage(p);
                // scroll-to-top suave após mudança de página
                if (typeof window !== 'undefined') {
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }
              }}
              className="pt-2"
            />
          ) : null}
        </div>
      </div>

      {/* Sheet de detalhes */}
      <CompanySheet
        workspaceId={workspaceId}
        companyId={openCompanyId}
        onClose={() => setOpenCompanyId(null)}
        onAddToSequence={(id) => {
          // Adiciona à selecção (cross-page) e abre export.
          selectMany([id]);
          setOpenCompanyId(null);
          setExportOpen(true);
        }}
        onBalanceChange={(newBalance) => setCredits(newBalance)}
      />

      {/* Dialog de export */}
      <ExportToSequenceDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        workspaceId={workspaceId}
        selectedCompanyIds={Array.from(selectedIds)}
        creditsRemaining={credits}
        onSuccess={(result) => {
          setCredits(result.new_balance);
          clearSelection();
          // Refresh do server component (actualiza créditos no header).
          router.refresh();
        }}
      />
    </div>
  );
}
