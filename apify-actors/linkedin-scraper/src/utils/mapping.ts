import type { Provincia, Sector } from '../normalize.js';

// ============================================================================
// Reusa a estratégia do irgc-scraper para sector/provincia, mas adapta para
// o input do LinkedIn (industry como texto livre em vez de código CAE).
// ============================================================================

/**
 * Mapa de keywords (lowercase, sem acento) -> sector canónico.
 * O LinkedIn devolve "industry" como texto livre em PT ou EN.
 * Faz match por substring — o primeiro match ganha. Devolve null se nada bate.
 *
 * Nota: NUNCA inventa 'other' — o enum canónico tem apenas 12 valores.
 */
const INDUSTRY_KEYWORD_MAP: ReadonlyArray<readonly [string, Sector]> = [
    // Ordem importa — keywords mais específicas vêm primeiro.
    ['oil', 'oil_gas'],
    ['gas', 'oil_gas'],
    ['petroleum', 'oil_gas'],
    ['petroleo', 'oil_gas'],
    ['mining', 'oil_gas'],
    ['mineracao', 'oil_gas'],

    ['construction', 'construction'],
    ['construcao', 'construction'],
    ['civil engineering', 'construction'],
    ['engenharia civil', 'construction'],

    ['telecommunications', 'telecom'],
    ['telecomunicacoes', 'telecom'],
    ['telecom', 'telecom'],
    ['wireless', 'telecom'],

    ['banking', 'banking'],
    ['banca', 'banking'],
    ['financial services', 'banking'],
    ['servicos financeiros', 'banking'],
    ['investment', 'banking'],

    ['insurance', 'insurance'],
    ['seguros', 'insurance'],

    ['retail', 'retail'],
    ['retalho', 'retail'],
    ['wholesale', 'retail'],
    ['comercio', 'retail'],
    ['consumer goods', 'retail'],

    ['agriculture', 'agro'],
    ['agricultura', 'agro'],
    ['farming', 'agro'],
    ['fisheries', 'agro'],
    ['pescas', 'agro'],
    ['livestock', 'agro'],

    ['hospital', 'health'],
    ['health care', 'health'],
    ['healthcare', 'health'],
    ['saude', 'health'],
    ['pharma', 'health'],
    ['farmaceutica', 'health'],

    ['education', 'education'],
    ['educacao', 'education'],
    ['higher education', 'education'],
    ['ensino', 'education'],

    ['logistics', 'logistics'],
    ['logistica', 'logistics'],
    ['transportation', 'logistics'],
    ['transporte', 'logistics'],
    ['shipping', 'logistics'],
    ['warehousing', 'logistics'],

    ['information technology', 'tech'],
    ['tecnologia da informacao', 'tech'],
    ['software', 'tech'],
    ['internet', 'tech'],
    ['computer', 'tech'],
    ['informatica', 'tech'],
    ['it services', 'tech'],

    ['government', 'government'],
    ['governo', 'government'],
    ['public administration', 'government'],
    ['administracao publica', 'government'],
];

/**
 * Normaliza string para matching: lowercase + sem acentos + espaços colapsados.
 */
function normalizeForMatch(raw: string): string {
    return raw
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Mapeia o texto livre "industry" do LinkedIn para o enum Sector canónico.
 * Devolve null quando não há match — NUNCA inventa 'other'.
 */
export function mapSectorFromIndustry(industry: string | undefined | null): Sector | null {
    if (!industry) return null;
    const haystack = normalizeForMatch(industry);
    if (!haystack) return null;
    for (const [keyword, sector] of INDUSTRY_KEYWORD_MAP) {
        if (haystack.includes(keyword)) return sector;
    }
    return null;
}

/**
 * Mapa de variantes de província (sem acento, lowercase) -> nome canónico.
 * Copia exacta da estratégia do irgc-scraper.
 */
const PROVINCIA_MAP: Record<string, Provincia> = {
    'bengo': 'Bengo',
    'benguela': 'Benguela',
    'bie': 'Bié',
    'cabinda': 'Cabinda',
    'cuando cubango': 'Cuando Cubango',
    'kuando kubango': 'Cuando Cubango',
    'cuanza norte': 'Cuanza Norte',
    'kwanza norte': 'Cuanza Norte',
    'cuanza sul': 'Cuanza Sul',
    'kwanza sul': 'Cuanza Sul',
    'cunene': 'Cunene',
    'huambo': 'Huambo',
    'huila': 'Huíla',
    'luanda': 'Luanda',
    'lunda norte': 'Lunda Norte',
    'lunda sul': 'Lunda Sul',
    'malanje': 'Malanje',
    'moxico': 'Moxico',
    'namibe': 'Namibe',
    'uige': 'Uíge',
    'zaire': 'Zaire',
};

/**
 * Normaliza string de localização — o LinkedIn devolve coisas como
 * "Luanda, Angola", "Talatona, Luanda Province, Angola", "Benguela Province".
 * Tentamos extrair a província procurando keywords conhecidas dentro do texto.
 *
 * Devolve o nome canónico OU undefined se não houver match.
 */
export function normalizeProvinciaFromLocation(
    raw: string | undefined | null,
): Provincia | undefined {
    if (!raw) return undefined;
    const cleaned = normalizeForMatch(raw);
    if (!cleaned) return undefined;

    // Match directo (caso o input seja apenas o nome da província)
    const direct = PROVINCIA_MAP[cleaned];
    if (direct) return direct;

    // Match por substring — procura cada variante dentro da string
    for (const [variant, provincia] of Object.entries(PROVINCIA_MAP)) {
        // Word boundary fraco — keywords PROVINCIA_MAP não colidem entre si.
        if (cleaned.includes(variant)) return provincia;
    }
    return undefined;
}

/**
 * Valida formato do NIF angolano: 9 ou 10 dígitos. NIF de empresa pode ter
 * letras (formato empresarial), mantém apenas alfanuméricos.
 *
 * Cópia do irgc-scraper para consistência.
 */
export function normalizeNIF(raw: string | undefined | null): string | undefined {
    if (!raw) return undefined;
    const cleaned = raw.replace(/[^0-9A-Z]/gi, '').toUpperCase();
    if (cleaned.length < 9 || cleaned.length > 10) return undefined;
    return cleaned;
}

/**
 * Limpa e valida URL — garante prefixo http(s)://. Devolve undefined se inválido.
 */
export function normalizeWebsite(raw: string | undefined | null): string | undefined {
    if (!raw) return undefined;
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    try {
        const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
        return new URL(withProto).toString();
    } catch {
        return undefined;
    }
}

/**
 * Limpa URL do LinkedIn — força protocolo + lowercase do host.
 * Aceita www.linkedin.com, linkedin.com, ao.linkedin.com.
 */
export function normalizeLinkedinUrl(raw: string | undefined | null): string | undefined {
    if (!raw) return undefined;
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    try {
        const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
        const url = new URL(withProto);
        if (!/linkedin\.com$/i.test(url.hostname.replace(/^www\./, ''))) return undefined;
        url.hostname = url.hostname.toLowerCase();
        return url.toString();
    } catch {
        return undefined;
    }
}
