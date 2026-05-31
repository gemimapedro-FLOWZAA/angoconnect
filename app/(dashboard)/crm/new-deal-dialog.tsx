'use client';

import * as React from 'react';
import Link from 'next/link';
import { ExternalLink, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Spinner } from '@/components/ui/spinner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatAKZ } from '@/lib/format';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { cn } from '@/lib/utils';
import type { Stage } from './kanban-board';
import type { Deal } from './deal-drawer';

// ---------------------------------------------------------------------------
// Tipos do contrato GET /api/contacts/search
// ---------------------------------------------------------------------------

interface SearchCompany {
  id: string;
  name: string;
  sector: string | null;
  provincia: string | null;
}

interface SearchContact {
  id: string;
  name: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
  company: SearchCompany | null;
}

interface SearchResponse {
  data?: SearchContact[];
  error?: { code?: string; message?: string };
}

interface CreateDealResponse {
  data?: Deal;
  error?: { code?: string; message?: string };
}

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

export interface NewDealDialogProps {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  stages: Stage[];
  /** Stage pré-seleccionado (quando aberto a partir de "+ Adicionar" duma coluna). */
  defaultStageId?: string | null;
  onCreated: (deal: Deal) => void;
}

/**
 * Modal para criar deal manualmente, com autocomplete de contactos.
 * Usa `/api/contacts/search?workspaceId&q&limit=10` com debounce de 300ms.
 */
