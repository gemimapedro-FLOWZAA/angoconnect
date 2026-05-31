/**
 * AngoConnect — Testes unitários do renderer de templates (M4.1)
 */

import { describe, expect, it } from 'vitest';
import { renderTemplate } from './render';

describe('renderTemplate', () => {
  it('substitui placeholders simples por valores do data', () => {
    const result = renderTemplate('Olá {{first_name}}!', { first_name: 'João' });
    expect(result.rendered).toBe('Olá João!');
    expect(result.missingVars).toEqual([]);
  });

  it('devolve missingVars quando a chave não está no data', () => {
    const result = renderTemplate('Olá {{first_name}}, da {{company_name}}', {
      first_name: 'Ana',
    });
    expect(result.rendered).toBe('Olá Ana, da {{company_name}}');
    expect(result.missingVars).toEqual(['company_name']);
  });

  it('mantém o placeholder no texto quando não há match', () => {
    const result = renderTemplate('Hello {{ unknown }}', {});
    // Whitespace ignorado pelo regex, mas o output normaliza para `{{unknown}}`.
    expect(result.rendered).toBe('Hello {{unknown}}');
    expect(result.missingVars).toEqual(['unknown']);
  });

  it('suporta body multiline com múltiplos placeholders', () => {
    const tpl = 'Olá {{first_name}},\n\nA {{company_name}} agradece o contacto.\n\n— {{sender_name}}';
    const result = renderTemplate(tpl, {
      first_name: 'Pedro',
      company_name: 'Sonangol',
      sender_name: 'Maria',
    });
    expect(result.rendered).toContain('Olá Pedro,');
    expect(result.rendered).toContain('A Sonangol agradece');
    expect(result.rendered).toContain('— Maria');
    expect(result.missingVars).toEqual([]);
  });

  it('deduplica missingVars quando a mesma chave aparece várias vezes', () => {
    const tpl = '{{x}} então {{x}} e ainda {{x}}';
    const result = renderTemplate(tpl, {});
    expect(result.missingVars).toEqual(['x']);
    // Cada ocorrência mantém o placeholder.
    expect(result.rendered).toBe('{{x}} então {{x}} e ainda {{x}}');
  });
});
