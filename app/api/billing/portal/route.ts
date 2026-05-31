/**
 * AngoConnect — POST /api/billing/portal
 * ===========================================================================
 * Cria uma Stripe Billing Portal Session para gestão de subscrição:
 * cancel, change plan, update payment method, ver invoices.
 *
 * Body: { workspaceId: uuid }
 *
 * Pré-requisitos:
 *   - O workspace tem de já ter um `stripe_customer_id` em `subscriptions`
 *     (criado pelo primeiro checkout). Se não, devolve 400 NO_CUSTOMER.
 *   - Customer Portal tem de estar configurado em Stripe Dashboard
 *     (Settings → Billing → Customer portal). Se não estiver, o SDK lança
 *     "No configuration provided" — propagamos como STRIPE_ERROR 502.
 */

import { NextResponse, type NextRequest } from 'next/server';
import Stripe from 'stripe';
import { z } from 'zod';
import { apiError, apiOk } from '@/lib/api-response';
import { stripe } from '@/lib/stripe';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Validação
// ---------------------------------------------------------------------------

const portalBodySchema = z.object({
  workspaceId: z.string().uuid({ message: 'workspaceId tem de ser UUID' }),
});

type PortalBody = z.infer<typeof portalBodySchema>;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1) Auth -----------------------------------------------------------------
  const supabase = createClient();
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    return apiError('Não autenticado', 401, 'UNAUTHENTICATED');
  }

  // 2) Body Zod -------------------------------------------------------------
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return apiError('Body não é JSON válido', 400, 'INVALID_JSON');
  }

  const parsed = portalBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return apiError('Body inválido — ver issues', 400, 'INVALID_BODY', {
      issues: parsed.error.issues,
    });
  }
  const body: PortalBody = parsed.data;

  // 3) Workspace membership -------------------------------------------------
  const { data: member, error: memberErr } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('workspace_id', body.workspaceId)
    .eq('user_id', user.id)
    .maybeSingle()
    .overrideTypes<{ workspace_id: string } | null, { merge: false }>();

  if (memberErr) {
    console.error(
      '[billing/portal] erro a verificar workspace_members',
      memberErr
    );
    return apiError(
      'Falha a verificar permissões do workspace',
      500,
      'WORKSPACE_CHECK_FAILED'
    );
  }
  if (!member) {
    return apiError(
      'Não é membro deste workspace',
      403,
      'NOT_WORKSPACE_MEMBER'
    );
  }

  // 4) Lookup stripe_customer_id (admin client porque a row pode ter sido
  // criada por webhook com service_role — RLS pode bloquear leitura
  // anónima dependendo de policies).
  const admin = createAdminClient();
  const { data: subRow, error: lookupErr } = await admin
    .from('subscriptions')
    .select('stripe_customer_id')
    .eq('workspace_id', body.workspaceId)
    .not('stripe_customer_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
    .overrideTypes<
      { stripe_customer_id: string | null } | null,
      { merge: false }
    >();

  if (lookupErr) {
    console.error(
      '[billing/portal] lookup subscriptions falhou',
      lookupErr
    );
    return apiError(
      'Falha a procurar subscrição',
      500,
      'SUBSCRIPTION_LOOKUP_FAILED'
    );
  }
  const customerId = subRow?.stripe_customer_id ?? null;
  if (!customerId) {
    return apiError(
      'Workspace não tem subscrição activa — fazer checkout primeiro',
      400,
      'NO_CUSTOMER'
    );
  }

  // 5) Billing Portal Session -----------------------------------------------
  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, '') ??
    'http://localhost:3000';

  let session: Stripe.BillingPortal.Session;
  try {
    session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${appUrl}/billing`,
    });
  } catch (err) {
    if (err instanceof Stripe.errors.StripeError) {
      console.error('[billing/portal] Stripe error', {
        type: err.type,
        code: err.code,
        message: err.message,
      });
      return apiError(
        `Stripe falhou: ${err.message}`,
        502,
        'STRIPE_ERROR',
        { stripeCode: err.code ?? null, stripeType: err.type }
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error('[billing/portal] erro inesperado', message);
    return apiError(
      `Falha inesperada: ${message}`,
      500,
      'UNEXPECTED_ERROR'
    );
  }

  return apiOk({ url: session.url });
}
