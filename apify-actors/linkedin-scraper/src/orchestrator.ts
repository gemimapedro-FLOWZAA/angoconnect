import { Actor } from 'apify';
import type {
    RawLinkedinCompany,
    RawLinkedinContact,
    Provincia,
    Sector,
} from './normalize.js';
import { logger } from './utils/logger.js';

// ============================================================================
// ORCHESTRATOR
//
// Este módulo invoca Actors públicos da Apify Store via Apify.call() e
// converte os outputs (que variam entre Actors) para os RawShapes canónicos
// definidos em normalize.ts.
//
// Cada Actor da Store tem o seu próprio INPUT_SCHEMA e shape de output. Para
// manter este código robusto, fazemos parse defensivo via funções getXxx que
// tentam vários caminhos comuns (ex: item.name OR item.companyName).
//
// Quando o utilizador trocar de Actor (porque o actual fechou ou ficou
// banido), pode ser preciso ajustar essas funções getXxx. Mantém-as
// concentradas neste ficheiro.
// ============================================================================

export type Mode = 'search' | 'from_companies';

export interface SearchFilters {
    provincia: Provincia[];
    sector: Sector[];
    minHeadcount: number;
    titlesIncluded: string[];
}

export interface CompanyTarget {
    name: string;
    nif?: string;
    linkedinUrl?: string;
}

export interface OrchestratorConfig {
    mode: Mode;
    searchFilters: SearchFilters;
    companyTargets: CompanyTarget[];
    maxContactsPerCompany: number;
    maxCompanies: number;
    linkedinCompanyActorId: string;
    linkedinPeopleActorId: string;
}

/**
 * Conjunto de items que um Actor da Apify Store devolveu — agnóstico de shape.
 * Aceitamos sempre Record<string, unknown>[] e fazemos parse defensivo.
 */
type RawItem = Record<string, unknown>;

// ----------------------------------------------------------------------------
// Helpers defensivos para extrair campos de items de qualquer Actor da Store
// ----------------------------------------------------------------------------

function getString(item: RawItem, ...keys: string[]): string | undefined {
    for (const key of keys) {
        const value = item[key];
        if (typeof value === 'string' && value.trim().length > 0) return value;
    }
    return undefined;
}

