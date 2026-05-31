import { nameParts } from './normalize.js';

/**
 * Identificadores dos padrões usados. Mantemos como string-literal
 * para conseguirmos persistir em `raw.patterns_tried`.
 *
 * Ordem importa: a verificação SMTP pára no primeiro 250 OK.
 * Os padrões mais comuns em empresas angolanas vêm primeiro.
 */
export type PatternId =
    | 'first.last'
    | 'firstlast'
    | 'f.last'
    | 'flast'
    | 'first_last'
    | 'first'
    | 'first.l'
    | 'last'
    | 'first.middle.last'   // só quando o nome tem 3 ou mais partes
    | 'first.last.middle';  // variante para nomes compostos AO

export interface Candidate {
    pattern: PatternId;
    local: string;          // parte antes do @
    email: string;          // local@domain
}

/**
 * Gera candidatos de email para um nome dado e um domínio.
 *
 * Estratégia (PT/AO):
 * - Sempre tenta os 8 padrões base por ordem de probabilidade.
 * - Quando o nome tem 3+ partes (comum em AO: "João Manuel Silva"),
 *   adiciona 2 padrões extra com o nome do meio.
 *
 * @param fullName "João Manuel da Silva"
 * @param domain   "sonangol.co.ao"
 * @param limit    Número máximo de candidatos a devolver (default 8)
 */
export function generateCandidates(
    fullName: string,
    domain: string,
    limit: number = 8,
): Candidate[] {
    const parts = nameParts(fullName);
    if (parts.length === 0) return [];

    const first = parts[0]!;
    const last = parts.length > 1 ? parts[parts.length - 1]! : first;
    const middle = parts.length >= 3 ? parts.slice(1, -1).join('.') : undefined;

    const f = first[0] ?? '';
    const l = last[0] ?? '';

    const out: Candidate[] = [];

    const push = (pattern: PatternId, local: string): void => {
        // de-dupe (ex: nome só com uma parte cai em padrões equivalentes)
        if (!local || out.some((c) => c.local === local)) return;
        if (out.length >= limit) return;
        out.push({ pattern, local, email: `${local}@${domain}` });
    };

    // Ordem fixa, mais comum primeiro
    push('first.last', `${first}.${last}`);
    push('firstlast', `${first}${last}`);
    push('f.last', `${f}.${last}`);
    push('flast', `${f}${last}`);
    push('first_last', `${first}_${last}`);
    push('first', first);
    push('first.l', `${first}.${l}`);
    push('last', last);

    if (middle) {
        push('first.middle.last', `${first}.${middle}.${last}`);
        push('first.last.middle', `${first}.${last}.${middle}`);
    }

    return out.slice(0, limit);
}
