import { Actor } from 'apify';
import { buildDatasetItem } from './normalize.js';
import type { Provincia, RawLinkedinCompany, Sector } from './normalize.js';
import { runOrchestrator } from './orchestrator.js';
import type { CompanyTarget, Mode, OrchestratorConfig, SearchFilters } from './orchestrator.js';
import { logger } from './utils/logger.js';

interface ActorInput {
    mode?: Mode;
    searchFilters?: {
        provincia?: string[];
        sector?: string[];
        minHeadcount?: number;
        titlesIncluded?: string[];
    };
    companyTargets?: Array<{ name?: string; nif?: string; linkedinUrl?: string }>;
    maxContactsPerCompany?: number;
    maxCompanies?: number;
    linkedinCompanyActorId?: string;
    linkedinPeopleActorId?: string;
}

const VALID_SECTORS: ReadonlySet<Sector> = new Set([
    'oil_gas', 'construction', 'telecom', 'banking',
    'insurance', 'retail', 'agro', 'health',
    'education', 'logistics', 'tech', 'government',
]);

const VALID_PROVINCIAS: ReadonlySet<Provincia> = new Set([
    'Bengo', 'Benguela', 'Bié', 'Cabinda', 'Cuando Cubango',
    'Cuanza Norte', 'Cuanza Sul', 'Cunene', 'Huambo', 'Huíla',
    'Luanda', 'Lunda Norte', 'Lunda Sul', 'Malanje', 'Moxico',
    'Namibe', 'Uíge', 'Zaire',
]);

const DEFAULT_TITLES: ReadonlyArray<string> = [
    'CEO', 'Director Comercial', 'CFO', 'Director de Compras',
    'COO', 'Director Geral', 'Founder', 'Owner',
];

/**
 * Parse defensivo do input do Actor. Erra cedo se a configuração for inválida.
 */
function parseInput(input: ActorInput | null): OrchestratorConfig {
    const mode: Mode = input?.mode === 'from_companies' ? 'from_companies' : 'search';

    const searchFilters: SearchFilters = {
        provincia: (input?.searchFilters?.provincia ?? [])
            .filter((p): p is Provincia => VALID_PROVINCIAS.has(p as Provincia)),
        sector: (input?.searchFilters?.sector ?? [])
            .filter((s): s is Sector => VALID_SECTORS.has(s as Sector)),
        minHeadcount: Math.max(1, input?.searchFilters?.minHeadcount ?? 50),
        titlesIncluded: (input?.searchFilters?.titlesIncluded ?? [])
            .map((t) => t.trim())
            .filter((t) => t.length > 0),
    };
    if (searchFilters.titlesIncluded.length === 0) {
        searchFilters.titlesIncluded = [...DEFAULT_TITLES];
    }

    const companyTargets: CompanyTarget[] = (input?.companyTargets ?? [])
        .map((t) => {
            const name = t.name?.trim();
            if (!name) return null;
            const target: CompanyTarget = { name };
            if (t.nif?.trim()) target.nif = t.nif.trim();
            if (t.linkedinUrl?.trim()) target.linkedinUrl = t.linkedinUrl.trim();
            return target;
        })
        .filter((t): t is CompanyTarget => t !== null);

    const maxContactsPerCompany = Math.max(
        1,
        Math.min(input?.maxContactsPerCompany ?? 5, 50),
    );
    const maxCompanies = Math.max(1, Math.min(input?.maxCompanies ?? 100, 10_000));

    // Actor IDs: prioridade input > env > erro.
    const linkedinCompanyActorId =
        input?.linkedinCompanyActorId?.trim()
        || process.env.LINKEDIN_COMPANY_ACTOR_ID?.trim()
        || '';
    const linkedinPeopleActorId =
        input?.linkedinPeopleActorId?.trim()
        || process.env.LINKEDIN_PEOPLE_ACTOR_ID?.trim()
        || '';

    if (!linkedinCompanyActorId) {
        throw new Error(
            'Configuração inválida: defina LINKEDIN_COMPANY_ACTOR_ID via env ' +
            'ou via input "linkedinCompanyActorId". Escolhe um Actor da ' +
            'Apify Store (ex: "dev_fusion/linkedin-company-scraper") e cola o ID.',
        );
    }
    if (!linkedinPeopleActorId) {
        throw new Error(
            'Configuração inválida: defina LINKEDIN_PEOPLE_ACTOR_ID via env ' +
            'ou via input "linkedinPeopleActorId". Escolhe um Actor da ' +
            'Apify Store (ex: "apimaestro/linkedin-profile-scraper") e cola o ID.',
        );
    }

    if (mode === 'from_companies' && companyTargets.length === 0) {
        throw new Error(
            'Configuração inválida: mode="from_companies" requer "companyTargets" ' +
            'com pelo menos uma empresa.',
        );
    }

    return {
        mode,
        searchFilters,
        companyTargets,
        maxContactsPerCompany,
        maxCompanies,
        linkedinCompanyActorId,
        linkedinPeopleActorId,
    };
}

/**
 * Persiste a falha geral do Actor na Key-Value Store para inspecção posterior.
 * Mesmo padrão do irgc-scraper.
 */
async function recordFailure(context: string, error: unknown): Promise<void> {
    try {
        const store = await Actor.openKeyValueStore();
        const key = `failed-${context}-${Date.now()}`;
        await store.setValue(key, {
            context,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString(),
        });
    } catch (writeError) {
        logger.error('MAIN', 'Falha ao gravar erro na KV Store', {
            context,
            writeError: writeError instanceof Error ? writeError.message : String(writeError),
        });
    }
}

await Actor.main(async () => {
    const input = await Actor.getInput<ActorInput>();
    const config = parseInput(input);

    logger.info('MAIN', 'Starting LinkedIn scraper', {
        mode: config.mode,
        provincia: config.searchFilters.provincia,
        sector: config.searchFilters.sector,
        minHeadcount: config.searchFilters.minHeadcount,
        titles: config.searchFilters.titlesIncluded.length,
        companyTargets: config.companyTargets.length,
        maxCompanies: config.maxCompanies,
        maxContactsPerCompany: config.maxContactsPerCompany,
        companyActor: config.linkedinCompanyActorId,
        peopleActor: config.linkedinPeopleActorId,
    });

    let rawCompanies: RawLinkedinCompany[];
    try {
        rawCompanies = await runOrchestrator(config);
    } catch (error) {
        logger.error('MAIN', 'Orchestrator falhou', {
            error: error instanceof Error ? error.message : String(error),
        });
        await recordFailure('orchestrator', error);
        throw error;
    }

    logger.info('MAIN', 'Orchestrator devolveu empresas', {
        count: rawCompanies.length,
    });

    let pushed = 0;
    let droppedNoName = 0;
    let droppedNoProvincia = 0;

    for (const raw of rawCompanies) {
        const item = buildDatasetItem(raw);
        if (!item) {
            if (!raw.name?.trim()) {
                droppedNoName += 1;
                logger.debug('MAIN', 'Item descartado: sem nome', { raw });
            } else {
                droppedNoProvincia += 1;
                logger.warn('MAIN', 'Item descartado: provincia inválida', {
                    name: raw.name,
                    locationRaw: raw.locationRaw,
                });
            }
            continue;
        }
        await Actor.pushData(item);
        pushed += 1;
    }

    logger.info('MAIN', 'Scraper finished', {
        pushed,
        droppedNoName,
        droppedNoProvincia,
        total: rawCompanies.length,
    });
});
