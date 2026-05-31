/**
 * AngoConnect — Catálogo canónico de planos (Source of Truth)
 * ===========================================================================
 * Estes objectos são a única fonte de verdade do produto para preço,
 * créditos, seats e features de cada plano. Stripe Prices ficam fora do
 * código (env vars) — só os referenciamos por nome.
 *
 * Esta tabela é importada por:
 *   - `app/api/billing/checkout/route.ts` → obter o `stripe price id` por
 *      `planId`.
 *   - `lib/billing/webhook-handlers.ts`    → fazer reverse lookup
 *      `stripe price id` → `planId` a partir de eventos Stripe.
 *   - `(dashboard)/billing` (Frontend)     → render do pricing table.
 *
 * Mudanças aqui têm de ser acompanhadas de:
 *   - Migration que actualize `credits_for_plan(plan)` se mudarmos os créditos
 *     base (Database Architect).
 *   - Recriação dos prices no Stripe se o preço mudar.
 */

export interface PlanDefinition {
  /** Identificador interno (snake_case-free, lowercase). */
  id: PlanId;
  /** Nome amigável apresentado na UI. */
  name: string;
  /** Preço mensal em USD (cobrança real é Stripe-side). */
  priceMonthly: number;
  /** Créditos atribuídos por ciclo. `pro` usa um valor sentinel "ilimitado". */
  creditsIncluded: number;
  /** Seats incluídos (utilizadores). `pro` usa um sentinel para "ilimitado". */
  seatsIncluded: number;
  /** Strings em PT para o pricing table — Frontend usa estas directamente. */
  features: readonly string[];
  /**
   * Nome da env var que contém o Stripe `price_xxx`. Mantemos os IDs reais
   * fora do código — fácil rotacionar e diferente por ambiente
   * (test/live).
   */
  stripePriceEnv: StripePriceEnvName;
}

export type StripePriceEnvName =
  | 'STRIPE_PRICE_STARTER'
  | 'STRIPE_PRICE_GROWTH'
  | 'STRIPE_PRICE_PRO';

export const PLANS = {
  starter: {
    id: 'starter',
    name: 'Starter',
    priceMonthly: 49,
    creditsIncluded: 500,
    seatsIncluded: 1,
    features: [
      '500 créditos/mês',
      '1 utilizador',
      'Suporte por email',
    ],
    stripePriceEnv: 'STRIPE_PRICE_STARTER',
  },
  growth: {
    id: 'growth',
    name: 'Growth',
    priceMonthly: 149,
    creditsIncluded: 2000,
    seatsIncluded: 5,
    features: [
      '2000 créditos/mês',
      '5 utilizadores',
      'Sequências ilimitadas',
      'Integrações Apify',
    ],
    stripePriceEnv: 'STRIPE_PRICE_GROWTH',
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceMonthly: 399,
    // Sentinel "ilimitado" — alinhado com a função SQL `credits_for_plan`.
    creditsIncluded: 999999,
    seatsIncluded: 999,
    features: [
      'Créditos ilimitados',
      'Utilizadores ilimitados',
      'API access',
      'IA copy generation',
      'Suporte prioritário',
    ],
    stripePriceEnv: 'STRIPE_PRICE_PRO',
  },
} as const satisfies Record<string, PlanDefinition>;

export type PlanId = 'starter' | 'growth' | 'pro';

/** Lista ordenada (starter → growth → pro) para iteração estável. */
export const PLAN_IDS: readonly PlanId[] = ['starter', 'growth', 'pro'];

/**
 * Devolve o `price_xxx` do Stripe para o `planId`.
 *
 * Lança `Error` se a env var não estiver configurada — preferimos crashar
 * cedo a iniciar um checkout que vai falhar no Stripe com erro confuso.
 */
export function getStripePriceId(planId: PlanId): string {
  const envName = PLANS[planId].stripePriceEnv;
  const id = process.env[envName];
  if (!id) {
    throw new Error(
      `Missing env var ${envName} for plan ${planId}. ` +
        'Adiciona o STRIPE_PRICE_* ao .env.local e ao Vercel.'
    );
  }
  return id;
}

/**
 * Reverse lookup: a partir de um Stripe `price_xxx` (do webhook), descobre
 * o `planId` correspondente. Retorna `null` se não bater com nenhum dos
 * planos configurados — o caller deve logar e ignorar.
 */
export function planFromPriceId(priceId: string): PlanId | null {
  for (const planId of PLAN_IDS) {
    const envName = PLANS[planId].stripePriceEnv;
    if (process.env[envName] === priceId) return planId;
  }
  return null;
}
