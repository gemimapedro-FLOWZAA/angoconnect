'use client';

import * as React from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface MultiSelectOption {
  label: string;
  value: string;
}

export interface MultiSelectProps {
  options: MultiSelectOption[];
  selected: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  /** Mostra input de pesquisa dentro do dropdown. Default: true. */
  searchable?: boolean;
  /** Mensagem mostrada quando search não devolve resultados. */
  emptyMessage?: string;
  className?: string;
  disabled?: boolean;
  /** Largura máxima do dropdown (default w-64). */
  dropdownClassName?: string;
}

/**
 * MultiSelect leve hand-rolled. Sem combobox completo — apenas dropdown
 * com checkboxes, input de pesquisa interno e click-outside.
 */
const MultiSelect = React.forwardRef<HTMLDivElement, MultiSelectProps>(
  (
    {
      options,
      selected,
      onChange,
      placeholder = 'Seleccionar...',
      searchable = true,
      emptyMessage = 'Sem resultados.',
      className,
      dropdownClassName,
      disabled = false,
    },
    ref
  ) => {
    const [open, setOpen] = React.useState(false);
    const [query, setQuery] = React.useState('');
    const containerRef = React.useRef<HTMLDivElement | null>(null);

    React.useImperativeHandle(ref, () => containerRef.current as HTMLDivElement);

    React.useEffect(() => {
      if (!open) return;
      function onClickOutside(event: MouseEvent) {
        if (
          containerRef.current &&
          !containerRef.current.contains(event.target as Node)
        ) {
          setOpen(false);
        }
      }
      function onKey(event: KeyboardEvent) {
        if (event.key === 'Escape') setOpen(false);
      }
      document.addEventListener('mousedown', onClickOutside);
      document.addEventListener('keydown', onKey);
      return () => {
        document.removeEventListener('mousedown', onClickOutside);
        document.removeEventListener('keydown', onKey);
      };
    }, [open]);

    const selectedSet = React.useMemo(() => new Set(selected), [selected]);

    const filtered = React.useMemo(() => {
      if (!query.trim()) return options;
      const q = query.toLowerCase();
      return options.filter((o) => o.label.toLowerCase().includes(q));
    }, [options, query]);

    function toggleValue(value: string) {
      if (selectedSet.has(value)) {
        onChange(selected.filter((v) => v !== value));
      } else {
        onChange([...selected, value]);
      }
    }

    function clearAll(e: React.MouseEvent) {
      e.stopPropagation();
      onChange([]);
    }

    const triggerLabel =
      selected.length === 0
        ? placeholder
        : selected.length === 1
          ? options.find((o) => o.value === selected[0])?.label ?? selected[0]
          : `${selected.length} seleccionados`;

    return (
      <div ref={containerRef} className={cn('relative', className)}>
        <button
          type="button"
          onClick={() => !disabled && setOpen((v) => !v)}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open ? true : false}
          className={cn(
            'inline-flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-1.5 text-sm transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            'disabled:cursor-not-allowed disabled:opacity-50',
            selected.length === 0 ? 'text-muted-foreground' : 'text-foreground'
          )}
        >
          <span className="truncate text-left">{triggerLabel}</span>
          <span className="ml-2 flex items-center gap-1">
            {selected.length > 0 ? (
              <span
                role="button"
                tabIndex={-1}
                onClick={clearAll}
                aria-label="Limpar selecção"
                className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </span>
            ) : null}
            <ChevronDown
              className={cn(
                'h-4 w-4 text-muted-foreground transition-transform',
                open && 'rotate-180'
              )}
            />
          </span>
        </button>

        {open ? (
          <div
            className={cn(
              'absolute z-30 mt-1 w-full min-w-[14rem] overflow-hidden rounded-md border border-border bg-card text-card-foreground shadow-lg',
              dropdownClassName
            )}
          >
            {searchable ? (
              <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
                <Search className="h-3.5 w-3.5 text-muted-foreground" />
                <input
                  autoFocus
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Procurar..."
                  aria-label="Procurar opções"
                  className="h-7 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                />
              </div>
            ) : null}

            <div
              role="listbox"
              aria-multiselectable={true}
              className="max-h-60 overflow-y-auto py-1"
            >
              {filtered.length === 0 ? (
                <p className="px-3 py-2 text-xs text-muted-foreground">
                  {emptyMessage}
                </p>
              ) : (
                filtered.map((option) => {
                  const isSelected = selectedSet.has(option.value);
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="option"
                      aria-selected={isSelected ? true : false}
                      onClick={() => toggleValue(option.value)}
                      className={cn(
                        'flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-1.5 text-left text-sm transition-colors',
                        'hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-none',
                        isSelected && 'bg-accent/60'
                      )}
                    >
                      <span className="truncate">{option.label}</span>
                      {isSelected ? (
                        <Check
                          className="h-4 w-4 text-primary"
                          strokeWidth={3}
                          aria-hidden="true"
                        />
                      ) : null}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        ) : null}
      </div>
    );
  }
);
MultiSelect.displayName = 'MultiSelect';

export { MultiSelect };
