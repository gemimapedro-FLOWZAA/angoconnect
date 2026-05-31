'use client';

import * as React from 'react';
import { ChevronLeft, ChevronRight, MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface PaginationProps {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  /** Quando true, oculta o componente caso haja apenas 1 página. */
  hideOnSinglePage?: boolean;
  className?: string;
}

/**
 * Devolve um array com até 7 entradas: números de página ou `'…'` (ellipsis).
 * Estratégia:
 *  - <= 7 páginas: mostra todas
 *  - Início próximo (currentPage <= 4): 1 2 3 4 5 … last
 *  - Final próximo (currentPage >= total-3): 1 … (total-4) … last
 *  - Meio: 1 … (cur-1) cur (cur+1) … last
 */
function buildPageList(current: number, total: number): Array<number | 'ellipsis'> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  if (current <= 4) {
    return [1, 2, 3, 4, 5, 'ellipsis', total];
  }
  if (current >= total - 3) {
    return [1, 'ellipsis', total - 4, total - 3, total - 2, total - 1, total];
  }
  return [1, 'ellipsis', current - 1, current, current + 1, 'ellipsis', total];
}

const Pagination = React.forwardRef<HTMLElement, PaginationProps>(
  ({ currentPage, totalPages, onPageChange, hideOnSinglePage, className }, ref) => {
    if (hideOnSinglePage && totalPages <= 1) return null;
    if (totalPages < 1) return null;

    const pages = buildPageList(currentPage, totalPages);
    const isFirst = currentPage <= 1;
    const isLast = currentPage >= totalPages;

    return (
      <nav
        ref={ref}
        aria-label="Paginação"
        className={cn('flex items-center justify-center gap-1', className)}
      >
        <button
          type="button"
          onClick={() => onPageChange(currentPage - 1)}
          disabled={isFirst}
          aria-label="Página anterior"
          className={cn(
            'inline-flex h-8 w-8 items-center justify-center rounded-md text-sm transition-colors',
            'hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            'disabled:pointer-events-none disabled:opacity-40'
          )}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>

        {pages.map((p, idx) => {
          if (p === 'ellipsis') {
            return (
              <span
                key={`ellipsis-${idx}`}
                aria-hidden="true"
                className="inline-flex h-8 w-8 items-center justify-center text-muted-foreground"
              >
                <MoreHorizontal className="h-4 w-4" />
              </span>
            );
          }
          const isActive = p === currentPage;
          return (
            <button
              key={p}
              type="button"
              onClick={() => onPageChange(p)}
              aria-current={isActive ? 'page' : undefined}
              aria-label={`Página ${p}`}
              className={cn(
                'inline-flex h-8 min-w-[2rem] items-center justify-center rounded-md px-2 text-sm font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'text-foreground hover:bg-accent hover:text-accent-foreground'
              )}
            >
              {p}
            </button>
          );
        })}

        <button
          type="button"
          onClick={() => onPageChange(currentPage + 1)}
          disabled={isLast}
          aria-label="Página seguinte"
          className={cn(
            'inline-flex h-8 w-8 items-center justify-center rounded-md text-sm transition-colors',
            'hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            'disabled:pointer-events-none disabled:opacity-40'
          )}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </nav>
    );
  }
);
Pagination.displayName = 'Pagination';

export { Pagination };
