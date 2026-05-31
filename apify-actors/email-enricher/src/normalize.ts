// ============================================================================
// CONTRATO IRGCDatasetItem — partilhado com Backend Engineer
// Canónico em /Users/mac/Downloads/angoconnect/CLAUDE.md (secção "Apify").
// Este Actor (email-enricher) emite `source: 'manual'` porque combina
// outputs de outros Actors (irgc-scraper / linkedin-scraper / CRM) — a
// enum oficial não contempla 'email_enricher' e 'manual' é a meta-fonte
// indicada para items reaproveitados/derivados.
// ============================================================================

export type Sector =
    | 'oil_gas'
    | 'construction'
    | 'telecom'
    | 'banking'
    | 'insurance'
    | 'retail'
    | 'agro'
    | 'health'
    | 'education'
    | 'logistics'
    | 'tech'
    | 'government';

export type Provincia =
    | 'Bengo'
    | 'Benguela'
    | 'Bié'
    | 'Cabinda'
    | 'Cuando Cubango'
    | 'Cuanza Norte'
    | 'Cuanza Sul'
    | 'Cunene'
    | 'Huambo'
    | 'Huíla'
    | 'Luanda'
    | 'Lunda Norte'
    | 'Lunda Sul'
    | 'Malanje'
    | 'Moxico'
    | 'Namibe'
    | 'Uíge'
    | 'Zaire';

export type ContactRole =
    | 'gerente'
    | 'socio'
    | 'administrador'
    | 'representante'
    | 'decisor'
    | 'other';

export const VALID_SECTORS: ReadonlySet<Sector> = new Set<Sector>([
    'oil_gas', 'construction', 'telecom', 'banking',
    'insurance', 'retail', 'agro', 'health',
    'education', 'logistics', 'tech', 'government',
]);

export const VALID_PROVINCIAS: ReadonlySet<Provincia> = new Set<Provincia>([
    'Bengo', 'Benguela', 'Bié', 'Cabinda', 'Cuando Cubango',
    'Cuanza Norte', 'Cuanza Sul', 'Cunene', 'Huambo', 'Huíla',
    'Luanda', 'Lunda Norte', 'Lunda Sul', 'Malanje', 'Moxico',
    'Namibe', 'Uíge', 'Zaire',
]);

export const VALID_ROLES: ReadonlySet<ContactRole> = new Set<ContactRole>([
    'gerente', 'socio', 'administrador', 'representante', 'decisor', 'other',
]);

/**
 * Contacto enriquecido com email descoberto/verificado.
 * Vive dentro de `raw.contacts` do shape canónico.
 */
export interface EnrichedContact {
    full_name: string;
    title?: string;
    email: string | null;
    email_confidence: number;       // 0..1
    email_verified: boolean;        // true só quando SMTP devolveu 250 OK
    smtp_response?: string;         // razão (ex: '250 OK', '550 No such user', 'TIMEOUT', 'CATCH_ALL')
    phone?: string;
    linkedin_url?: string;
    role?: ContactRole;
}

/**
 * Shape FLAT obrigatório (CLAUDE.md > "Apify — convenções").
 * Tudo o que não cabe nos campos flat vai para `raw`.
 */
export interface EnrichedDatasetItem {
    name: string;
    nif: string | null;
    sector: Sector | null;
    provincia: Provincia;            // OBRIGATÓRIO — sem província, descarta item
    website: string | null;          // crítico — usado para padrão de email
    source: 'manual';                // este Actor é meta-fonte; usa 'manual'
    scraped_at: string;              // ISO 8601
    raw: {
        enriched_at: string;
        domain?: string;
        patterns_tried?: string[];
        contacts: EnrichedContact[];
        [key: string]: unknown;
    };
}

// ============================================================================
// NORMALIZAÇÃO DE NOMES — remove acentos, lowercase, separa palavras
// ============================================================================

/**
 * Remove diacríticos (NFD + strip combining marks). Mantém só [a-z0-9].
 * Exemplo: "João Manuel" -> "joao manuel"
 */
export function stripDiacritics(input: string): string {
    return input
        .normalize('NFD')
        // Remove combining diacritical marks (U+0300..U+036F)
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        // remove ç -> c (já tratado pelo NFD na maioria dos casos, mas redundância segura)
        .replace(/ç/g, 'c')
        .replace(/[^a-z0-9\s'-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Divide um nome completo em partes lógicas, removendo conectores comuns
 * portugueses ("de", "da", "do", "dos", "das") que não fazem parte do
 * padrão de email corporativo.
 *
 * "João Manuel da Silva" -> ['joao', 'manuel', 'silva']
 */
export function nameParts(fullName: string): string[] {
    const cleaned = stripDiacritics(fullName);
    const CONNECTORS = new Set(['de', 'da', 'do', 'dos', 'das', 'e']);
    return cleaned
        .split(/[\s'-]+/)
        .filter((p) => p.length > 0 && !CONNECTORS.has(p));
}

/**
 * Limpa um URL e devolve apenas o hostname (sem www., porta, path).
 * "https://www.sonangol.co.ao/path" -> "sonangol.co.ao"
 */
export function extractDomain(rawUrl: string | null | undefined): string | null {
    if (!rawUrl) return null;
    const trimmed = rawUrl.trim();
    if (!trimmed) return null;
    try {
        const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
        const url = new URL(withProto);
        return url.hostname.replace(/^www\./i, '').toLowerCase();
    } catch {
        return null;
    }
}

/**
 * Normaliza um website completo (com protocolo). Devolve null se inválido.
 */
export function normalizeWebsite(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
        const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
        const url = new URL(withProto);
        return url.toString();
    } catch {
        return null;
    }
}

/**
 * Validação mínima de formato de email.
 */
export function isValidEmailFormat(email: string): boolean {
    return /^[a-z0-9][a-z0-9._-]*@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(email);
}
