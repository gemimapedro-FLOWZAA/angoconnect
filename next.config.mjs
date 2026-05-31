import { withSentryConfig } from '@sentry/nextjs';
import bundleAnalyzer from '@next/bundle-analyzer';

/**
 * Config Next.js base do AngoConnect.
 *
 * Wrap order: `withSentryConfig` (mais interno — injecta plugin do webpack)
 * primeiro, depois `withBundleAnalyzer` (mais externo — só intercepta o build
 * quando `ANALYZE=true`).
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // NB: NÃO usar `output: 'standalone'` aqui — o Dockerfile copia .next +
  // node_modules em modo regular. Mudar para standalone exige actualizar
  // o Dockerfile para copiar de `.next/standalone/`.
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
  // Single-domain self-host: o browser fala com Supabase via /supabase/* na
  // mesma origem. Em runtime, Next reescreve para o Kong dentro da rede
  // docker. Activado apenas quando SUPABASE_INTERNAL_URL está definido.
  async rewrites() {
    const internalSupabase = process.env.SUPABASE_INTERNAL_URL;
    if (!internalSupabase) return [];
    return [
      {
        source: '/supabase/:path*',
        destination: `${internalSupabase}/:path*`,
      },
    ];
  },
};

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === 'true',
});

const sentryConfig = withSentryConfig(nextConfig, {
  // Silencioso fora de CI — não polui o output do `next dev`.
  silent: !process.env.CI,
  // org e project são lidos do env (SENTRY_ORG / SENTRY_PROJECT) ou do
  // ficheiro `.sentryclirc`. Não hardcoded aqui para permitir múltiplos
  // projectos sem alterar código.
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  // Auth token apenas em CI (upload de sourcemaps). Sem token, o plugin
  // emite warning e continua — não falha o build local.
  authToken: process.env.SENTRY_AUTH_TOKEN,
  // Túnel reduz noise de adblockers no cliente.
  tunnelRoute: '/monitoring',
  // Reduz size injectando apenas o que precisamos.
  widenClientFileUpload: true,
  hideSourceMaps: true,
  disableLogger: true,
});

export default withBundleAnalyzer(sentryConfig);
