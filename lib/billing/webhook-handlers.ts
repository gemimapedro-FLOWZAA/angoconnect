/**
 * AngoConnect — Handlers de eventos Stripe
 * ===========================================================================
 * Cada handler é uma função pura `(event payload) → Promise<void>` invocada
 * pelo `app/api/billing/webhook/route.ts` depois de verificar a assinatura.
 *
 * Eventos tratados:
 *   - customer.subscription.created   → upsert em `subscriptions`
 *   - customer.subscription.updated   → upsert em `subscriptions`
 *   - customer.subscription.deleted   → marca canceled
 *   - invoice.payment_succeeded       → recarrega créditos (idempotente)
 *   - invoice.payment_failed          → log only (M2.3 trata email)
 *
 * Idempotência:
 *   - subscriptions tem unique constraint em `stripe_subscription_id` →
 *     upsert determinístico.
 *   - credits_log idempotente por (`reason`, `related_entity_id`) — verificamos
 *     manualmente antes de chamar `add_credits` para evitar dupla recarga
 *     se o Stripe reenviar o mesmo invoice.
 */

import type Stripe from 'stripe';
import { planFromPriceId, type PlanId } from '@/lib/billing/plans';
import { createAdminClient } from '@/lib/supabase/admin';

// ---------------------------------------------------------------------------
// Helpers locais
// ---------------------------------------------------------------------------

/**
 * Converte um timestamp UNIX em segundos (formato Stripe) num ISO string
 * para Postgres timestamptz. Tolera null/undefined.
 */
function unixToIso(unixSeconds: number | null | undefined): string | null {
  if (typeof unixSeconds !== 'number' || !Number.isFinite(unixSeconds)) {
    return null;
  }
  return new Date(unixSeconds * 1000).toISOString();
}

/**
 * Resolve o `workspace_id` a partir de uma subscription Stripe.
 *
 * Preferência:
 *   1. `subscription.metadata.workspace_id` (setado no Checkout Session
 *      via `subscription_data.metadata` — mas o Stripe nem sempre propaga,
 *      por isso temos fallback).
 *   2. Lookup em `subscriptions` pelo `stripe_customer_id` (entry criada
 *      por outro evento anterior — útil em updates).
 *   3. Lookup no Stripe pelo customer (último recurso): `stripe.customers.retrieve`
 *      lê `metadata.workspace_id` — mas isso é uma round-trip extra. Por
 *      agora aceitamos o fallback (2) e logamos se falhar.
 */
