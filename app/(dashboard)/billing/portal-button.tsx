'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

interface PortalResponse {
  data?: {
    url?: string;
  };
  error?: {
    code?: string;
    message?: string;
  };
}

export interface PortalButtonProps {
  disabled?: boolean;
}

export function PortalButton({ disabled = false }: PortalButtonProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/billing/portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const body = (await res.json().catch(() => ({}))) as PortalResponse;

      if (res.status === 409 || body.error?.code === 'NO_CUSTOMER') {
        setError('Ainda sem subscrição activa.');
        setLoading(false);
        return;
      }

      if (!res.ok || !body.data?.url) {
        setError(
          body.error?.message ??
            'Não foi possível abrir o portal de gestão. Tenta novamente.'
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
        variant="outline"
        onClick={onClick}
        disabled={disabled || loading}
      >
        {loading ? <Spinner /> : null}
        {loading ? 'A abrir...' : 'Gerir subscrição'}
      </Button>
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
