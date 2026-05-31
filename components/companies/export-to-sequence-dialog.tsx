'use client';

import * as React from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { formatNumber } from '@/lib/format';

interface ContactsForExportResponse {
  data?: {
    contactIds: string[];
    summary: {
      totalContacts: number;
      companiesScanned: number;
      contactsWithEmail: number;
    };
  };
  error?: { code?: string; message?: string };
}

interface SequencesListResponse {
  data?: Array<{
    id: string;
    name: string;
    status: 'draft' | 'active' | 'paused' | 'archived';
  }>;
  error?: { code?: string; message?: string };
}

interface EnrolResponse {
  data?: {
    enrolled_count: number;
    skipped_count: number;
    credits_debited: number;
    new_balance: number;
  };
  error?: { code?: string; message?: string };
}

export interface ExportToSequenceDialogProps {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  /** Lista de companyIds seleccionados. */
  selectedCompanyIds: string[];
  /** Saldo actual em créditos (para validação client-side). */
  creditsRemaining: number | null;
  /** Callback após sucesso para o pai actualizar saldo / limpar selecção. */
  onSuccess?: (result: NonNullable<EnrolResponse['data']>) => void;
}

export function ExportToSequenceDialog({
  open,
  onClose,
  workspaceId,
  selectedCompanyIds,
  creditsRemaining,
  onSuccess,
}: ExportToSequenceDialogProps) {
  const [loadingPreview, setLoadingPreview] = React.useState(false);
  const [loadingSequences, setLoadingSequences] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<
    ContactsForExportResponse['data'] | null
  >(null);
  const [sequences, setSequences] = React.useState<
    NonNullable<SequencesListResponse['data']>
  >([]);
  const [sequenceId, setSequenceId] = React.useState<string>('');

  // Carrega preview + sequências quando o dialog abre.
  React.useEffect(() => {
    if (!open) {
      setPreview(null);
      setSequences([]);
      setSequenceId('');
      setError(null);
      return;
    }

    let cancelled = false;

    async function loadAll() {
      setLoadingPreview(true);
      setLoadingSequences(true);
      setError(null);

      try {
        const [previewRes, sequencesRes] = await Promise.all([
          fetch('/api/companies/contacts-for-export', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              workspaceId,
              companyIds: selectedCompanyIds,
            }),
          }),
          fetch(
            `/api/sequences?workspaceId=${encodeURIComponent(workspaceId)}`
          ),
        ]);

        const previewBody = (await previewRes
          .json()
          .catch(() => ({}))) as ContactsForExportResponse;
        const sequencesBody = (await sequencesRes
          .json()
          .catch(() => ({}))) as SequencesListResponse;

        if (cancelled) return;

        if (!previewRes.ok || !previewBody.data) {
          setError(
            previewBody.error?.message ??
              'Não foi possível calcular o preview de exportação.'
          );
        } else {
          setPreview(previewBody.data);
        }

        if (sequencesRes.ok && sequencesBody.data) {
          // Filtra apenas sequências utilizáveis (não arquivadas).
          const usable = sequencesBody.data.filter(
            (s) => s.status !== 'archived'
          );
          setSequences(usable);
          // Pré-selecciona a primeira activa ou em rascunho.
          const firstActive = usable.find((s) => s.status === 'active');
          setSequenceId(firstActive?.id ?? usable[0]?.id ?? '');
        } else {
          setSequences([]);
        }
      } catch {
        if (!cancelled) {
          setError('Erro de rede. Tenta novamente.');
        }
      } finally {
        if (!cancelled) {
          setLoadingPreview(false);
          setLoadingSequences(false);
        }
      }
    }

    loadAll();
    return () => {
      cancelled = true;
    };
  }, [open, workspaceId, selectedCompanyIds]);

  const totalContacts = preview?.summary.totalContacts ?? 0;
  // O custo real é determinado server-side. Aqui usamos uma heurística
  // optimista: cost = totalContacts (1 crédito por contacto novo). O backend
  // devolve credits_debited verdadeiro após o POST.
  const estimatedCost = totalContacts;
  const insufficientCredits =
    creditsRemaining !== null && estimatedCost > creditsRemaining;

  async function onConfirm() {
    if (!sequenceId) return;
    setSubmitting(true);
    setError(null);

    try {
      const contactIds = preview?.contactIds ?? [];
      const res = await fetch(`/api/sequences/${sequenceId}/enrol`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactIds }),
      });

      const body = (await res.json().catch(() => ({}))) as EnrolResponse;

      if (res.status === 402 || body.error?.code === 'INSUFFICIENT_CREDITS') {
        setError(
          'Sem créditos suficientes. Faz upgrade do plano em Faturação.'
        );
        setSubmitting(false);
        return;
      }

      if (!res.ok || !body.data) {
        setError(
          body.error?.message ?? 'Não foi possível enrolar os contactos.'
        );
        setSubmitting(false);
        return;
      }

      onSuccess?.(body.data);
      setSubmitting(false);
      onClose();
    } catch {
      setError('Erro de rede. Tenta novamente.');
      setSubmitting(false);
    }
  }

  const loading = loadingPreview || loadingSequences;

  return (
    <Dialog open={open} onOpenChange={(v) => (!v ? onClose() : null)}>
      <DialogContent widthClassName="w-full max-w-md">
        <DialogHeader>
          <DialogTitle>Exportar para sequência</DialogTitle>
          <DialogDescription>
            Os contactos das empresas seleccionadas vão ser inscritos numa
            sequência. Contactos do catálogo público são revelados (1 crédito
            cada) antes da inscrição.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 px-6 py-4">
          {/* Preview */}
          <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
            {loadingPreview ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Spinner /> A calcular contactos…
              </div>
            ) : preview ? (
              <div className="flex flex-col gap-1">
                <p>
                  <span className="font-semibold">
                    {formatNumber(preview.summary.totalContacts)}
                  </span>{' '}
                  contactos de{' '}
                  <span className="font-semibold">
                    {formatNumber(preview.summary.companiesScanned)}
                  </span>{' '}
                  empresa{preview.summary.companiesScanned === 1 ? '' : 's'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatNumber(preview.summary.contactsWithEmail)} com email
                  válido · custo estimado: {formatNumber(estimatedCost)}{' '}
                  {estimatedCost === 1 ? 'crédito' : 'créditos'}
                </p>
                {creditsRemaining !== null ? (
                  <p className="text-xs text-muted-foreground">
                    Saldo actual: {formatNumber(creditsRemaining)} créditos
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="text-muted-foreground">Sem dados de preview.</p>
            )}
          </div>

          {/* Selector de sequência */}
          <div className="flex flex-col gap-2">
            <label htmlFor="seq-target" className="text-sm font-medium">
              Sequência destino
            </label>
            {loadingSequences ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner /> A carregar sequências…
              </div>
            ) : sequences.length === 0 ? (
              <div className="rounded-md border border-dashed border-border bg-muted/30 p-3 text-sm">
                <p className="text-muted-foreground">
                  Ainda não tens sequências.{' '}
                  <Link
                    href="/outreach/new"
                    className="text-primary hover:underline"
                  >
                    Cria a primeira →
                  </Link>
                </p>
              </div>
            ) : (
              <>
                <Select
                  id="seq-target"
                  value={sequenceId}
                  onChange={(e) => setSequenceId(e.target.value)}
                >
                  {sequences.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} {s.status === 'active' ? '(activa)' : s.status === 'paused' ? '(pausa)' : '(rascunho)'}
                    </option>
                  ))}
                </Select>
                <p className="text-xs text-muted-foreground">
                  Os contactos vão entrar pelo primeiro passo da sequência.
                </p>
              </>
            )}
          </div>

          {insufficientCredits && preview ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              Não tens créditos suficientes para revelar todos estes
              contactos.{' '}
              <Link href="/billing" className="underline">
                Ver planos
              </Link>
            </div>
          ) : null}

          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancelar
          </Button>
          <Button
            onClick={onConfirm}
            disabled={
              loading ||
              submitting ||
              !sequenceId ||
              totalContacts === 0 ||
              !preview
            }
          >
            {submitting ? <Spinner /> : null}
            {submitting
              ? 'A enrolar...'
              : `Confirmar${
                  estimatedCost > 0
                    ? ` (até ${formatNumber(estimatedCost)} créditos)`
                    : ''
                }`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
