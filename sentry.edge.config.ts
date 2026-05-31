/**
 * Sentry — runtime Edge (middleware + edge API routes).
 *
 * Subset do server config: o runtime Edge não suporta todos os integrations
 * (não há fs, http nativos, etc.). O SDK lida com isto internamente, mas
 * mantemos o init mínimo para garantir compatibilidade.
 */
import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: process.env.NODE_ENV === 'production',
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  tracesSampleRate: 0.1,
});
