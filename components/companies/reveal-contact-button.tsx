'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface RevealResponse {
  data?: {
    revealed_count: number;
    already_revealed_count: number;
    credits_debited: number;
    new_balance: number;
  };
  error?: {
    code?: string;
    message?: string;
  };
}

export interface RevealContactButtonProps {
  workspaceId: string;
  contactId: string;
  /** Custo em créditos, normalmente 1. */
  cost?: number;
  /** Callback após sucesso para o pai actualizar estado do contacto. */
  onRevealed?: (result: NonNullable<RevealResponse['data']>) => void;
  /** Quando o backend devolve créditos actualizados, propaga para o pai. */
  onBalanceChange?: (newBalance: number) => void;
  /** Permite estilo compacto na linha do contacto. */
  size?: 'sm' | 'default';
}

export function RevealContactButton({
  workspaceId,
  contactId,
  cost = 1,
  onRevealed,
  onBalanceChange,
  size = 'sm',
}: RevealContactButtonProps) {
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [showInsufficient, setShowInsufficient] = React.useState(false);

  async function onClick() {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/contacts/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, contactIds: [contactId] }),
      });
      const body = (await res.json().catch(() => ({}))) as RevealResponse;

      if (res.status === 402 || body.error?.code === 'INSUFFICIENT_CREDITS') {
        setShowInsufficient(true);
        setLoading(false);
        return;
      }

      if (!res.ok || !body.data) {
        setError(body.error?.message ?? 'Não foi possível revelar o contacto.');
        setLoading(false);
        return;
      }

      onRevealed?.(body.data);
      onBalanceChange?.(body.data.new_balance);
      setLoading(false);
    } catch {
      setError('Erro de rede. Tenta novamente.');
      setLoading(false);
    }
  }

  return (
    <>
      <div className="flex flex-col gap-1">
        <Button
          variant="outline"
          size={size}
          onClick={onClick}
          disabled={loading}
        >
          {loading ? <Spinner /> : null}
          {loading
            ? 'A revelar...'
            : `Revelar (${cost} ${cost === 1 ? 'crédito' : 'créditos'})`}
        </Button>
        {error ? (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <Dialog open={showInsufficient} onOpenChange={setShowInsufficient}>
        <DialogContent widthClassName="w-full max-w-sm">
          <DialogHeader>
            <DialogTitle>Sem créditos suficientes</DialogTitle>
            <DialogDescription>
              Não tens créditos suficientes para revelar este contacto. Faz
              upgrade do plano ou aguarda a renovação dos créditos.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowInsufficient(false)}
            >
              Cancelar
            </Button>
            <Button
              onClick={() => {
                setShowInsufficient(false);
                window.location.href = '/billing';
              }}
            >
              Ver planos
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
