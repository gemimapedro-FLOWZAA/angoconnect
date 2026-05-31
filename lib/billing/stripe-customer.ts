/**
 * AngoConnect — Helper: obter/criar Stripe Customer por workspace
 * ===========================================================================
 * Encapsula a lógica de "tem este workspace um Stripe customer? Se não, cria".
 * O Customer Stripe é por *workspace*, não por user, porque os planos seguem
 * o workspace e múltiplos users podem partilhar a subscrição.
 *
 * Estratégia de lookup:
 *   1. SELECT em `subscriptions` (a tabela onde guardamos o customer id).
 *   2. Se houver row com `stripe_customer_id` não-null → reuse.
 *   3. Senão → `stripe.customers.create(...)`. Não persistimos nada aqui
 *      (a persistência acontece quando o Checkout completar e o webhook
 *      `customer.subscription.created` disparar — esse handler upserta a
 *      row com customer_id + subscription_id de uma só vez).
 *
 * Notas:
 *   - Usa o admin client (service_role). O caller já validou que o user é
 *     membro do workspace antes de chamar.
 *   - Inclui `metadata.workspace_id` no Customer Stripe para facilitar
 *     debug e queries reverse no Stripe Dashboard.
 */

import type Stripe from 'stripe';
import { stripe } from '@/lib/stripe';
import { createAdminClient } from '@/lib/supabase/admin';

interface GetOrCreateCustomerArgs {
  workspaceId: string;
  /** Email do user que iniciou o checkout — preferido como email do customer. */
  email: string;
  /** Nome opcional do workspace para o Stripe (aparece na invoice). */
  workspaceName?: string | null;
}

interface CustomerLookupResult {
  customerId: string;
  /**
   * `true` se acabámos de criar agora. Útil para logs/analytics, mas o
   * caller normalmente ignora.
   */
  created: boolean;
}

/**
 * Devolve o `stripe_customer_id` para o workspace, criando-o se necessário.
 *
 * @throws Stripe.errors.StripeError se a API Stripe falhar.
 */
export async function getOrCreateStripeCustomer(
  args: GetOrCreateCustomerArgs
): Promise<CustomerLookupResult> {
  const admin = createAdminClient();

  // ---------------------------------------------------------------------
  // 1) Tentar reutilizar customer existente.
  // ---------------------------------------------------------------------
  // Pode existir mais que uma row em `subscriptions` para o mesmo workspace
  // se o utilizador subscreveu, cancelou e voltou a subscrever — neste caso
  // todas devem partilhar o mesmo `stripe_customer_id`. Apanhamos a mais
  // recente.
  const { data: existingRow, error: lookupErr } = await admin
    .from('subscriptions')
    .select('stripe_customer_id')
    .eq('workspace_id', args.workspaceId)
    .not('stripe_customer_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
    .overrideTypes<{ stripe_customer_id: string | null } | null, { merge: false }>();

  if (lookupErr) {
    console.error(
      '[stripe-customer] lookup subscriptions falhou',
      lookupErr
    );
    // Não bloqueamos — o pior caso é criarmos um customer duplicado, o que
    // o caller pode reconciliar manualmente no Stripe Dashboard.
  }

  const existingId = existingRow?.stripe_customer_id ?? null;
  if (existingId) {
    return { customerId: existingId, created: false };
  }

  // ---------------------------------------------------------------------
  // 2) Criar novo customer no Stripe.
  // ---------------------------------------------------------------------
  const params: Stripe.CustomerCreateParams = {
    email: args.email,
    metadata: {
      workspace_id: args.workspaceId,
    },
  };
  if (args.workspaceName) {
    params.name = args.workspaceName;
  }

  const customer = await stripe.customers.create(params);
  return { customerId: customer.id, created: true };
}
