/**
 * AngoConnect — POST /api/billing/checkout
 * ===========================================================================
 * Cria uma Stripe Checkout Session em modo `subscription` para o plano
 * pedido. Retorna `{ url, sessionId }` — o Frontend faz redirect para `url`.
 *
 * Fluxo:
 *   1. Auth (server client). Sem user → 401.
 *   2. Body Zod: { workspaceId: uuid, planId: PlanId }.
 *   3. Workspace membership check (mesmo padrão que `/api/apify/trigger`).
 *   4. Get-or-create Stripe Customer (por workspace, não por user).
 *   5. `stripe.checkout.sessions.create({ mode: 'subscription', ... })`.
 *   6. Resposta: apiOk({ url, sessionId }).
 *
 * Erros mapeados:
 *   - UNAUTHENTICATED          401
 *   - INVALID_JSON / INVALID_BODY   400
 *   - NOT_WORKSPACE_MEMBER     403
 *   - PRICE_NOT_CONFIGURED     500   (env var STRIPE_PRICE_* ausente)
 *   - STRIPE_ERROR             502
 */

import { NextResponse, type NextRequest } from 'next/server';
import Stripe from 'stripe';
import { z } from 'zod';
import { apiError, apiOk } from '@/lib/api-response';
import {
  PLAN_IDS,
  getStripePriceId,
  type PlanId,
} from '@/lib/billing/plans';
import { getOrCreateStripeCustomer } from '@/lib/billing/stripe-customer';
import { stripe } from '@/lib/stripe';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Validação Zod
// ---------------------------------------------------------------------------

const checkoutBodySchema = z.object({
  workspaceId: z.string().uuid({ message: 'workspaceId tem de ser UUID' }),
  planId: z.enum(PLAN_IDS as readonly [PlanId, ...PlanId[]]),
});

type CheckoutBody = z.infer<typeof checkoutBodySchema>;

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

  const parsed = checkoutBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return apiError('Body inválido — ver issues', 400, 'INVALID_BODY', {
      issues: parsed.error.issues,
    });
  }
  const body: CheckoutBody = parsed.data;

  // 3) Workspace membership -------------------------------------------------
  const { data: member, error: memberErr } = await supabase
    .from('workspace_members')
    .select('workspace_id, role')
    .eq('workspace_id', body.workspaceId)
    .eq('user_id', user.id)
    .maybeSingle()
    .overrideTypes<
      { workspace_id: string; role: string } | null,
      { merge: false }
    >();

  if (memberErr) {
    console.error(
      '[billing/checkout] erro a verificar workspace_members',
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
  // Nota: por agora qualquer member pode iniciar checkout. Endurecer para
  // owner/admin em M2.3 se a regra mudar.

  // 4) Resolver Stripe Price + Workspace name -------------------------------
  let priceId: string;
  try {
    priceId = getStripePriceId(body.planId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[billing/checkout] price não configurado', message);
    return apiError(
      'Plano não está configurado no servidor',
      500,
      'PRICE_NOT_CONFIGURED'
    );
  }

  // Nome do workspace é opcional para o Stripe customer — buscamos
  // best-effort. Se falhar, seguimos com nome vazio.
  const { data: workspaceRow } = await supabase
    .from('workspaces')
    .select('name')
    .eq('id', body.workspaceId)
    .maybeSingle()
    .overrideTypes<{ name: string } | null, { merge: false }>();

  // 5) Get-or-create Stripe Customer ----------------------------------------
  let customerId: string;
  try {
    const result = await getOrCreateStripeCustomer({
      workspaceId: body.workspaceId,
      email: user.email ?? `workspace-${body.workspaceId}@angoconnect.local`,
      workspaceName: workspaceRow?.name ?? null,
    });
    customerId = result.customerId;
  } catch (err) {
    return handleStripeError(err, 'get-or-create customer');
  }

  // 6) Checkout Session -----------------------------------------------------
  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, '') ??
    'http://localhost:3000';

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${appUrl}/billing?success=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/billing?canceled=1`,
      // `client_reference_id` aparece no webhook checkout.session.completed
      // — útil para reconciliação se um dia precisarmos.
      client_reference_id: body.workspaceId,
      metadata: {
        workspace_id: body.workspaceId,
        plan_id: body.planId,
      },
      // `subscription_data.metadata` propaga para a Subscription criada
      // — usamos no webhook para resolver workspace sem round-trip extra.
      subscription_data: {
        metadata: {
          workspace_id: body.workspaceId,
          plan_id: body.planId,
        },
      },
      allow_promotion_codes: true,
    });
  } catch (err) {
    return handleStripeError(err, 'create checkout session');
  }

  if (!session.url) {
    console.error('[billing/checkout] session criada sem url', {
      sessionId: session.id,
    });
    return apiError(
      'Stripe não devolveu URL de checkout',
      502,
      'STRIPE_NO_URL'
    );
  }

  return apiOk({
    url: session.url,
    sessionId: session.id,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function handleStripeError(
  err: unknown,
  context: string
): NextResponse {
  if (err instanceof Stripe.errors.StripeError) {
    console.error(`[billing/checkout] Stripe error (${context})`, {
      type: err.type,
      code: err.code,
      message: err.message,
    });
    return apiError(
      `Stripe falhou (${context}): ${err.message}`,
      502,
      'STRIPE_ERROR',
      { stripeCode: err.code ?? null, stripeType: err.type }
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[billing/checkout] erro inesperado (${context})`, message);
  return apiError(
    `Falha inesperada: ${message}`,
    500,
    'UNEXPECTED_ERROR'
  );
}
