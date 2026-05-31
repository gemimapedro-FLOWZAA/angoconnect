/**
 * AngoConnect — GET /api/health
 * ===========================================================================
 * Healthcheck endpoint para Vercel monitoring + uptime trackers (UptimeRobot,
 * Pingdom, etc.). Devolve 200 com timestamp + commit SHA (se VERCEL_GIT_COMMIT_SHA
 * estiver definida) para confirmar deployment activo.
 *
 * **NÃO** expõe estado de Supabase/Redis — para isso, criar `/api/health/deep`
 * que faça round-trip a esses serviços (cuidado: invalida cache CDN).
 */

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json(
    {
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version ?? 'unknown',
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
      env: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    },
    {
      status: 200,
      headers: {
        'cache-control': 'no-store, max-age=0',
      },
    }
  );
}
