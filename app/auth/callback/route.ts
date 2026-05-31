/**
 * AngoConnect — Callback OAuth (PKCE) do Supabase Auth
 * ===========================================================================
 * `GET /auth/callback?code=<pkce_code>&next=<redirect_path>`
 *
 * Fluxo:
 *   1. Recebe `code` da Supabase OAuth (Google) ou magic-link email confirm.
 *   2. Troca o `code` por sessão (`exchangeCodeForSession`).
 *   3. Verifica se o user já é membro de algum workspace:
 *        - Sim  → redireciona para `next` (default `/search`).
 *        - Não  → redireciona para `/onboarding` (cria primeiro workspace).
 *
 * Erros possíveis:
 *   - `missing_code` — querystring sem `code`.
 *   - `<message>`    — erro do `exchangeCodeForSession` propagado encoded.
 *   - `no_session`   — exchange ok mas `getUser()` devolveu null (race?).
 *
 * Em qualquer erro, redireciona para `/login?error=<code>`.
 *
 * Nota: a verificação de workspace usa o cliente RLS-aware (server). Como
 * o utilizador acabou de autenticar-se, a query atinge a sua própria
 * `workspace_members` — RLS permite (policy `workspace_members_select_same_ws`
 * apoia-se em `is_workspace_member`, mas o user já cumpre essa condição se
 * tiver pelo menos um row).
 */

import { type NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const nextParam = searchParams.get('next');
  // Apenas paths locais (defesa contra open redirect).
  const next =
    nextParam && nextParam.startsWith('/') && !nextParam.startsWith('//')
      ? nextParam
      : '/search';

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`);
  }

  const supabase = createClient();
  const { error: exchangeErr } = await supabase.auth.exchangeCodeForSession(code);

  if (exchangeErr) {
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent(exchangeErr.message)}`
    );
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.redirect(`${origin}/login?error=no_session`);
  }

  const { data: memberships, error: membershipErr } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .limit(1);

  if (membershipErr) {
    console.error('[auth-callback] erro a ler workspace_members', membershipErr);
    // Não bloqueia o utilizador — manda para onboarding como fallback seguro.
    return NextResponse.redirect(`${origin}/onboarding`);
  }

  const hasWorkspace = (memberships?.length ?? 0) > 0;
  return NextResponse.redirect(
    `${origin}${hasWorkspace ? next : '/onboarding'}`
  );
}
