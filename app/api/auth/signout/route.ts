/**
 * AngoConnect — Sign-out server-side
 * ===========================================================================
 * `POST /api/auth/signout`
 *
 * Invalida a sessão Supabase server-side (revoga refresh tokens e limpa os
 * cookies sb-*-auth-token via o helper SSR). Usar este endpoint em vez de
 * `supabase.auth.signOut()` no cliente:
 *
 *   1. Protege contra CSRF: como é POST, só pode ser invocado via fetch
 *      com `credentials: 'same-origin'` da nossa origem.
 *   2. Garante que o cookie HttpOnly é limpo correctamente (o cliente
 *      browser não tem acesso ao cookie HttpOnly).
 *
 * Responde 302 → /login para que possa ser usado também via
 * `<form method="post" action="/api/auth/signout">`. Em casos `fetch`
 * o cliente segue o redirect automaticamente ou navega manualmente.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = createClient();
  // signOut tolera ausência de sessão (idempotente).
  await supabase.auth.signOut();

  const { origin } = new URL(request.url);
  return NextResponse.redirect(`${origin}/login`, { status: 302 });
}
