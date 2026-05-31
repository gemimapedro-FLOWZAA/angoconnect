/**
 * AngoConnect — POST /api/billing/webhook
 * ===========================================================================
 * Recebe e processa eventos Stripe.
 *
 * Segurança:
 *   - `stripe.webhooks.constructEvent(body, signature, secret)` faz a
 *     verificação HMAC SHA-256 internamente em constant-time. Não usamos
 *     `verifyWebhookSecret` aqui porque o esquema do Stripe é diferente
 *     (timestamp + assinatura no header `Stripe-Signature`).
 *   - Lemos o body raw via `request.text()` — necessário para verificar
 *     a assinatura. Se fosse `request.json()`, a re-serialização ia partir
 *     a verificação.
 *
 * Runtime:
 *   - Forçamos `nodejs` (não Edge) porque a verificação HMAC usa
 *     `node:crypto` via `Stripe.webhooks.constructEvent`.
 *   - `dynamic = 'force-dynamic'` para garantir que o Next não tenta
 *     cachear o handler.
 *
 * Eventos tratados (lib/billing/webhook-handlers.ts):
 *   - customer.subscription.created   → upsert
 *   - customer.subscription.updated   → upsert
 *   - customer.subscription.deleted   → marcar canceled
 *   - invoice.payment_succeeded       → recarregar créditos (idempotente)
 *   - invoice.payment_failed          → log only
 *
 * Eventos ignorados (silenciosamente, com `received: true`):
 *   - checkout.session.completed   — redundante com subscription.created
 *   - customer.created / customer.updated
 *   - invoice.created / invoice.finalized
 *   - charge.* / payment_intent.*
 *   - qualquer outro.
 *
 * Erros de handler propagam como 500 → Stripe vai retentar.
 */

import type { NextRequest } from 'next/server';
import type Stripe from 'stripe';
import { apiError, apiOk } from '@/lib/api-response';
import {
  handleInvoicePaymentFailed,
  handleInvoicePaymentSucceeded,
  handleSubscriptionDeleted,
  handleSubscriptionUpsert,
} from '@/lib/billing/webhook-handlers';
import { stripe } from '@/lib/stripe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STRIPE_SIGNATURE_HEADER = 'stripe-signature';

export async function POST(request: NextRequest) {
  // -----------------------------------------------------------------------
  // 1) Validar configuração antes de tocar no body — falha cedo.
  // -----------------------------------------------------------------------
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[billing/webhook] STRIPE_WEBHOOK_SECRET não configurada');
    return apiError(
      'Stripe webhook secret não configurada no servidor',
      500,
      'WEBHOOK_SECRET_NOT_CONFIGURED'
    );
  }

  // -----------------------------------------------------------------------
  // 2) Ler body RAW (necessário para verificação de assinatura).
  // -----------------------------------------------------------------------
  const body = await request.text();
  const signature = request.headers.get(STRIPE_SIGNATURE_HEADER);
  if (!signature) {
    return apiError(
      'Missing stripe-signature header',
      401,
      'NO_SIGNATURE'
    );
  }

  // -----------------------------------------------------------------------
  // 3) Verificar assinatura + construir o event tipado.
  // -----------------------------------------------------------------------
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[billing/webhook] assinatura inválida', message);
    return apiError(
      'Invalid signature',
      401,
      'INVALID_SIGNATURE',
      { reason: message }
    );
  }

  // -----------------------------------------------------------------------
  // 4) Dispatch por event.type.
  // -----------------------------------------------------------------------
  try {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpsert(
          event.data.object as Stripe.Subscription
        );
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(
          event.data.object as Stripe.Subscription
        );
        break;

      case 'invoice.payment_succeeded':
        await handleInvoicePaymentSucceeded(
          event.data.object as Stripe.Invoice
        );
        break;

      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(
          event.data.object as Stripe.Invoice
        );
        break;

      default:
        // Evento não tratado — devolvemos `received: true` para o Stripe
        // não marcar como erro nem retentar.
        return apiOk({
          received: true,
          type: event.type,
          handled: false,
        });
    }
  } catch (err) {
    // Qualquer erro nos handlers → 500. O Stripe vai retentar com backoff.
    // Os handlers já logaram detalhes; aqui apenas embrulhamos a resposta.
    const message = err instanceof Error ? err.message : String(err);
    console.error('[billing/webhook] handler falhou', {
      type: event.type,
      eventId: event.id,
      message,
    });
    return apiError(
      `Webhook handler failed: ${message}`,
      500,
      'HANDLER_FAILED',
      { eventType: event.type, eventId: event.id }
    );
  }

  return apiOk({
    received: true,
    type: event.type,
    handled: true,
  });
}
