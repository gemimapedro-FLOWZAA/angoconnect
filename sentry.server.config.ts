/**
 * Sentry — runtime Node.js (API Routes + Server Components).
 *
 * Carregado automaticamente pelo `@sentry/nextjs`. Não importar directamente.
 *
 * Diferenças face ao cliente:
 * - Sem `replays*` (não fazem sentido no servidor).
 * - `tracesSampleRate` igual (0.1) — mantém correlação client↔server nas
 *   distributed traces.
 */
import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: process.env.NODE_ENV === 'production',
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  tracesSampleRate: 0.1,
});
