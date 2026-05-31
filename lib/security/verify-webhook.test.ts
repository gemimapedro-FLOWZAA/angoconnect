/**
 * AngoConnect — Testes do helper de verificação constant-time (M4.1)
 */

import { describe, expect, it } from 'vitest';
import { verifyWebhookSecret } from './verify-webhook';

describe('verifyWebhookSecret', () => {
  it('devolve true para match exacto', () => {
    expect(verifyWebhookSecret('abc-123', 'abc-123')).toBe(true);
  });

  it('devolve false quando os tamanhos são diferentes (sem leak via excepção)', () => {
    expect(verifyWebhookSecret('abc', 'abc-1234')).toBe(false);
    expect(verifyWebhookSecret('abc-1234', 'abc')).toBe(false);
  });

  it('devolve false quando received/expected são undefined/null/vazios', () => {
    expect(verifyWebhookSecret(undefined, 'expected')).toBe(false);
    expect(verifyWebhookSecret(null, 'expected')).toBe(false);
    expect(verifyWebhookSecret('received', undefined)).toBe(false);
    expect(verifyWebhookSecret('', '')).toBe(false);
  });
});
