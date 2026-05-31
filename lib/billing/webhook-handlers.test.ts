/**
 * AngoConnect — Testes de integração dos handlers Stripe (M4.1)
 *
 * Mockamos o `createAdminClient` para devolver um query-builder controlável
 * por teste. Garantimos:
 *   - upsert correcto em `subscriptions`
 *   - chamada a `credits_for_plan` + `add_credits` no `invoice.payment_succeeded`
 *   - skip de `billing_reason='subscription_update'`
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock do admin client
// ---------------------------------------------------------------------------

type AnyFn = (...args: unknown[]) => unknown;

interface MockBuilder {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
  overrideTypes: ReturnType<typeof vi.fn>;
}

interface MockClient {
  from: ReturnType<typeof vi.fn>;
  rpc: ReturnType<typeof vi.fn>;
  _builders: Map<string, MockBuilder>;
}

function makeChainable(returnValue: unknown): MockBuilder {
  // Cada chamada chainável devolve o mesmo objecto, excepto os terminais
  // (`maybeSingle`, `overrideTypes`, `upsert.eq`) que resolvem para o valor.
  const builder: Partial<MockBuilder> = {};
  const self = builder as MockBuilder;
  const passthrough = (): MockBuilder => self;

  builder.select = vi.fn(passthrough);
  builder.eq = vi.fn(passthrough);
  builder.order = vi.fn(passthrough);
  builder.limit = vi.fn(passthrough);
  builder.overrideTypes = vi.fn(passthrough);
  builder.upsert = vi.fn(() => Promise.resolve(returnValue));
  builder.update = vi.fn(() => self);
  builder.insert = vi.fn(() => Promise.resolve(returnValue));
  // maybeSingle devolve um thenable que também expõe `overrideTypes` para
  // espelhar o supabase-js (PostgrestBuilder é simultaneamente promise + builder).
  builder.maybeSingle = vi.fn(() => {
    const p = Promise.resolve(returnValue) as Promise<unknown> & {
      overrideTypes: () => Promise<unknown>;
    };
    p.overrideTypes = () => Promise.resolve(returnValue);
    return p as unknown as ReturnType<typeof Promise.resolve>;
  });

  return self;
}

function makeMockClient(): MockClient {
  const builders = new Map<string, MockBuilder>();
  const client: Partial<MockClient> = { _builders: builders };
  client.from = vi.fn((table: string) => {
    if (!builders.has(table)) {
      builders.set(table, makeChainable({ data: null, error: null }));
    }
    const b = builders.get(table);
    if (!b) throw new Error('unreachable');
    return b;
  });
  client.rpc = vi.fn();
  return client as MockClient;
}

const mockClient: MockClient = makeMockClient();

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => mockClient,
}));

// Stripe price env vars precisam de bater os defaults do `.env.test`.
process.env.STRIPE_PRICE_STARTER = 'price_starter_test';
process.env.STRIPE_PRICE_GROWTH = 'price_growth_test';
process.env.STRIPE_PRICE_PRO = 'price_pro_test';

// Import depois do mock.
import type Stripe from 'stripe';
import {
  handleInvoicePaymentSucceeded,
  handleSubscriptionUpsert,
} from './webhook-handlers';

// ---------------------------------------------------------------------------
// Helpers de fixtures
// ---------------------------------------------------------------------------

function fakeSubscription(overrides: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
  return {
    id: 'sub_123',
    customer: 'cus_123',
    status: 'active',
    cancel_at_period_end: false,
    current_period_end: 1900000000,
    metadata: { workspace_id: 'ws_1' },
    items: {
      data: [
        { price: { id: 'price_starter_test' } } as Stripe.SubscriptionItem,
      ],
    },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

function fakeInvoice(overrides: Partial<Stripe.Invoice> = {}): Stripe.Invoice {
  return {
    id: 'in_123',
    customer: 'cus_123',
    billing_reason: 'subscription_cycle',
    attempt_count: 1,
    next_payment_attempt: null,
    ...overrides,
  } as unknown as Stripe.Invoice;
}

// ---------------------------------------------------------------------------
// Reset entre testes
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockClient._builders.clear();
  mockClient.from.mockClear();
  mockClient.rpc.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleSubscriptionUpsert', () => {
  it('faz upsert em subscriptions com workspace_id, plan e price_id correctos', async () => {
    // O upsert resolve para { error: null }.
    const subsBuilder = makeChainable({ error: null });
    mockClient._builders.set('subscriptions', subsBuilder);
    mockClient.from.mockImplementation((t: unknown) => {
      const table = String(t);
      if (!mockClient._builders.has(table)) {
        mockClient._builders.set(table, makeChainable({ data: null, error: null }));
      }
      return mockClient._builders.get(table) as MockBuilder;
    });

    await handleSubscriptionUpsert(fakeSubscription());

    expect(subsBuilder.upsert).toHaveBeenCalledTimes(1);
    const callArgs = subsBuilder.upsert.mock.calls[0];
    expect(callArgs).toBeDefined();
    const payload = (callArgs as unknown[])[0] as {
      workspace_id: string;
      stripe_subscription_id: string;
      stripe_price_id: string;
      plan: string;
    };
    expect(payload.workspace_id).toBe('ws_1');
    expect(payload.stripe_subscription_id).toBe('sub_123');
    expect(payload.stripe_price_id).toBe('price_starter_test');
    expect(payload.plan).toBe('starter');
  });
});

describe('handleInvoicePaymentSucceeded', () => {
  it('chama credits_for_plan + add_credits com o valor devolvido pelo RPC', async () => {
    // subscriptions.maybeSingle → workspace_id + plano
    const subsBuilder = makeChainable({
      data: { workspace_id: 'ws_1', plan: 'starter' },
      error: null,
    });
    // credits_log.maybeSingle → nada (idempotência: ainda não creditado)
    const creditsLogBuilder = makeChainable({ data: null, error: null });

    mockClient._builders.set('subscriptions', subsBuilder);
    mockClient._builders.set('credits_log', creditsLogBuilder);
    mockClient.from.mockImplementation((t: unknown) => {
      const table = String(t);
      if (!mockClient._builders.has(table)) {
        mockClient._builders.set(table, makeChainable({ data: null, error: null }));
      }
      return mockClient._builders.get(table) as MockBuilder;
    });

    // RPC: 1ª chamada credits_for_plan, 2ª add_credits
    mockClient.rpc
      .mockResolvedValueOnce({ data: 500, error: null })
      .mockResolvedValueOnce({ data: null, error: null });

    await handleInvoicePaymentSucceeded(fakeInvoice());

    expect(mockClient.rpc).toHaveBeenCalledTimes(2);
    const firstCall = mockClient.rpc.mock.calls[0];
    const secondCall = mockClient.rpc.mock.calls[1];
    expect(firstCall?.[0]).toBe('credits_for_plan');
    expect(secondCall?.[0]).toBe('add_credits');

    const addArgs = secondCall?.[1] as Record<string, unknown>;
    expect(addArgs.workspace_id).toBe('ws_1');
    expect(addArgs.amount).toBe(500);
    expect(addArgs.reason).toBe('plan_renewal');
    expect(addArgs.related_entity_id).toBe('in_123');
  });

  it('skipa quando billing_reason é "subscription_update"', async () => {
    mockClient.from.mockImplementation((t: unknown) => {
      const table = String(t);
      if (!mockClient._builders.has(table)) {
        mockClient._builders.set(table, makeChainable({ data: null, error: null }));
      }
      return mockClient._builders.get(table) as MockBuilder;
    });

    await handleInvoicePaymentSucceeded(
      fakeInvoice({ billing_reason: 'subscription_update' as Stripe.Invoice.BillingReason })
    );

    // Não fez RPC nenhum (saída antecipada).
    expect(mockClient.rpc).not.toHaveBeenCalled();
  });
});
