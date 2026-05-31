'use client';

/**
 * `global-error.tsx` — substitui o root layout quando este crasha. Tem de
 * incluir `<html>` e `<body>` próprios. Usamos para capturar erros que o
 * `error.tsx` por route segment não apanha (ex: bugs no layout global).
 *
 * Sentry é notificado via `Sentry.captureException` no efeito de mount.
 */

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="pt">
      <body>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '100vh',
            padding: '2rem',
            fontFamily: 'system-ui, sans-serif',
            gap: '1rem',
            textAlign: 'center',
          }}
        >
          <h1 style={{ fontSize: '1.5rem', fontWeight: 600 }}>
            Algo correu mal.
          </h1>
          <p style={{ color: '#666', maxWidth: '32rem' }}>
            Ocorreu um erro inesperado. A nossa equipa foi notificada — por
            favor tenta novamente daqui a alguns instantes.
          </p>
          {error.digest ? (
            <p style={{ fontSize: '0.75rem', color: '#999' }}>
              ID do erro: <code>{error.digest}</code>
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => reset()}
            style={{
              padding: '0.5rem 1rem',
              borderRadius: '0.375rem',
              border: '1px solid #d4d4d8',
              background: '#fff',
              cursor: 'pointer',
              fontSize: '0.875rem',
            }}
          >
            Tentar novamente
          </button>
        </div>
      </body>
    </html>
  );
}