async function resolveWorkspaceId(
  sub: Stripe.Subscription
): Promise<string | null> {
  // (1) metadata directa.
  const fromMetadata = sub.metadata?.workspace_id;
  if (typeof fromMetadata === 'string' && fromMetadata.length > 0) {
    return fromMetadata;
  }

  // (2) lookup via customer id em subscriptions já existentes.
  const customerId =
    typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('subscriptions')
    .select('workspace_id')
    .eq('stripe_customer_id', customerId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
    .overrideTypes<{ workspace_id: string } | null, { merge: false }>();

  if (error) {
    console.error(
      '[webhook-handlers] resolveWorkspaceId lookup falhou',
      error
    );
    return null;
  }
  return data?.workspace_id ?? null;
}

/**
 * Lê `current_period_end` da subscription. Em SDK 17.x o campo está no
 * top-level (`sub.current_period_end`) — mantemos fallback para o caso
 * de o Stripe migrar o campo para `items.data[].current_period_end`
 * numa versão futura.
 */
function readCurrentPeriodEnd(sub: Stripe.Subscription): number | null {
  if (typeof sub.current_period_end === 'number') {
    return sub.current_period_end;
  }
  // Fallback (Stripe pode mover este campo para items.data no futuro).
  const itemEnd = (
    sub.items.data[0] as { current_period_end?: number } | undefined
  )?.current_period_end;
  if (typeof itemEnd === 'number') return itemEnd;
  return null;
}

// ---------------------------------------------------------------------------
// 1) customer.subscription.created  /  customer.subscription.updated
// ---------------------------------------------------------------------------

/**
 * Upsert da subscription no Supabase. Não toca em créditos — isso é
 * delegado ao handler de `invoice.payment_succeeded`, que dispara
 * imediatamente a seguir ao primeiro pagamento do checkout.
 */
export async function handleSubscriptionUpsert(
  sub: Stripe.Subscription
): Promise<void> {
  const workspaceId = await resolveWorkspaceId(sub);
  if (!workspaceId) {
    console.error(
      '[webhook-handlers] subscription sem workspace_id resolvido',
      { subscriptionId: sub.id, customerId: sub.customer }
    );
    return;
  }

  // Primeiro line item determina o plano. AngoConnect não vende add-ons
  // como line items separados.
  const priceId = sub.items.data[0]?.price.id;
  if (!priceId) {
    console.error(
      '[webhook-handlers] subscription sem items[].price.id',
      { subscriptionId: sub.id }
    );
    return;
  }

  const planId: PlanId | null = planFromPriceId(priceId);
  if (!planId) {
    console.error(
      '[webhook-handlers] price id desconhecido — sem match em STRIPE_PRICE_*',
      { priceId, subscriptionId: sub.id }
    );
    return;
  }

  // Cast localizado para `SubscriptionStatus`. O Stripe pode devolver outros
  // status (e.g. `incomplete_expired`); o check constraint em SQL
  // rejeita-os. Tratamos `incomplete_expired` como `canceled` para
  // segurança.
  let status: Stripe.Subscription.Status = sub.status;
  if (status === 'incomplete_expired' || status === 'paused') {
    status = 'canceled';
  }

  const customerId =
    typeof sub.customer === 'string' ? sub.customer : sub.customer.id;

  const admin = createAdminClient();
  const { error } = await admin.from('subscriptions').upsert(
    {
      workspace_id: workspaceId,
      stripe_customer_id: customerId,
      stripe_subscription_id: sub.id,
      stripe_price_id: priceId,
      plan: planId,
      status,
      cancel_at_period_end: sub.cancel_at_period_end,
      current_period_end: unixToIso(readCurrentPeriodEnd(sub)),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'stripe_subscription_id' }
  );

  if (error) {
    console.error(
      '[webhook-handlers] upsert subscriptions falhou',
      error,
      { subscriptionId: sub.id }
    );
    throw new Error(
      `subscription upsert failed: ${error.message ?? 'unknown'}`
    );
  }

  // O trigger SQL `sync_workspaces_plan_from_subscription` actualiza
  // `workspaces.plan` quando status='active'. Aqui não precisamos
  // de fazer mais nada.
}

// ---------------------------------------------------------------------------
// 2) customer.subscription.deleted
// ---------------------------------------------------------------------------

/**
 * O Stripe envia `deleted` quando a subscription chega ao fim (cancel
 * imediato) ou no final de um cancel-at-period-end. Marcamos a row como
 * `canceled` mas NÃO rebaixamos `workspaces.plan` aqui — isso depende da
 * regra de negócio: queremos que o user continue com features até ao final
 * do período pago. Hardening futuro: cron diário que rebaixa quando
 * `current_period_end < now()` e `status='canceled'`.
 */
export async function handleSubscriptionDeleted(
  sub: Stripe.Subscription
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from('subscriptions')
    .update({
      status: 'canceled',
      cancel_at_period_end: true,
      updated_at: new Date().toISOString(),
    })
    .eq('stripe_subscription_id', sub.id);

  if (error) {
    console.error(
      '[webhook-handlers] update canceled falhou',
      error,
      { subscriptionId: sub.id }
    );
    throw new Error(
      `subscription cancel update failed: ${error.message ?? 'unknown'}`
    );
  }
}

// ---------------------------------------------------------------------------
// 3) invoice.payment_succeeded
// ---------------------------------------------------------------------------

/**
 * Recarrega créditos no início de cada ciclo de billing.
 *
 * Filtros:
 *   - Só processa `billing_reason in ('subscription_create',
 *     'subscription_cycle')`. Ignora `subscription_update` (mudança de plano
 *     gera invoice intermédia que NÃO deve duplicar créditos) e
 *     `manual` / `subscription_threshold`.
 *
 * Idempotência:
 *   - Antes de chamar `add_credits`, verifica se já existe row em
 *     `credits_log` com `reason='plan_renewal'` e `related_entity_id=invoice.id`.
 *     Se sim, skip. Isto cobre o caso do Stripe reenviar o mesmo evento.
 */
export async function handleInvoicePaymentSucceeded(
  invoice: Stripe.Invoice
): Promise<void> {
  const reason = invoice.billing_reason;
  if (
    reason !== 'subscription_create' &&
    reason !== 'subscription_cycle'
  ) {
    console.info(
      '[webhook-handlers] invoice ignored — billing_reason fora do whitelist',
      { invoiceId: invoice.id, billing_reason: reason }
    );
    return;
  }

  if (!invoice.id) {
    console.error(
      '[webhook-handlers] invoice sem id — não pode garantir idempotência',
      { invoice }
    );
    return;
  }
  const invoiceId = invoice.id;

  const customerId =
    typeof invoice.customer === 'string'
      ? invoice.customer
      : invoice.customer?.id;

  if (!customerId) {
    console.error(
      '[webhook-handlers] invoice sem customer id — não pode resolver workspace',
      { invoiceId }
    );
    return;
  }

  // -------------------------------------------------------------------
  // Lookup workspace + plano via subscriptions.
  // -------------------------------------------------------------------
  const admin = createAdminClient();
  const { data: subRow, error: subErr } = await admin
    .from('subscriptions')
    .select('workspace_id, plan')
    .eq('stripe_customer_id', customerId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
    .overrideTypes<
      { workspace_id: string; plan: PlanId } | null,
      { merge: false }
    >();

  if (subErr) {
    console.error(
      '[webhook-handlers] lookup subscriptions p/ invoice falhou',
      subErr,
      { invoiceId, customerId }
    );
    throw new Error(
      `invoice lookup failed: ${subErr.message ?? 'unknown'}`
    );
  }
  if (!subRow) {
    // Race condition possível: o invoice chegou antes do customer.subscription.created.
    // O Stripe vai retentar este evento — ao reentrar, a subscription já deve existir.
    console.warn(
      '[webhook-handlers] invoice sem subscription correspondente — Stripe vai retentar',
      { invoiceId, customerId }
    );
    throw new Error(
      `subscription row not found for customer ${customerId} — will retry`
    );
  }

  // -------------------------------------------------------------------
  // Idempotência: checar se já creditámos este invoice.
  // -------------------------------------------------------------------
  const { data: existingLog, error: logErr } = await admin
    .from('credits_log')
    .select('id')
    .eq('reason', 'plan_renewal')
    .eq('related_entity_id', invoiceId)
    .limit(1)
    .maybeSingle();

  if (logErr) {
    console.error(
      '[webhook-handlers] check idempotência credits_log falhou',
      logErr,
      { invoiceId }
    );
    // Não rebenta — preferimos creditar duas vezes a falhar permanentemente,
    // mas isso é tradeoff: alternativa seria throw. Mantemos best-effort.
  }
  if (existingLog) {
    console.info('[webhook-handlers] invoice já processado — skip', {
      invoiceId,
    });
    return;
  }

  // -------------------------------------------------------------------
  // Chama add_credits via RPC. Usa o helper credits_for_plan para obter
  // o valor canónico (não confiamos em PLANS aqui — a SQL é fonte de
  // verdade para os créditos atribuídos).
  // -------------------------------------------------------------------
  const { data: creditAmount, error: creditCalcErr } = await admin.rpc(
    'credits_for_plan' as never,
    { p_plan: subRow.plan } as never
  );

  if (creditCalcErr) {
    console.error(
      '[webhook-handlers] RPC credits_for_plan falhou',
      creditCalcErr,
      { plan: subRow.plan }
    );
    throw new Error(
      `credits_for_plan failed: ${creditCalcErr.message ?? 'unknown'}`
    );
  }

  const amount =
    typeof creditAmount === 'number' ? creditAmount : Number(creditAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    console.error(
      '[webhook-handlers] credits_for_plan devolveu valor inválido',
      { plan: subRow.plan, creditAmount }
    );
    return;
  }

  // Cast localizado: createAdminClient<Database>.rpc ainda não infere
  // bem as funcs definidas no Database type stub. Mesmo padrão usado em
  // `app/api/workspaces/route.ts` para `create_workspace_with_owner`.
  const { error: addErr } = await admin.rpc(
    'add_credits' as never,
    {
      workspace_id: subRow.workspace_id,
      amount,
      reason: 'plan_renewal',
      performed_by: null,
      related_entity_type: 'invoice',
      related_entity_id: invoiceId,
    } as never
  );

  if (addErr) {
    console.error(
      '[webhook-handlers] RPC add_credits falhou',
      addErr,
      { invoiceId, workspaceId: subRow.workspace_id, amount }
    );
    throw new Error(
      `add_credits failed: ${addErr.message ?? 'unknown'}`
    );
  }

  console.info('[webhook-handlers] créditos atribuídos via invoice', {
    invoiceId,
    workspaceId: subRow.workspace_id,
    plan: subRow.plan,
    amount,
  });
}

// ---------------------------------------------------------------------------
// 4) invoice.payment_failed
// ---------------------------------------------------------------------------

/**
 * Apenas loga. O Stripe vai:
 *   - Retentar automaticamente (Smart Retries) durante alguns dias.
 *   - Eventualmente mover a subscription para `past_due` ou `unpaid` ou
 *     `canceled`, o que dispara `customer.subscription.updated` /
 *     `.deleted` que tratamos noutro handler.
 *
 * M2.3 vai adicionar:
 *   - Email ao owner via Resend.
 *   - Aviso visual no dashboard.
 */
export async function handleInvoicePaymentFailed(
  invoice: Stripe.Invoice
): Promise<void> {
  const customerId =
    typeof invoice.customer === 'string'
      ? invoice.customer
      : invoice.customer?.id;
  console.warn('[webhook-handlers] invoice.payment_failed', {
    invoiceId: invoice.id,
    customerId,
    attemptCount: invoice.attempt_count,
    nextPaymentAttempt: invoice.next_payment_attempt,
  });
  // Sem operações de DB por agora.
}
