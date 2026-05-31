/**
 * Sentry — runtime do browser.
 *
 * Carregado automaticamente pelo `@sentry/nextjs` via `withSentryConfig` no
 * `next.config.mjs`. Não importar este ficheiro directamente.
 *
 * Decisões:
 * - `enabled: production only` — em dev queremos ver os erros no DevTools,
 *   não a poluir o projecto Sentry.
 * - `tracesSampleRate: 0.1` — 10% de transactions chega para detectar
 *   regressões de performance sem custos elevados.
 * - `environment` deriva de `VERCEL_ENV` (preview/production) com fallback
 *   para `NODE_ENV`.
 */
import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: process.env.NODE_ENV === 'production',
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,
  tracesSampleRate: 0.1,
  // Replay desligado por defeito — custo elevado em sessões longas. Ligar
  // selectivamente apenas em incidentes via Sentry UI ou query params.
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
});
