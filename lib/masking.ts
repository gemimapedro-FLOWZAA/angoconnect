/**
 * AngoConnect — Email / Phone masking helpers
 * ===========================================================================
 * Usados em endpoints de Search & Discovery (M3.1) para mascarar contactos
 * que não foram "revelados" (i.e., não foi pago 1 crédito por eles).
 *
 * Regras:
 *   - Mantém info suficiente para previsão visual (primeira letra do local
 *     e do domínio, TLD) sem expor o contacto.
 *   - Pure functions, sem side-effects — fáceis de testar.
 */

/**
 * Mascara um email mantendo a 1ª letra do local-part, a 1ª letra do
 * domain-name e o TLD.
 *   joao@sonangol.ao  →  j***@s***.ao
 *   pedro@empresa.co.ao → p***@e***.co.ao
 *   x@y.com           →  x***@y***.com
 *
 * Devolve `'***@***'` em casos de input mal formado.
 */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim();
  if (!trimmed.includes('@')) return '***@***';

  const atIdx = trimmed.indexOf('@');
  const local = trimmed.slice(0, atIdx);
  const domain = trimmed.slice(atIdx + 1);
  if (!local || !domain) return '***@***';

  const dotIdx = domain.indexOf('.');
  const domainName = dotIdx === -1 ? domain : domain.slice(0, dotIdx);
  const tld = dotIdx === -1 ? '' : domain.slice(dotIdx); // inclui o '.'

  const localChar = local[0] ?? '*';
  const domainChar = domainName[0] ?? '*';

  return `${localChar}***@${domainChar}***${tld}`;
}

/**
 * Mascara um telefone mantendo o prefixo internacional (até 3 dígitos
 * depois do '+') e os últimos 2 dígitos.
 *   +244929199330  →  +244 *** *** *30
 *   929199330      →  929 *** *30  (sem '+', mantém os primeiros 3)
 *
 * Devolve `null` para input vazio/inválido.
 */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  if (!trimmed) return null;

  // Remove tudo excepto dígitos e '+' (preserva '+' inicial).
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');

  if (digits.length < 4) {
    // Demasiado curto para mascarar — devolve estrelas.
    return '***';
  }

  const prefixLen = Math.min(3, digits.length - 2);
  const prefix = digits.slice(0, prefixLen);
  const suffix = digits.slice(-2);
  const middleLen = Math.max(0, digits.length - prefixLen - 2);
  const middle = '*'.repeat(middleLen);

  return `${hasPlus ? '+' : ''}${prefix} ${middle.replace(/(.{3})/g, '$1 ').trim()} ${suffix}`.trim();
}

/**
 * Aplica masking condicional a um contacto consoante o flag `isRevealed`.
 * Retorna sempre o mesmo shape, mas com email/phone mascarados ou
 * em claro. Não muta o input.
 */
export function applyContactMasking<
  T extends { email: string | null; phone: string | null },
>(
  contact: T,
  isRevealed: boolean
): T & { is_revealed: boolean } {
  if (isRevealed) {
    return { ...contact, is_revealed: true };
  }
  return {
    ...contact,
    email: maskEmail(contact.email),
    phone: maskPhone(contact.phone),
    is_revealed: false,
  };
}
