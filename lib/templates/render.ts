/**
 * AngoConnect — Renderer simples de templates de email
 * ===========================================================================
 * Helper partilhado para substituir placeholders `{{var_name}}` num template
 * de email (subject ou body) por valores reais.
 *
 * Usado por:
 *   - POST /api/templates/preview (M3.2) — preview no Outreach Builder
 *   - Worker BullMQ de outreach (futuro) — render antes de enviar via Resend
 *
 * Regras:
 *   - Aceita identificadores `{a-zA-Z_][a-zA-Z0-9_]*}` rodeados de `{{ }}`
 *     com whitespace opcional. Não tenta avaliar expressões.
 *   - Se a variável não existir no `data`, mantém o placeholder original
 *     (`{{var}}`) e adiciona o nome ao set `missingVars`.
 *   - Não escapa HTML — assume que o consumidor decide se mostra em <pre>
 *     ou já passou por sanitizador. Para emails Resend, o body é texto/HTML
 *     conforme o template.
 */

export interface RenderResult {
  rendered: string;
  missingVars: string[];
}

const PLACEHOLDER_REGEX = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

export function renderTemplate(
  template: string,
  data: Record<string, string>
): RenderResult {
  const missingVars = new Set<string>();
  const rendered = template.replace(
    PLACEHOLDER_REGEX,
    (_match: string, key: string): string => {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        const value = data[key];
        // `value` é tipado como `string` por declaração, mas com
        // `noUncheckedIndexedAccess` o TS exige a guarda.
        if (typeof value === 'string') return value;
      }
      missingVars.add(key);
      return `{{${key}}}`;
    }
  );
  return { rendered, missingVars: [...missingVars] };
}

/**
 * Sample data usado pelo endpoint POST /api/templates/preview quando o
 * cliente não passa `sampleData`. Os valores estão em PT-AO porque o
 * mercado-alvo principal é Angola.
 */
export const DEFAULT_PREVIEW_SAMPLE_DATA: Record<string, string> = {
  first_name: 'João',
  full_name: 'João Manuel Silva',
  company_name: 'Sonangol',
  title: 'Director Comercial',
  sender_name: 'Maria Pinto',
  sender_company: 'AngoConnect',
  value_prop: 'reduzir o tempo de prospecção em 70%',
  specific_outcome: 'reduzir o tempo de qualificação de leads',
  news_summary: 'Lançámos integração WhatsApp',
};
