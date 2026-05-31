'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import type { PlanId } from '@/lib/billing/plans';

interface CheckoutResponse {
  data?: {
    url?: string;
    sessionId?: string;
  };
  error?: {
    code?: string;
    message?: string;
  };
}

export interface CheckoutButtonProps {
  workspaceId: string;
  planId: PlanId;
  label: string;
  variant?: 'default' | 'outline';
  /**
   * Quando true, o botão fica desabilitado (caso típico: plano actual).
   * Não dispara fetch.
   */
  disabled?: boolean;
}

export function CheckoutButton({
  workspaceId,
  planId,
  label,
  variant = 'default',
  disabled = false,
}: CheckoutButtonProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, planId }),
      });

      const body = (await res.json().catch(() => ({}))) as CheckoutResponse;

      if (!res.ok || !body.data?.url) {
        setError(
          body.error?.message ??
            'Não foi possível iniciar o checkout. Tenta novamente.'
        );
        setLoading(false);
        return;
      }

      window.location.href = body.data.url;
    } catch {
      setError('Erro de rede. Verifica a tua ligação e tenta novamente.');
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        variant={variant}
        onClick={onClick}
        disabled={disabled || loading}
        className="w-full"
      >
        {loading ? <Spinner /> : null}
        {loading ? 'A redireccionar...' : label}
      </Button>
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
