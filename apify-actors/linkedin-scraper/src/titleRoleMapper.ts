import type { ContactRole } from './normalize.js';

// ============================================================================
// Mapeamento de títulos LinkedIn (PT + EN) -> ContactRole canónico.
//
// O LinkedIn AO tem perfis em ambos os idiomas, por vezes misturados:
// "CEO & Founder" / "Director Comercial" / "Sales Manager" / "Sócio-Gerente".
//
// Estratégia: regex por palavras-chave, da mais específica para a mais
// genérica. O primeiro match ganha. Se nenhum match, devolve 'other'.
//
// IMPORTANTE: o role 'decisor' não existia no irgc-scraper porque ali os
// contactos são gerentes/sócios formais. Aqui no LinkedIn temos C-level e
// Directores que são "decisores" no sentido comercial — adicionámos esse
// role à união em normalize.ts.
// ============================================================================

/**
 * Cada regra: regex (lowercase, sem acentos) -> role.
 * Ordem importa.
 */
const ROLE_RULES: ReadonlyArray<readonly [RegExp, ContactRole]> = [
    // ADMINISTRADOR — C-suite top, fundadores, presidentes, owners
    [/\bceo\b/, 'administrador'],
    [/\bchief executive officer\b/, 'administrador'],
    [/\bpresidente\b/, 'administrador'],
    [/\bpresident\b/, 'administrador'],
    [/\bfounder\b/, 'administrador'],
    [/\bco[\s-]?founder\b/, 'administrador'],
    [/\bfundador/, 'administrador'],
    [/\bowner\b/, 'administrador'],
    [/\bproprietari/, 'administrador'],
    [/\badministrador/, 'administrador'],
    [/\badministrator\b/, 'administrador'],
    [/\bchairman\b/, 'administrador'],
    [/\bboard member\b/, 'administrador'],
    [/\bmembro do conselho/, 'administrador'],

    // SOCIO — sócios, partners (mas só se não estiverem já cobertos acima)
    [/\bsocio[\s-]?gerente/, 'gerente'], // caso especial: cai como gerente
    [/\bs[oó]cio\b/, 'socio'],
    [/\bpartner\b/, 'socio'],
    [/\bmanaging partner\b/, 'socio'],

    // DECISOR — C-suite restante + Directores + VPs (não-CEO)
    [/\bcfo\b/, 'decisor'],
    [/\bchief financial officer\b/, 'decisor'],
    [/\bcoo\b/, 'decisor'],
    [/\bchief operating officer\b/, 'decisor'],
    [/\bcto\b/, 'decisor'],
    [/\bchief technology officer\b/, 'decisor'],
    [/\bcmo\b/, 'decisor'],
    [/\bchief marketing officer\b/, 'decisor'],
    [/\bcio\b/, 'decisor'],
    [/\bchief information officer\b/, 'decisor'],
    [/\bchro\b/, 'decisor'],
    [/\bchief.*officer\b/, 'decisor'],
    [/\bdirector\b/, 'decisor'],
    [/\bdiretor/, 'decisor'],
    [/\bdirectora\b/, 'decisor'],
    [/\bdirectress\b/, 'decisor'],
    [/\bhead of\b/, 'decisor'],
    [/\bvp\b/, 'decisor'],
    [/\bvice[\s-]?president/, 'decisor'],
    [/\bvice[\s-]?presidente/, 'decisor'],

    // GERENTE — managers e gerentes (operacional, sem ser director)
    [/\bgerente\b/, 'gerente'],
    [/\bmanager\b/, 'gerente'],
    [/\bteam lead\b/, 'gerente'],
    [/\blider de equipa\b/, 'gerente'],
    [/\bsupervisor/, 'gerente'],

    // REPRESENTANTE — vendedores, account execs, BDRs
    [/\brepresentante/, 'representante'],
    [/\brepresentative\b/, 'representante'],
    [/\bprocurador/, 'representante'],
    [/\baccount executive\b/, 'representante'],
    [/\baccount manager\b/, 'representante'],
    [/\bsales executive\b/, 'representante'],
    [/\bsales representative\b/, 'representante'],
];

/**
 * Normaliza um título: lowercase + sem acentos + colapsa espaços.
 */
function normalize(input: string): string {
    return input
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Mapeia um título LinkedIn para um ContactRole canónico.
 * Devolve 'other' se nenhuma regra bater (e há texto), ou undefined se input vazio.
 *
 * Aceita títulos PT e EN, mistos, com hífens ou ampersand.
 */
export function mapTitleToRole(title: string | undefined | null): ContactRole | undefined {
    if (!title) return undefined;
    const haystack = normalize(title);
    if (!haystack) return undefined;
    for (const [pattern, role] of ROLE_RULES) {
        if (pattern.test(haystack)) return role;
    }
    return 'other';
}
