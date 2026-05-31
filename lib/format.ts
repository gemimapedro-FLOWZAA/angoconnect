/**
 * Helpers de formatação partilhados pelo frontend.
 *
 * Locale PT-PT por defeito. Para evitar discrepâncias SSR/CSR (Intl pode
 * comportar-se de forma diferente consoante o runtime), instâncias dos
 * formatters são criadas a pedido, não no top-level.
 */

const NUMBER_FORMATTER = new Intl.NumberFormat('pt-PT');
const DATE_FORMATTER = new Intl.DateTimeFormat('pt-PT', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});
const DATETIME_FORMATTER = new Intl.DateTimeFormat('pt-PT', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/**
 * Formata um valor monetário em Kwanzas Angolanos.
 *
 * Tenta usar `Intl.NumberFormat` com `currency: 'AOA'`. Como nem todos os
 * runtimes (especialmente versões mais antigas de Node ou browsers) suportam
 * a moeda AOA, fazemos fallback para uma máscara manual `Kz X.XXX,XX`.
 */
const AKZ_FORMATTER = (() => {
  try {
    return new Intl.NumberFormat('pt-PT', {
      style: 'currency',
      currency: 'AOA',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });
  } catch {
    return null;
  }
})();

const AKZ_DECIMAL_FORMATTER = new Intl.NumberFormat('pt-PT', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

export function formatAKZ(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (AKZ_FORMATTER) {
    try {
      return AKZ_FORMATTER.format(value);
    } catch {
      // fall through
    }
  }
  return `Kz ${AKZ_DECIMAL_FORMATTER.format(value)}`;
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return NUMBER_FORMATTER.format(value);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return DATE_FORMATTER.format(d);
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return DATETIME_FORMATTER.format(d);
}

/**
 * Formato simples e tolerante para telefones angolanos.
 *
 * Heurística:
 *  - Mantemos um `+` inicial se existir
 *  - Removemos espaços, pontos e parênteses
 *  - Se ficar com 13 dígitos a começar por 244 (formato internacional),
 *    apresentamos como `+244 XXX XXX XXX`
 *  - Se ficar com 9 dígitos (nacional), apresentamos como `XXX XXX XXX`
 *  - Caso contrário devolvemos o valor "sanitizado" sem máscara
 */
export function formatPhone(value: string | null | undefined): string {
  if (!value) return '—';
  const trimmed = value.trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/[^\d]/g, '');

  if (digits.length === 0) return '—';

  if ((hasPlus || digits.length === 12) && digits.startsWith('244') && digits.length === 12) {
    const rest = digits.slice(3);
    return `+244 ${rest.slice(0, 3)} ${rest.slice(3, 6)} ${rest.slice(6, 9)}`;
  }

  if (digits.length === 9) {
    return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 9)}`;
  }

  return hasPlus ? `+${digits}` : digits;
}

/**
 * Máscara visual para campos sensíveis ainda não revelados. Mantém o domínio
 * de um email visível para dar contexto.
 */
export function maskEmail(value: string | null | undefined): string {
  if (!value) return '—';
  const at = value.indexOf('@');
  if (at < 0) return '••••••••';
  const local = value.slice(0, at);
  const domain = value.slice(at);
  const hint = local.slice(0, Math.min(2, local.length));
  return `${hint}${'•'.repeat(Math.max(4, local.length - hint.length))}${domain}`;
}

export function maskPhone(value: string | null | undefined): string {
  if (!value) return '—';
  const digits = value.replace(/[^\d]/g, '');
  if (digits.length < 4) return '••• •••';
  const tail = digits.slice(-3);
  return `••• ••• ${tail}`;
}

/**
 * Devolve até 2 iniciais maiúsculas do nome — útil para avatares simples.
 */
export function initials(name: string | null | undefined): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0] ?? '';
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? '';
  return ((first[0] ?? '') + (last[0] ?? '')).toUpperCase();
}
