'use client';

import * as React from 'react';

/**
 * Contexto global (dentro do dashboard) que mantém a selecção de empresas
 * persistente entre páginas da Search. A persistência é em `sessionStorage`
 * — limpa quando o tab fecha, evita lixo entre sessões.
 *
 * Usado por:
 *   - app/(dashboard)/search/search-client.tsx — toggleSelect / selectAllOnPage
 *   - app/(dashboard)/layout.tsx — indicador "X empresas seleccionadas"
 */

export interface SelectedCompaniesState {
  selectedIds: Set<string>;
  toggleSelect: (id: string) => void;
  selectMany: (ids: string[]) => void;
  unselectMany: (ids: string[]) => void;
  clear: () => void;
  count: number;
}

const SelectedCompaniesContext =
  React.createContext<SelectedCompaniesState | null>(null);

const STORAGE_KEY = 'angoconnect:selected-companies';

function readFromStorage(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === 'string'));
  } catch {
    return new Set();
  }
}

function writeToStorage(set: Set<string>): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
  } catch {
    // Quota cheia ou storage indisponível: silenciar — selecção fica só em memória.
  }
}

export function SelectedCompaniesProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  // Inicia vazio para evitar mismatch SSR/cliente; hidrata após mount.
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(
    () => new Set()
  );
  const [hydrated, setHydrated] = React.useState(false);

  React.useEffect(() => {
    setSelectedIds(readFromStorage());
    setHydrated(true);
  }, []);

  // Persistir cada mudança (após hidratação).
  React.useEffect(() => {
    if (!hydrated) return;
    writeToStorage(selectedIds);
  }, [selectedIds, hydrated]);

  const toggleSelect = React.useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectMany = React.useCallback((ids: string[]) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
  }, []);

  const unselectMany = React.useCallback((ids: string[]) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  }, []);

  const clear = React.useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const value = React.useMemo<SelectedCompaniesState>(
    () => ({
      selectedIds,
      toggleSelect,
      selectMany,
      unselectMany,
      clear,
      count: selectedIds.size,
    }),
    [selectedIds, toggleSelect, selectMany, unselectMany, clear]
  );

  return (
    <SelectedCompaniesContext.Provider value={value}>
      {children}
    </SelectedCompaniesContext.Provider>
  );
}

export function useSelectedCompanies(): SelectedCompaniesState {
  const ctx = React.useContext(SelectedCompaniesContext);
  if (!ctx) {
    throw new Error(
      'useSelectedCompanies deve ser usado dentro de <SelectedCompaniesProvider>.'
    );
  }
  return ctx;
}