function getNumber(item: RawItem, ...keys: string[]): number | undefined {
    for (const key of keys) {
        const value = item[key];
        if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return undefined;
}

function getArray(item: RawItem, ...keys: string[]): RawItem[] | undefined {
    for (const key of keys) {
        const value = item[key];
        if (Array.isArray(value)) return value.filter((v): v is RawItem => typeof v === 'object' && v !== null);
    }
    return undefined;
}

// ----------------------------------------------------------------------------
// Mapping: item bruto Apify Store -> RawLinkedinCompany
// ----------------------------------------------------------------------------

/**
 * Converte um item bruto vindo do Actor "LinkedIn Company" para RawLinkedinCompany.
 * Tenta múltiplos nomes de campos porque cada Actor da Store usa o seu.
 */
function mapToRawCompany(item: RawItem, fallback: Partial<CompanyTarget> = {}): RawLinkedinCompany {
    const headcountNumber = getNumber(item, 'employeeCount', 'employeesCount', 'staffCount');
    const headcountRaw = getString(item, 'employeeCountRange', 'companySize', 'headcount', 'staffCountRange');

    return {
        name: getString(item, 'name', 'companyName', 'title') ?? fallback.name,
        nif: fallback.nif, // NIF nunca vem do LinkedIn — só do input se fornecido
        industryRaw: getString(item, 'industry', 'industries', 'industryName'),
        locationRaw: getString(item, 'location', 'headquarter', 'headquarters', 'locationName', 'address'),
        website: getString(item, 'website', 'websiteUrl', 'companyWebsite'),
        linkedinUrl: getString(item, 'linkedinUrl', 'companyUrl', 'url', 'profileUrl') ?? fallback.linkedinUrl,
        headcount: headcountRaw ?? (headcountNumber ? `${headcountNumber} employees` : undefined),
        description: getString(item, 'description', 'about', 'tagline'),
        contacts: [], // preenchido no passo 2 (people scraper)
    };
}

/**
 * Converte um item bruto vindo do Actor "LinkedIn People" para RawLinkedinContact.
 */
function mapToRawContact(item: RawItem): RawLinkedinContact {
    return {
        fullName: getString(item, 'fullName', 'name'),
        title: getString(item, 'title', 'jobTitle', 'currentPosition', 'occupation', 'headline'),
        linkedinUrl: getString(item, 'linkedinUrl', 'profileUrl', 'url'),
        headline: getString(item, 'headline', 'summary'),
        location: getString(item, 'location', 'locationName'),
    };
}

// ----------------------------------------------------------------------------
// Invocação dos Actors da Store
// ----------------------------------------------------------------------------

/**
 * Invoca o Actor de pesquisa/scrape de empresas LinkedIn e devolve os items.
 * O input enviado é genérico — assume que o Actor aceita `searchTerms`,
 * `filters` ou `companyUrls`. Cada Actor da Store interpreta à sua maneira;
 * o utilizador deve ajustar este shape ao escolher o Actor (ver README).
 */
async function callCompanyActor(
    actorId: string,
    input: Record<string, unknown>,
): Promise<RawItem[]> {
    logger.info('ORCHESTRATOR', 'Calling company Actor', { actorId, input });
    const run = await Actor.call(actorId, input, {
        // Damos margem generosa — Actors LinkedIn costumam ser lentos.
        waitSecs: 60 * 30,
    });
    if (!run) {
        logger.warn('ORCHESTRATOR', 'Company Actor returned no run', { actorId });
        return [];
    }
    if (!run.defaultDatasetId) {
        logger.warn('ORCHESTRATOR', 'Company Actor run has no dataset', { actorId, runId: run.id });
        return [];
    }
    const dataset = await Actor.openDataset(run.defaultDatasetId, { forceCloud: true });
    const { items } = await dataset.getData();
    logger.info('ORCHESTRATOR', 'Company Actor finished', {
        actorId,
        runId: run.id,
        items: items.length,
    });
    return items as RawItem[];
}

/**
 * Invoca o Actor de scrape de perfis de pessoas LinkedIn.
 * Por convenção, este Actor recebe `companyUrl` + filtro de títulos e devolve
 * uma lista de perfis. Cada Actor da Store ajusta — ver README.
 */
async function callPeopleActor(
    actorId: string,
    input: Record<string, unknown>,
): Promise<RawItem[]> {
    logger.info('ORCHESTRATOR', 'Calling people Actor', { actorId, input });
    const run = await Actor.call(actorId, input, {
        waitSecs: 60 * 30,
    });
    if (!run) {
        logger.warn('ORCHESTRATOR', 'People Actor returned no run', { actorId });
        return [];
    }
    if (!run.defaultDatasetId) {
        logger.warn('ORCHESTRATOR', 'People Actor run has no dataset', { actorId, runId: run.id });
        return [];
    }
    const dataset = await Actor.openDataset(run.defaultDatasetId, { forceCloud: true });
    const { items } = await dataset.getData();
    logger.info('ORCHESTRATOR', 'People Actor finished', {
        actorId,
        runId: run.id,
        items: items.length,
    });
    return items as RawItem[];
}

// ----------------------------------------------------------------------------
// Pipelines: search vs from_companies
// ----------------------------------------------------------------------------

/**
 * Mode='search'
 *   1. Pesquisa empresas no LinkedIn por (provincia + sector + headcount).
 *   2. Para cada empresa, procura decisores (titles do filtro).
 *   3. Devolve RawLinkedinCompany[] com contacts preenchidos.
 */
async function runSearchMode(config: OrchestratorConfig): Promise<RawLinkedinCompany[]> {
    const { searchFilters, maxCompanies, maxContactsPerCompany } = config;

    // Localização — para Angola, montamos searchTerms a partir de provincia + " Angola".
    // O Actor da Store traduz isto para a sua linguagem (location URN, keyword, ...).
    const searchTerms = searchFilters.provincia.length > 0
        ? searchFilters.provincia.map((p) => `${p} Angola`)
        : ['Angola'];

    const companyInput: Record<string, unknown> = {
        searchTerms,
        locations: searchTerms,
        countries: ['Angola'],
        minEmployeeCount: searchFilters.minHeadcount,
        maxItems: maxCompanies,
    };
    if (searchFilters.sector.length > 0) {
        // Passa industries como hint; o Actor pode ignorar.
        companyInput.industries = searchFilters.sector;
    }

    const companyItems = await callCompanyActor(config.linkedinCompanyActorId, companyInput);
    const companies: RawLinkedinCompany[] = companyItems
        .slice(0, maxCompanies)
        .map((item) => mapToRawCompany(item));

    // Para cada empresa, vai buscar decisores via people actor.
    for (const company of companies) {
        if (!company.linkedinUrl) {
            logger.warn('ORCHESTRATOR', 'Empresa sem linkedinUrl — skip contactos', {
                name: company.name,
            });
            continue;
        }
        const peopleInput: Record<string, unknown> = {
            companyUrl: company.linkedinUrl,
            companyUrls: [company.linkedinUrl],
            titles: searchFilters.titlesIncluded,
            titleKeywords: searchFilters.titlesIncluded,
            maxItems: maxContactsPerCompany,
        };
        try {
            const peopleItems = await callPeopleActor(config.linkedinPeopleActorId, peopleInput);
            company.contacts = peopleItems
                .slice(0, maxContactsPerCompany)
                .map((p) => mapToRawContact(p));
        } catch (error) {
            logger.error('ORCHESTRATOR', 'People Actor falhou para empresa', {
                company: company.name,
                error: error instanceof Error ? error.message : String(error),
            });
            // Mantém a empresa, mas sem contactos.
            company.contacts = [];
        }
    }

    return companies;
}

/**
 * Mode='from_companies'
 *   1. Recebe lista de empresas já conhecidas (vindas do irgc-scraper ou input manual).
 *   2. Resolve LinkedIn URL (se não tiver, tenta search pelo nome).
 *   3. Procura decisores para cada uma.
 */
async function runFromCompaniesMode(config: OrchestratorConfig): Promise<RawLinkedinCompany[]> {
    const { companyTargets, maxCompanies, maxContactsPerCompany, searchFilters } = config;

    const targets = companyTargets.slice(0, maxCompanies);
    const companies: RawLinkedinCompany[] = [];

    for (const target of targets) {
        let resolved: RawLinkedinCompany | undefined;

        if (target.linkedinUrl) {
            // Já temos URL — só precisamos de enriquecer com industry/location/headcount.
            const companyItems = await callCompanyActor(config.linkedinCompanyActorId, {
                companyUrls: [target.linkedinUrl],
                urls: [target.linkedinUrl],
                maxItems: 1,
            });
            const first = companyItems[0];
            if (first) {
                resolved = mapToRawCompany(first, target);
            }
        } else {
            // Procura por nome.
            const companyItems = await callCompanyActor(config.linkedinCompanyActorId, {
                searchTerms: [`${target.name} Angola`],
                locations: ['Angola'],
                countries: ['Angola'],
                maxItems: 1,
            });
            const first = companyItems[0];
            if (first) {
                resolved = mapToRawCompany(first, target);
            }
        }

        if (!resolved) {
            logger.warn('ORCHESTRATOR', 'Não foi possível resolver empresa no LinkedIn', {
                name: target.name,
            });
            continue;
        }

        // Garante que o nome original prevalece se o LinkedIn devolveu vazio.
        if (!resolved.name) resolved.name = target.name;
        if (target.nif && !resolved.nif) resolved.nif = target.nif;

        // Procura decisores
        if (resolved.linkedinUrl) {
            try {
                const peopleItems = await callPeopleActor(config.linkedinPeopleActorId, {
                    companyUrl: resolved.linkedinUrl,
                    companyUrls: [resolved.linkedinUrl],
                    titles: searchFilters.titlesIncluded,
                    titleKeywords: searchFilters.titlesIncluded,
                    maxItems: maxContactsPerCompany,
                });
                resolved.contacts = peopleItems
                    .slice(0, maxContactsPerCompany)
                    .map((p) => mapToRawContact(p));
            } catch (error) {
                logger.error('ORCHESTRATOR', 'People Actor falhou', {
                    company: resolved.name,
                    error: error instanceof Error ? error.message : String(error),
                });
                resolved.contacts = [];
            }
        } else {
            resolved.contacts = [];
        }

        companies.push(resolved);
    }

    return companies;
}

/**
 * Entry point do orchestrator. Decide o pipeline pelo mode e devolve a lista
 * crua de empresas — a normalização (RawLinkedinCompany -> DatasetItem) é
 * feita em main.ts.
 */
export async function runOrchestrator(config: OrchestratorConfig): Promise<RawLinkedinCompany[]> {
    if (config.mode === 'search') {
        return runSearchMode(config);
    }
    return runFromCompaniesMode(config);
}
