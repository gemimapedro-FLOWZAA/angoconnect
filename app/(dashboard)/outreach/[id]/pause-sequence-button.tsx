'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

interface PauseResponse {
  data?: { id?: string; status?: string };
  error?: { code?: string; message?: string };
}

export interface PauseSequenceButtonProps {
  sequenceId: string;
  /** Label override (ex: "Activar" quando já está em pausa). */
  label?: string;
  /** Endpoint alternativo (ex: para activar). Default = pause. */
  action?: 'pause' | 'activate';
  variant?: 'default' | 'outline' | 'ghost' | 'destructive';
  size?: 'default' | 'sm' | 'lg';
}

export function PauseSequenceButton({
  sequenceId,
  label,
  action = 'pause',
  variant = 'outline',
  size = 'sm',
}: PauseSequenceButtonProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const defaultLabel = action === 'pause' ? 'Pausar' : 'Activar';
  const finalLabel = label ?? defaultLabel;

  async function onClick() {
    setLoading(true);
    setError(null);

    try {
      // M2.3 backend só expõe /pause. Activação via PATCH status='active'.
      const url =
        action === 'pause'
          ? `/api/sequences/${sequenceId}/pause`
          : `/api/sequences/${sequenceId}`;
      const init: RequestInit =
        action === 'pause'
          ? {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
            }
          : {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: 'active' }),
            };

      const res = await fetch(url, init);
      const body = (await res.json().catch(() => ({}))) as PauseResponse;

      if (!res.ok) {
        setError(
          body.error?.message ??
            (action === 'pause'
              ? 'Não foi possível pausar a sequência.'
              : 'Não foi possível activar a sequência.')
        );
        setLoading(false);
        return;
      }

      setDone(true);
      setLoading(false);
      router.refresh();
    } catch {
      setError('Erro de rede. Tenta novamente.');
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <Button
        variant={variant}
        size={size}
        onClick={onClick}
        disabled={loading || done}
      >
        {loading ? <Spinner /> : null}
        {loading
          ? action === 'pause'
            ? 'A pausar...'
            : 'A activar...'
          : done
            ? action === 'pause'
              ? 'Pausada'
              : 'Activa'
            : finalLabel}
      </Button>
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
