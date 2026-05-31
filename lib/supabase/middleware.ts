/**
 * AngoConnect — Middleware Supabase (auth gate + workspace check)
 * ===========================================================================
 * Estende o `updateSession` recomendado pelo Supabase com regras de
 * autorização:
 *
 *   - Rotas públicas (sem auth obrigatória):
 *       /                           landing
 *       /login                      formulário login
 *       /signup                     formulário signup
 *       /auth/callback              callback OAuth/PKCE
 *       /api/apify/webhook          webhook server-to-server (assinado)
 *
 *   - Rotas autenticadas (tudo o resto):
 *       Sem sessão              → 302 /login?next=<path>
 *       Com sessão + sem WS     → 302 /onboarding (excepto se já estiver lá
 *                                 ou em rotas de auth/api)
 *       Com sessão em /login    → 302 /search    (não faz sentido reverter)
 *       Com sessão em /signup   → 302 /search
 *
 * Notas:
 *  - A verificação de workspace faz UMA query por request a rotas protegidas.
 *    Para reduzir latência poderíamos cachear num cookie httpOnly assinado
 *    (`ws_count`) — adiado para milestone de hardening (ver relatório).
 *  - APIs internas (/api/*) que não sejam o webhook exigem sessão; respondemos
 *    401 JSON em vez de redirect para não confundir clientes.
 */

import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import type { Database } from '@/lib/supabase/types';

type CookieToSet = { name: string; value: string; options: CookieOptions };

// ---------------------------------------------------------------------------
// Configuração de rotas
// ---------------------------------------------------------------------------

/** Rotas exactas que NÃO requerem sessão. */
const PUBLIC_EXACT = new Set<string>([
  '/',
  '/login',
  '/signup',
  '/auth/callback',
]);

/**
 * Prefixos que NÃO requerem sessão.
 * - Webhooks: validados por assinatura HMAC ao nível do handler
 * - /api/health: healthcheck para uptime monitors
 * - /api/cron/*: protegido por Bearer CRON_SECRET ao nível do handler
 */
const PUBLIC_PREFIXES = [
  '/api/apify/webhook',
  '/api/billing/webhook',
  '/api/email/webhook',
  '/api/whatsapp/webhook',
  '/api/health',
  '/api/cron/',
];

/** Páginas onde users autenticados NÃO devem aterrar (reentry). */
const AUTH_ENTRY_PAGES = new Set<string>(['/login', '/signup']);

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function isApiPath(pathname: string): boolean {
  return pathname.startsWith('/api/');
}

function isAuthCallbackOrOnboarding(pathname: string): boolean {
  return (
    pathname.startsWith('/auth/') ||
    pathname === '/onboarding' ||
    pathname.startsWith('/onboarding/')
  );
}

// ---------------------------------------------------------------------------
// updateSession
// ---------------------------------------------------------------------------

export async function updateSession(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          cookiesToSet.forEach(({ name, value }: CookieToSet) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }: CookieToSet) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Refresca a sessão e devolve o user actual.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // -----------------------------------------------------------------------
  // Caso 1: rota pública — devolve sem gate.
  // -----------------------------------------------------------------------
  if (isPublicPath(pathname)) {
    // Excepção: user autenticado a tentar abrir /login ou /signup → /search
    if (user && AUTH_ENTRY_PAGES.has(pathname)) {
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = '/search';
      redirectUrl.search = '';
      return NextResponse.redirect(redirectUrl);
    }
    return supabaseResponse;
  }

  // -----------------------------------------------------------------------
  // Caso 2: rota protegida, sem sessão → 401 (API) ou redirect (página).
  // -----------------------------------------------------------------------
  if (!user) {
    if (isApiPath(pathname)) {
      return NextResponse.json(
        { data: null, error: { message: 'Não autenticado', code: 'UNAUTHENTICATED' } },
        { status: 401 }
      );
    }
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = '/login';
    redirectUrl.search = `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(redirectUrl);
  }

  // -----------------------------------------------------------------------
  // Caso 3: sessão ok — verifica workspace membership, salvo se já está em
  //         rotas que servem precisamente para criar o primeiro workspace
  //         (auth/* ou onboarding) ou em APIs (a API decide isolamento ela
  //         mesma, e POST /api/workspaces existe justamente para criar).
  // -----------------------------------------------------------------------
  if (isApiPath(pathname) || isAuthCallbackOrOnboarding(pathname)) {
    return supabaseResponse;
  }

  // Query rápida: tem pelo menos 1 workspace?
  const { data: memberships, error: membershipErr } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .limit(1);

  if (membershipErr) {
    // Em caso de erro de RLS/DB, não bloqueia hard — deixa o pedido seguir.
    // O endpoint downstream falhará com mensagem mais clara se for o caso.
    console.error('[middleware] workspace_members check falhou', membershipErr);
    return supabaseResponse;
  }

  const hasWorkspace = (memberships?.length ?? 0) > 0;
  if (!hasWorkspace) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = '/onboarding';
    redirectUrl.search = '';
    return NextResponse.redirect(redirectUrl);
  }

  return supabaseResponse;
}