export function NewDealDialog({
  open,
  onClose,
  workspaceId,
  stages,
  defaultStageId,
  onCreated,
}: NewDealDialogProps) {
  const firstStageId = stages[0]?.id ?? '';

  // ---- autocomplete state ------------------------------------------------
  const [query, setQuery] = React.useState('');
  const debouncedQuery = useDebouncedValue(query, 300);
  const [results, setResults] = React.useState<SearchContact[]>([]);
  const [searchLoading, setSearchLoading] = React.useState(false);
  const [searchError, setSearchError] = React.useState<string | null>(null);
  const [showDropdown, setShowDropdown] = React.useState(false);
  const [activeIdx, setActiveIdx] = React.useState(0);
  const [selectedContact, setSelectedContact] =
    React.useState<SearchContact | null>(null);

  // ---- form state -------------------------------------------------------
  const [stageId, setStageId] = React.useState<string>(
    defaultStageId ?? firstStageId
  );
  const [valueAkz, setValueAkz] = React.useState('');
  const [expectedClose, setExpectedClose] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Sync stage default + reset on open.
  React.useEffect(() => {
    if (!open) return;
    setStageId(defaultStageId ?? firstStageId);
    setError(null);
  }, [open, defaultStageId, firstStageId]);

  // Reset all form fields when the dialog closes.
  React.useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
      setSearchError(null);
      setShowDropdown(false);
      setSelectedContact(null);
      setActiveIdx(0);
      setValueAkz('');
      setExpectedClose('');
      setNotes('');
      setSubmitting(false);
      setError(null);
    }
  }, [open]);

  // Fetch search results when query changes.
  React.useEffect(() => {
    if (!open) return;
    const q = debouncedQuery.trim();
    if (q.length < 2) {
      setResults([]);
      setSearchError(null);
      setSearchLoading(false);
      return;
    }
    let cancelled = false;
    async function load() {
      setSearchLoading(true);
      setSearchError(null);
      try {
        const url = `/api/contacts/search?workspaceId=${encodeURIComponent(
          workspaceId
        )}&q=${encodeURIComponent(q)}&limit=10`;
        const res = await fetch(url);
        const body = (await res.json().catch(() => ({}))) as SearchResponse;
        if (cancelled) return;
        if (!res.ok || !body.data) {
          setSearchError(
            body.error?.message ?? 'Não foi possível pesquisar contactos.'
          );
          setResults([]);
        } else {
          setResults(body.data);
          setActiveIdx(0);
        }
      } catch {
        if (!cancelled) {
          setSearchError('Erro de rede ao pesquisar.');
          setResults([]);
        }
      } finally {
        if (!cancelled) setSearchLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, workspaceId, open]);

  function pickContact(contact: SearchContact) {
    setSelectedContact(contact);
    setShowDropdown(false);
    setQuery('');
    setResults([]);
  }

  function clearSelection() {
    setSelectedContact(null);
    setQuery('');
    setResults([]);
    setShowDropdown(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!showDropdown || results.length === 0) {
      if (e.key === 'ArrowDown' && results.length > 0) {
        setShowDropdown(true);
        e.preventDefault();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const chosen = results[activeIdx];
      if (chosen) pickContact(chosen);
    } else if (e.key === 'Escape') {
      setShowDropdown(false);
    }
  }

  async function handleSubmit(e?: React.FormEvent | React.MouseEvent) {
    e?.preventDefault();
    if (submitting) return;

    if (!selectedContact) {
      setError('Selecciona um contacto para criar o deal.');
      return;
    }

    const numericValue = valueAkz.trim() === '' ? null : Number(valueAkz);
    if (numericValue !== null && (Number.isNaN(numericValue) || numericValue < 0)) {
      setError('Valor inválido. Usa um número não negativo.');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch('/api/deals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          contactId: selectedContact.id,
          stageId: stageId || undefined,
          valueAkz: numericValue,
          expectedCloseDate: expectedClose.trim() === '' ? null : expectedClose,
          notes: notes.trim() === '' ? null : notes,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as CreateDealResponse;

      if (!res.ok || !body.data) {
        setError(body.error?.message ?? 'Não foi possível criar o deal.');
        setSubmitting(false);
        return;
      }

      onCreated(body.data);
      setSubmitting(false);
    } catch {
      setError('Erro de rede. Verifica a tua ligação e tenta novamente.');
      setSubmitting(false);
    }
  }

  const numericPreview = valueAkz.trim() === '' ? null : Number(valueAkz);

  const sectorLabel = selectedContact?.company?.sector
    ? (SECTOR_LABELS[selectedContact.company.sector] ??
        selectedContact.company.sector)
    : null;

  return (
    <Dialog open={open} onOpenChange={(v) => (!v ? onClose() : null)}>
      <DialogContent widthClassName="w-full max-w-lg">
        <DialogHeader>
          <DialogTitle>Novo deal</DialogTitle>
          <DialogDescription>
            Pesquisa o contacto por nome, email ou empresa e cria um deal.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4 px-6 py-4">
          {/* Contacto */}
          {selectedContact ? (
            <div className="flex flex-col gap-1.5">
              <Label>Contacto</Label>
              <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-muted/30 p-3">
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-semibold">
                    {selectedContact.name ?? 'Sem nome'}
                  </span>
                  {selectedContact.title ? (
                    <span className="truncate text-xs text-muted-foreground">
                      {selectedContact.title}
                    </span>
                  ) : null}
                  {selectedContact.company ? (
                    <span className="truncate text-xs text-muted-foreground">
                      {selectedContact.company.name}
                      {sectorLabel ? ` · ${sectorLabel}` : ''}
                      {selectedContact.company.provincia
                        ? ` · ${selectedContact.company.provincia}`
                        : ''}
                    </span>
                  ) : null}
                  {selectedContact.email ? (
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {selectedContact.email}
                    </span>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={clearSelection}
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label="Limpar selecção de contacto"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                  Limpar
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="contact-search">
                Contacto <span className="text-destructive">*</span>
              </Label>
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  id="contact-search"
                  autoComplete="off"
                  placeholder="Pesquisar por nome, email ou empresa…"
                  className="pl-9"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setShowDropdown(true);
                  }}
                  onFocus={() => {
                    if (results.length > 0 || debouncedQuery.trim().length >= 2) {
                      setShowDropdown(true);
                    }
                  }}
                  onKeyDown={handleKeyDown}
                />
                {searchLoading ? (
                  <Spinner className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                ) : null}

                {showDropdown && debouncedQuery.trim().length >= 2 ? (
                  <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-lg">
                    {searchLoading && results.length === 0 ? (
                      <div className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground">
                        <Spinner /> A pesquisar…
                      </div>
                    ) : searchError ? (
                      <div
                        role="alert"
                        className="px-3 py-3 text-sm text-destructive"
                      >
                        {searchError}
                      </div>
                    ) : results.length === 0 ? (
                      <div className="flex flex-col gap-1 px-3 py-3 text-sm">
                        <span className="text-muted-foreground">
                          Nenhum contacto encontrado.
                        </span>
                        <Link
                          href="/search"
                          className="inline-flex items-center gap-0.5 text-xs text-primary hover:underline"
                        >
                          Abrir Pesquisa avançada{' '}
                          <ExternalLink
                            className="h-3 w-3"
                            aria-hidden="true"
                          />
                        </Link>
                      </div>
                    ) : (
                      <ul role="listbox" className="py-1">
                        {results.map((contact, idx) => {
                          const isActive = idx === activeIdx;
                          const sectLabel = contact.company?.sector
                            ? (SECTOR_LABELS[contact.company.sector] ??
                                contact.company.sector)
                            : null;
                          return (
                            <li
                              key={contact.id}
                              role="option"
                              aria-selected={isActive}
                            >
                              <button
                                type="button"
                                onMouseEnter={() => setActiveIdx(idx)}
                                onClick={() => pickContact(contact)}
                                className={cn(
                                  'flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm transition-colors',
                                  isActive
                                    ? 'bg-accent text-accent-foreground'
                                    : 'hover:bg-accent/60'
                                )}
                              >
                                <span className="font-medium">
                                  {contact.name ?? 'Sem nome'}
                                </span>
                                <span className="line-clamp-1 text-xs text-muted-foreground">
                                  {contact.title ? `${contact.title} · ` : ''}
                                  {contact.company?.name ?? 'Sem empresa'}
                                  {sectLabel ? ` · ${sectLabel}` : ''}
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">
                Não encontras quem procuras?{' '}
                <Link
                  href="/search"
                  className="inline-flex items-center gap-0.5 text-primary hover:underline"
                >
                  Abrir Pesquisa{' '}
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </Link>
                .
              </p>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-stage">Etapa</Label>
            <Select
              id="new-stage"
              value={stageId}
              onChange={(e) => setStageId(e.target.value)}
            >
              {stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-value">Valor (AKZ)</Label>
              <Input
                id="new-value"
                type="number"
                min={0}
                step={1000}
                placeholder="0"
                value={valueAkz}
                onChange={(e) => setValueAkz(e.target.value)}
              />
              {numericPreview != null && !Number.isNaN(numericPreview) ? (
                <p className="text-xs text-muted-foreground">
                  ≈ {formatAKZ(numericPreview)}
                </p>
              ) : null}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-close">Fecho esperado</Label>
              <Input
                id="new-close"
                type="date"
                value={expectedClose}
                onChange={(e) => setExpectedClose(e.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-notes">Notas</Label>
            <Textarea
              id="new-notes"
              rows={4}
              placeholder="Contexto, próximos passos…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          {error ? (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
            >
              {error}
            </div>
          ) : null}
        </form>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancelar
          </Button>
          <Button
            onClick={() => handleSubmit()}
            disabled={submitting || !selectedContact}
          >
            {submitting ? <Spinner /> : null}
            {submitting ? 'A criar…' : 'Criar deal'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
