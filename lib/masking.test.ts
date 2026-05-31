/**
 * AngoConnect — Testes unitários de masking de email/telefone (M4.1)
 */

import { describe, expect, it } from 'vitest';
import { maskEmail, maskPhone } from './masking';

describe('maskEmail', () => {
  it('mascara um email válido mantendo iniciais e TLD', () => {
    const out = maskEmail('joao@sonangol.co.ao');
    // Forma: j***@s***.co.ao
    expect(out).toMatch(/^j\*+@s\*+\.co\.ao$/);
    expect(out).toContain('@');
    expect(out?.endsWith('.co.ao')).toBe(true);
  });

  it('devolve "***@***" para input mal formado (sem @)', () => {
    expect(maskEmail('nao-tem-arroba')).toBe('***@***');
  });

  it('devolve null para input null/undefined', () => {
    expect(maskEmail(null)).toBeNull();
    expect(maskEmail(undefined)).toBeNull();
  });

  it('lida com TLD curto e local-part curto', () => {
    const out = maskEmail('x@y.com');
    expect(out).toBe('x***@y***.com');
  });
});

describe('maskPhone', () => {
  it('mantém prefixo internacional +244 e últimos 2 dígitos', () => {
    const out = maskPhone('+244929199330');
    expect(out).not.toBeNull();
    expect(out?.startsWith('+244')).toBe(true);
    expect(out?.endsWith('30')).toBe(true);
    expect(out).toContain('*');
  });

  it('aceita número sem prefixo + e mascara internamente', () => {
    const out = maskPhone('929199330');
    expect(out).not.toBeNull();
    expect(out?.endsWith('30')).toBe(true);
    expect(out?.startsWith('+')).toBe(false);
    expect(out).toContain('*');
  });

  it('devolve null para input vazio/null', () => {
    expect(maskPhone(null)).toBeNull();
    expect(maskPhone(undefined)).toBeNull();
    expect(maskPhone('')).toBeNull();
    expect(maskPhone('   ')).toBeNull();
  });

  it('devolve "***" se o número for demasiado curto para mascarar', () => {
    expect(maskPhone('12')).toBe('***');
  });
});
