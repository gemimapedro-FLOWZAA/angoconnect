import {
    mapSectorFromIndustry,
    normalizeLinkedinUrl,
    normalizeNIF,
    normalizeProvinciaFromLocation,
    normalizeWebsite,
} from './utils/mapping.js';
import { mapTitleToRole } from './titleRoleMapper.js';

// ============================================================================
// CONTRATO DatasetItem — shape FLAT canónico do AngoConnect
// (CLAUDE.md > "Apify — convenções").
//
// O nome do tipo em CLAUDE.md é "IRGCDatasetItem" mas o orquestrador deixou
// claro que é o shape canónico para TODOS os Actors company-centric — só
// muda o campo `source` e a forma de `raw`.
//
// NÃO ALTERAR este shape sem coordenar com app/api/apify/webhook.
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

/**
 * Roles canónicos. O `decisor` é uma adição face ao irgc-scraper: representa
 * C-suite (excepto CEO=administrador) e Directores que tomam decisão comercial.
 * O backend deve aceitar este valor — ver acordo com Backend Engineer.
 */
export type ContactRole =
    | 'gerente'
    | 'socio'
    | 'administrador'
    | 'representante'
    | 'decisor'
    | 'other';

/**
 * Contacto LinkedIn enriquecido. Vive dentro de `raw.contacts`.
 * O Backend processa estes itens para popular a tabela `contacts`
 * (campo `linkedin_url` é especialmente útil para enrichment posterior).
 */
export interface LinkedinContact {
    full_name: string;
    title: string;
    linkedin_url: string;
    headline?: string;
    location?: string;
    role?: ContactRole;
}

/**
 * Shape FLAT obrigatório. Tudo o que não cabe nos campos flat vai para `raw`.
 */
export interface DatasetItem {
    name: string;
    nif: string | null;
    sector: Sector | null;
    provincia: Provincia;              // OBRIGATÓRIO — sem província, descarta item
    website: string | null;
    source: 'linkedin';                // este Actor só emite 'linkedin'
    scraped_at: string;                // ISO 8601
    raw: {
        linkedin_company_url?: string;
        headcount?: string;
        industry_raw?: string;
        contacts?: LinkedinContact[];
        [k: string]: unknown;
    };
}

// ============================================================================
// RAW SHAPES — output cru vindo dos Actors orquestrados, antes de normalização.
//
// Como cada Actor da Apify Store devolve um shape diferente, o orchestrator
// é responsável por mapear o output bruto para estes RawShapes ANTES de
// chamar normalize. Mantemos os campos opcionais e tolerantes.
// ============================================================================

export interface RawLinkedinContact {
    fullName?: string;
    title?: string;
    linkedinUrl?: string;
    headline?: string;
    location?: string;
}

export interface RawLinkedinCompany {
    name?: string;
    nif?: string;                       // opcional — input pode trazer (mode=from_companies)
    industryRaw?: string;               // texto livre do LinkedIn
    locationRaw?: string;               // "Luanda, Angola", etc.
    website?: string;
    linkedinUrl?: string;
    headcount?: string;                 // "51-200 employees"
    description?: string;
    contacts: RawLinkedinContact[];
}

// ============================================================================
// NORMALIZAÇÃO RAW -> CONTRATO
// ============================================================================

const VALID_ROLES: ReadonlySet<ContactRole> = new Set([
    'gerente',
    'socio',
    'administrador',
    'representante',
    'decisor',
    'other',
]);

/**
 * Constrói um LinkedinContact a partir do RawLinkedinContact.
 * Devolve null se faltar full_name OU linkedin_url (ambos obrigatórios — sem
 * eles o contacto não vale a pena guardar).
 */
function buildContact(raw: RawLinkedinContact): LinkedinContact | null {
    const fullName = raw.fullName?.trim();
    if (!fullName) return null;
    const linkedinUrl = normalizeLinkedinUrl(raw.linkedinUrl);
    if (!linkedinUrl) return null;

    const title = raw.title?.trim() ?? '';
    if (!title) return null;

    const contact: LinkedinContact = {
        full_name: fullName,
        title,
        linkedin_url: linkedinUrl,
    };
    const headline = raw.headline?.trim();
    if (headline) contact.headline = headline;
    const location = raw.location?.trim();
    if (location) contact.location = location;

    const role = mapTitleToRole(title);
    if (role && VALID_ROLES.has(role)) contact.role = role;
    return contact;
}

/**
 * Função principal: pega RawLinkedinCompany e devolve item FLAT do dataset
 * ou null se faltar:
 *   - `name`
 *   - `provincia` mapeável para o enum
 *
 * Regras:
 * - sector é null quando industry não bate em nenhuma keyword (NÃO inventa 'other')
 * - NIF normalizado se o input trouxer (vindo de mode=from_companies do irgc)
 * - contacts vai sempre para `raw.contacts` (lista, pode estar vazia)
 */
export function buildDatasetItem(raw: RawLinkedinCompany): DatasetItem | null {
    const name = raw.name?.trim();
    if (!name) return null;

    const provincia = normalizeProvinciaFromLocation(raw.locationRaw);
    if (!provincia) return null;

    const nif = normalizeNIF(raw.nif) ?? null;
    const sector = mapSectorFromIndustry(raw.industryRaw);
    const website = normalizeWebsite(raw.website) ?? null;
    const linkedinCompanyUrl = normalizeLinkedinUrl(raw.linkedinUrl);

    const contacts = raw.contacts
        .map((c) => buildContact(c))
        .filter((c): c is LinkedinContact => c !== null);

    const rawBucket: DatasetItem['raw'] = {
        contacts,
    };
    if (linkedinCompanyUrl) rawBucket.linkedin_company_url = linkedinCompanyUrl;
    if (raw.headcount) rawBucket.headcount = raw.headcount.trim();
    if (raw.industryRaw) rawBucket.industry_raw = raw.industryRaw.trim();
    if (raw.description?.trim()) rawBucket.description = raw.description.trim();
    if (raw.locationRaw?.trim()) rawBucket.location_raw = raw.locationRaw.trim();

    return {
        name,
        nif,
        sector,
        provincia,
        website,
        source: 'linkedin',
        scraped_at: new Date().toISOString(),
        raw: rawBucket,
    };
}
