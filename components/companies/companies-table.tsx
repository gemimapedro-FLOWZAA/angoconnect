'use client';

import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Shape mínimo esperado da API `GET /api/companies`. Mantemos campos
 * opcionais para tolerar variações da resposta — o Backend ainda está em
 * construção em paralelo (ver CLAUDE.md, M3.1).
 */
export interface CompanyRow {
  id: string;
  name: string;
  nif: string | null;
  sector: string | null;
  provincia: string | null;
  size: string | null;
  website: string | null;
  source: 'irgc' | 'linkedin' | 'bue' | 'news' | 'manual' | string;
  contacts_count: number | null;
  created_at: string;
  /** Quando workspace_id é null → empresa do catálogo público. */
  is_public?: boolean;
}

type SourceVariantKey = CompanyRow['source'];

const SOURCE_LABELS: Record<string, string> = {
  irgc: 'IRGC',
  linkedin: 'LinkedIn',
  bue: 'BUE',
  news: 'Notícias',
  manual: 'Manual',
};

// Cores derivadas do brief: irgc=blue, linkedin=sky, bue=green, news=amber, manual=gray.
const SOURCE_CLASSES: Record<string, string> = {
  irgc: 'bg-blue-100 text-blue-800 border-blue-200',
  linkedin: 'bg-sky-100 text-sky-800 border-sky-200',
  bue: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  news: 'bg-amber-100 text-amber-800 border-amber-200',
  manual: 'bg-zinc-100 text-zinc-700 border-zinc-200',
};

const SECTOR_LABELS: Record<string, string> = {
  oil_gas: 'Petróleo e Gás',
  construction: 'Construção',
  telecom: 'Telecom',
  banking: 'Banca',
  insurance: 'Seguros',
  retail: 'Retalho',
  agro: 'Agro',
  health: 'Saúde',
  education: 'Educação',
  logistics: 'Logística',
  tech: 'Tech',
  government: 'Governo',
};

const SIZE_LABELS: Record<string, string> = {
  micro: 'Micro',
  small: 'Pequena',
  medium: 'Média',
  large: 'Grande',
  enterprise: 'Enterprise',
};

function SourceBadge({ source }: { source: SourceVariantKey }) {
  const label = SOURCE_LABELS[source] ?? source;
  const classes = SOURCE_CLASSES[source] ?? SOURCE_CLASSES.manual;
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
        classes
      )}
    >
      {label}
    </span>
  );
}

export interface CompaniesTableProps {
  companies: CompanyRow[];
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onSelectAll: (allSelected: boolean) => void;
  onCompanyClick: (id: string) => void;
  loading?: boolean;
  /** Mostrado quando companies.length === 0 e !loading. */
  emptyMessage?: string;
}

function SkeletonRow() {
  return (
    <TableRow>
      <TableCell className="w-10">
        <div className="h-4 w-4 animate-pulse rounded-sm bg-muted" />
      </TableCell>
      <TableCell>
        <div className="h-4 w-48 animate-pulse rounded bg-muted" />
      </TableCell>
      <TableCell>
        <div className="h-4 w-20 animate-pulse rounded bg-muted" />
      </TableCell>
      <TableCell>
        <div className="h-4 w-24 animate-pulse rounded bg-muted" />
      </TableCell>
      <TableCell>
        <div className="h-4 w-16 animate-pulse rounded bg-muted" />
      </TableCell>
      <TableCell>
        <div className="h-4 w-8 animate-pulse rounded bg-muted" />
      </TableCell>
      <TableCell>
        <div className="h-4 w-14 animate-pulse rounded bg-muted" />
      </TableCell>
    </TableRow>
  );
}

export function CompaniesTable({
  companies,
  selectedIds,
  onToggleSelect,
  onSelectAll,
  onCompanyClick,
  loading = false,
  emptyMessage = 'Nenhuma empresa encontrada. Ajusta os filtros.',
}: CompaniesTableProps) {
  const allOnPageSelected =
    companies.length > 0 && companies.every((c) => selectedIds.has(c.id));
  const someOnPageSelected =
    !allOnPageSelected && companies.some((c) => selectedIds.has(c.id));
  const headerCheckedState: boolean | 'indeterminate' = allOnPageSelected
    ? true
    : someOnPageSelected
      ? 'indeterminate'
      : false;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              <Checkbox
                aria-label="Seleccionar tudo na página"
                checked={headerCheckedState}
                onCheckedChange={(checked) => onSelectAll(checked)}
              />
            </TableHead>
            <TableHead>Empresa</TableHead>
            <TableHead>Sector</TableHead>
            <TableHead>Província</TableHead>
            <TableHead>Tamanho</TableHead>
            <TableHead className="text-right">Contactos</TableHead>
            <TableHead>Origem</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && companies.length === 0 ? (
            <>
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
            </>
          ) : companies.length === 0 ? (
            <TableRow>
              <TableCell colSpan={7} className="py-10 text-center">
                <p className="text-sm text-muted-foreground">{emptyMessage}</p>
              </TableCell>
            </TableRow>
          ) : (
            companies.map((company) => {
              const isSelected = selectedIds.has(company.id);
              return (
                <TableRow
                  key={company.id}
                  data-state={isSelected ? 'selected' : undefined}
                >
                  <TableCell className="w-10">
                    <Checkbox
                      aria-label={`Seleccionar ${company.name}`}
                      checked={isSelected}
                      onCheckedChange={() => onToggleSelect(company.id)}
                    />
                  </TableCell>
                  <TableCell>
                    <button
                      type="button"
                      onClick={() => onCompanyClick(company.id)}
                      className="flex flex-col items-start text-left transition-colors hover:text-primary"
                    >
                      <span className="font-medium leading-tight">
                        {company.name}
                      </span>
                      {company.nif ? (
                        <span className="text-xs text-muted-foreground">
                          NIF {company.nif}
                        </span>
                      ) : null}
                    </button>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {company.sector
                      ? (SECTOR_LABELS[company.sector] ?? company.sector)
                      : '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {company.provincia ?? '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {company.size
                      ? (SIZE_LABELS[company.size] ?? company.size)
                      : '—'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {company.contacts_count && company.contacts_count > 0 ? (
                      <Badge variant="secondary">
                        {formatNumber(company.contacts_count)}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <SourceBadge source={company.source} />
                  </TableCell>
                </TableRow>
              );
            })
          )}
          {loading && companies.length > 0 ? (
            <TableRow>
              <TableCell
                colSpan={7}
                className="py-2 text-center text-xs text-muted-foreground"
              >
                A actualizar resultados…
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </div>
  );
}
