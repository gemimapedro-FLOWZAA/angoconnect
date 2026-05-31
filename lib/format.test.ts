/**
 * AngoConnect — Testes unitários dos helpers de formatação (M4.1)
 */

import { describe, expect, it } from 'vitest';
import { formatAKZ, formatPhone, initials } from './format';

describe('formatAKZ', () => {
  it('formata um valor numérico com a moeda Kwanza', () => {
    const out = formatAKZ(50000);
    // O Intl pode usar "Kz" (próprio AOA) ou "AOA" — aceitamos qualquer um.
    // Garantimos que o valor 50 está visível e a string contém uma das duas
    // marcas monetárias.
    expect(out).toMatch(/(Kz|AOA)/);
    expect(out).toMatch(/50/);
  });

  it('devolve "—" para null/undefined/NaN', () => {
    expect(formatAKZ(null)).toBe('—');
    expect(formatAKZ(undefined)).toBe('—');
    expect(formatAKZ(Number.NaN)).toBe('—');
  });
});

describe('initials', () => {
  it('devolve as iniciais do primeiro e último nome (J + S = JS)', () => {
    expect(initials('João Manuel Silva')).toBe('JS');
  });

  it('devolve "?" para null', () => {
    expect(initials(null)).toBe('?');
    expect(initials(undefined)).toBe('?');
    expect(initials('')).toBe('?');
  });
});

describe('formatPhone', () => {
  it('aplica máscara +244 XXX XXX XXX a número nacional com 9 dígitos', () => {
    const out = formatPhone('912345678');
    // Heurística do helper: 9 dígitos → "XXX XXX XXX" sem prefixo.
    expect(out).toBe('912 345 678');
  });

  it('aplica formato internacional para número com prefixo 244 + 9 dígitos', () => {
    const out = formatPhone('+244912345678');
    expect(out).toBe('+244 912 345 678');
  });

  it('devolve "—" para input vazio', () => {
    expect(formatPhone(null)).toBe('—');
    expect(formatPhone('')).toBe('—');
  });

  it('devolve o input "sanitizado" se não bater nas heurísticas', () => {
    // 4 dígitos — não é nacional (9) nem internacional (12).
    expect(formatPhone('1234')).toBe('1234');
  });
});
