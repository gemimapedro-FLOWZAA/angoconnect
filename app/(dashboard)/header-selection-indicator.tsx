'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { useSelectedCompanies } from '@/components/companies/selected-companies-context';
import { formatNumber } from '@/lib/format';

/**
 * Indicador no header do dashboard que mostra quantas empresas estão
 * seleccionadas (cross-page). Aparece só quando count > 0.
 *
 * O botão "Exportar" navega para /search?export=1 — a página da Search
 * detecta esse query param e abre o ExportToSequenceDialog. Esta abordagem
 * mantém o dialog onde já vive (na search-client) sem subir mais state ao
 * layout.
 */
export function HeaderSelectionIndicator() {
  const router = useRouter();
  const { count, clear } = useSelectedCompanies();

  if (count === 0) return null;

  return (
    <div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-1 text-xs">
      <span className="font-medium text-primary">
        {formatNumber(count)} empresa{count === 1 ? '' : 's'} seleccionada
        {count === 1 ? '' : 's'}
      </span>
      <button
        type="button"
        onClick={clear}
        className="text-muted-foreground underline-offset-2 hover:underline"
      >
        Limpar
      </button>
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2 text-xs"
        onClick={() => router.push('/search?export=1')}
      >
        Exportar
      </Button>
    </div>
  );
}
