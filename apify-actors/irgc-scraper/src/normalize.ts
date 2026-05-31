import {
    mapSectorFromCAE,
    normalizeProvincia,
    normalizeNIF,
    normalizePhone,
    parseCapitalSocial,
    parseRegistrationDate,
    deduceSize,
} from './utils/mapping.js';

// ============================================================================
// CONTRATO IRGCDatasetItem — partilhado com Backend Engineer
// Canónico em /Users/mac/Downloads/angoconnect/CLAUDE.md (secção "Apify").
// NÃO ALTERAR sem coordenar com app/api/apify/webhook.
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

export type CompanySize = 'micro' | 'small' | 'medium' | 'large' | 'enterprise';

export type ContactRole =
    | 'gerente'
    | 'socio'
    | 'administrador'
    | 'representante'
    | 'other';

/**
 * Contacto interno (gerente, sócio, administrador). Vive dentro de `raw.contacts`.
 * NÃO é processado pelo backend em M1.0 — fica preservado até M1.3
 * (linkedin-scraper) cruzar com decisores.
 */
export interface IRGCContact {
    full_name: string;
    title?: string;
    email?: string;
    phone?: string;
    role?: ContactRole;
}

/**
 * Shape FLAT obrigatório (CLAUDE.md > "Apify — convenções").
 * Tudo o que não cabe nos campos flat vai para `raw`.
 */
export interface IRGCDatasetItem {
    name: string;
    nif: string | null;
    sector: Sector | null;
    provincia: Provincia;              // OBRIGATÓRIO — sem província, descarta item
    website: string | null;
    source: 'irgc';                    // este Actor só emite 'irgc'
    scraped_at: string;                // ISO 8601
    raw: Record<string, unknown>;      // dados originais (address, phone, email, contacts, etc.)
}

// ============================================================================
// RAW SHAPES — output bruto dos extractors antes de normalização
// ============================================================================

export interface RawContact {
    fullName?: string;
    title?: string;
    email?: string;
    phone?: string;
    roleHint?: string;
}

export interface RawCompany {
    name?: string;
    nif?: string;
    cae?: string;
    provinciaRaw?: string;
    website?: string;
    description?: string;
    address?: string;
    phone?: string;
    email?: string;
    registrationDateRaw?: string;
    capitalSocialRaw?: string;
    employees?: number;
}

export interface RawScrape {
    sourceUrl: string;
    company: RawCompany;
    contacts: RawContact[];
}

// ============================================================================
// NORMALIZAÇÃO RAW -> CONTRATO
// ============================================================================

const VALID_ROLES: ReadonlySet<ContactRole> = new Set([
    'gerente',
    'socio',
    'administrador',
    'representante',
    'other',
]);

/**
 * Tenta inferir o role do contacto a partir do título ou hint.
 */
function inferRole(args: { title?: string; roleHint?: string }): ContactRole | undefined {
    const haystack = `${args.title ?? ''} ${args.roleHint ?? ''}`.toLowerCase();
    if (!haystack.trim()) return undefined;
    if (/gerent/.test(haystack)) return 'gerente';
    if (/s[óo]cio/.test(haystack)) return 'socio';
    if (/administrador|director|diretor|ceo/.test(haystack)) return 'administrador';
    if (/representante|procurador/.test(haystack)) return 'representante';
    return 'other';
}

/**
 * Limpa um email (lowercase, trim) e valida formato mínimo.
 */
function normalizeEmail(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    const cleaned = raw.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) return undefined;
    return cleaned;
}

/**
 * Limpa um URL e garante prefixo http(s)://
 */
function normalizeWebsite(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    try {
        const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
        const url = new URL(withProto);
        return url.toString();
    } catch {
        return undefined;
    }
}

/**
 * Constrói um IRGCContact a partir do RawContact. Devolve null se inválido.
 */
function buildContact(raw: RawContact): IRGCContact | null {
    const fullName = raw.fullName?.trim();
    if (!fullName) return null;
    const role = inferRole({ title: raw.title, roleHint: raw.roleHint });
    const contact: IRGCContact = { full_name: fullName };
    if (raw.title?.trim()) contact.title = raw.title.trim();
    const email = normalizeEmail(raw.email);
    if (email) contact.email = email;
    const phone = normalizePhone(raw.phone);
    if (phone) contact.phone = phone;
    if (role && VALID_ROLES.has(role)) contact.role = role;
    return contact;
}

/**
 * Função principal: pega raw scrape e devolve item FLAT do dataset
 * ou null se faltarem campos obrigatórios (name OU provincia válida).
 *
 * Regras:
 * - `name` obrigatório (skip se ausente)
 * - `provincia` obrigatória e tem de mapear para o enum (skip se inválida)
 * - `sector` é null quando CAE não mapeia (NÃO existe 'other' no novo enum)
 * - tudo o que não é coluna flat vai para `raw`
 */
export function buildDatasetItem(raw: RawScrape): IRGCDatasetItem | null {
    const name = raw.company.name?.trim();
    if (!name) return null;

    const provincia = normalizeProvincia(raw.company.provinciaRaw);
    if (!provincia) return null;

    const nif = normalizeNIF(raw.company.nif) ?? null;
    const sector = mapSectorFromCAE(raw.company.cae);
    const website = normalizeWebsite(raw.company.website) ?? null;

    // Campos que vão para `raw` (não cabem nos flat)
    const capitalSocial = parseCapitalSocial(raw.company.capitalSocialRaw);
    const size = deduceSize({
        capitalSocial,
        employees: raw.company.employees,
    });
    const description = raw.company.description?.trim();
    const address = raw.company.address?.trim();
    const phone = normalizePhone(raw.company.phone);
    const email = normalizeEmail(raw.company.email);
    const registrationDate = parseRegistrationDate(raw.company.registrationDateRaw);

    const contacts = raw.contacts
        .map((c) => buildContact(c))
        .filter((c): c is IRGCContact => c !== null);

    const rawBucket: Record<string, unknown> = {
        source_url: raw.sourceUrl,
        contacts,
    };
    if (size) rawBucket.size = size;
    if (description) rawBucket.description = description;
    if (address) rawBucket.address = address;
    if (phone) rawBucket.phone = phone;
    if (email) rawBucket.email = email;
    if (registrationDate) rawBucket.registration_date = registrationDate;
    if (capitalSocial !== undefined) rawBucket.capital_social = capitalSocial;
    if (raw.company.cae) rawBucket.cae = raw.company.cae;

    return {
        name,
        nif,
        sector,
        provincia,
        website,
        source: 'irgc',
        scraped_at: new Date().toISOString(),
        raw: rawBucket,
    };
}
