'use client';

import * as React from 'react';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { MultiSelect } from '@/components/ui/multi-select';
import {
  SECTORS,
  PROVINCIAS,
  COMPANY_SIZES,
  DATASET_SOURCES,
} from '@/lib/constants/angola';
import { cn } from '@/lib/utils';

const SECTOR_LABELS: Record<(typeof SECTORS)[number], string> = {
  oil_gas: 'Petróleo e Gás',
  construction: 'Construção',
  telecom: 'Telecomunicações',
  banking: 'Banca',
  insurance: 'Seguros',
  retail: 'Retalho',
  agro: 'Agro',
  health: 'Saúde',
  education: 'Educação',
  logistics: 'Logística',
  tech: 'Tecnologia',
  government: 'Governo',
};

const SIZE_LABELS: Record<(typeof COMPANY_SIZES)[number], string> = {
  micro: 'Micro (1-9)',
  small: 'Pequena (10-49)',
  medium: 'Média (50-249)',
  large: 'Grande (250-999)',
  enterprise: 'Enterprise (1000+)',
};

const SOURCE_LABELS: Record<(typeof DATASET_SOURCES)[number], string> = {
  irgc: 'IRGC',
  linkedin: 'LinkedIn',
  bue: 'BUE',
  news: 'Notícias',
  manual: 'Manual',
};

export type FiltersScope = 'all' | 'public' | 'private';

export interface FiltersState {
  q: string;
  sectors: string[];
  provincias: string[];
  sizes: string[];
  sources: string[];
  hasContacts: boolean;
  scope: FiltersScope;
}

export const INITIAL_FILTERS: FiltersState = {
  q: '',
  sectors: [],
  provincias: [],
  sizes: [],
  sources: [],
  hasContacts: false,
  scope: 'all',
};

export interface FiltersSidebarProps {
  value: FiltersState;
  onChange: (next: FiltersState) => void;
  /** Quando true, mostra contador "X activos". */
  className?: string;
}

const SECTOR_OPTIONS = SECTORS.map((value) => ({
  label: SECTOR_LABELS[value],
  value,
}));

const PROVINCIA_OPTIONS = PROVINCIAS.map((value) => ({
  label: value,
  value,
}));

const SIZE_OPTIONS = COMPANY_SIZES.map((value) => ({
  label: SIZE_LABELS[value],
  value,
}));

const SOURCE_OPTIONS = DATASET_SOURCES.map((value) => ({
  label: SOURCE_LABELS[value],
  value,
}));

function countActive(state: FiltersState): number {
  return (
    (state.q.trim() ? 1 : 0) +
    state.sectors.length +
    state.provincias.length +
    state.sizes.length +
    state.sources.length +
    (state.hasContacts ? 1 : 0) +
    (state.scope !== 'all' ? 1 : 0)
  );
}

export function FiltersSidebar({ value, onChange, className }: FiltersSidebarProps) {
  // Estado local apenas para o input de pesquisa (evita re-renderizar o pai a
  // cada tecla). O `value.q` recebido permanece como source-of-truth para
  // sincronização com URL — quando muda externamente, refletimos no input.
  const [searchInput, setSearchInput] = React.useState(value.q);

  React.useEffect(() => {
    setSearchInput(value.q);
  }, [value.q]);

  function update(patch: Partial<FiltersState>) {
    onChange({ ...value, ...patch });
  }

  function commitSearch(next: string) {
    if (next === value.q) return;
    update({ q: next });
  }

  const active = countActive(value);

  return (
    <aside
      className={cn(
        'flex w-full shrink-0 flex-col gap-4 lg:w-[280px]',
        className
      )}
      aria-label="Filtros de pesquisa"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-tight">Filtros</h2>
        {active > 0 ? (
          <button
            type="button"
            onClick={() => onChange(INITIAL_FILTERS)}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            Limpar ({active})
          </button>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="filter-search">Pesquisa</Label>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="filter-search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onBlur={(e) => commitSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitSearch(searchInput);
              }
            }}
            placeholder="Nome ou NIF"
            className="h-9 pl-8"
          />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Sector</Label>
        <MultiSelect
          options={SECTOR_OPTIONS}
          selected={value.sectors}
          onChange={(next) => update({ sectors: next })}
          placeholder="Todos os sectores"
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label>Província</Label>
        <MultiSelect
          options={PROVINCIA_OPTIONS}
          selected={value.provincias}
          onChange={(next) => update({ provincias: next })}
          placeholder="Todas as províncias"
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label>Tamanho</Label>
        <MultiSelect
          options={SIZE_OPTIONS}
          selected={value.sizes}
          onChange={(next) => update({ sizes: next })}
          placeholder="Todos os tamanhos"
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label>Origem dos dados</Label>
        <MultiSelect
          options={SOURCE_OPTIONS}
          selected={value.sources}
          onChange={(next) => update({ sources: next })}
          placeholder="Todas as origens"
        />
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-4">
        <Label>Visibilidade</Label>
        <div role="radiogroup" className="flex flex-col gap-1.5">
          {(
            [
              { value: 'all', label: 'Todas' },
              { value: 'public', label: 'Apenas catálogo público' },
              { value: 'private', label: 'Apenas privadas do workspace' },
            ] as Array<{ value: FiltersScope; label: string }>
          ).map((opt) => {
            const isSelected = value.scope === opt.value;
            return (
              <label
                key={opt.value}
                className="flex cursor-pointer items-center gap-2 text-sm"
              >
                <input
                  type="radio"
                  name="filter-scope"
                  value={opt.value}
                  checked={isSelected}
                  onChange={() => update({ scope: opt.value })}
                  className="h-3.5 w-3.5 cursor-pointer accent-primary"
                />
                <span className={cn(isSelected ? 'text-foreground' : 'text-muted-foreground')}>
                  {opt.label}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-4">
        <Checkbox
          id="filter-has-contacts"
          checked={value.hasContacts}
          onCheckedChange={(checked) => update({ hasContacts: checked })}
          label="Apenas com contactos"
          description="Mostra só empresas que já têm pelo menos um contacto."
        />
      </div>

      {active > 0 ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => onChange(INITIAL_FILTERS)}
          className="mt-2"
        >
          Limpar todos os filtros
        </Button>
      ) : null}
    </aside>
  );
}
