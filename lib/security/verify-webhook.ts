/**
 * AngoConnect — Helper de verificação de secrets de webhooks
 * ---------------------------------------------------------------------------
 * Comparação constant-time (`timingSafeEqual`) entre o secret recebido no
 * header de um webhook e o secret esperado em `.env`. Substitui qualquer uso
 * de `===` para comparar segredos (vulnerável a timing attacks).
 *
 * Usado por:
 *   - `app/api/apify/webhook/route.ts`  (header `X-Apify-Secret`, M1.2)
 *   - `app/api/billing/webhook/route.ts` (Stripe — M2.2, futuro)
 *
 * Regra do CLAUDE.md → "Segurança / regras não negociáveis":
 *   "Nunca usar `===` para comparar secrets."
 */

import { timingSafeEqual } from 'node:crypto';

/**
 * Compara dois segredos em constant-time.
 *
 * - Retorna `false` se qualquer um for falsy (vazio, null, undefined).
 * - Retorna `false` se tiverem tamanhos diferentes (sem leak de tamanho via
 *   excepção do próprio `timingSafeEqual`).
 * - Caso contrário usa `crypto.timingSafeEqual` para a comparação real.
 */
export function verifyWebhookSecret(
  received: string | null | undefined,
  expected: string | undefined
): boolean {
  if (!received || !expected) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
