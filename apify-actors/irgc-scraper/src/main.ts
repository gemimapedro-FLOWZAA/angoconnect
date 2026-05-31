import { Actor } from 'apify';
import { createCrawler } from './crawler.js';
import type { Provincia, Sector } from './normalize.js';
import type { ScraperState } from './handlers.js';
import { logger } from './utils/logger.js';

interface ActorInput {
    startUrls?: Array<{ url: string }>;
    maxCompanies?: number;
    sectorFilter?: string[];
    provinciaFilter?: string[];
    requestsPerSecond?: number;
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

/**
 * Faz parse seguro do input, com defaults sensatos.
 */
function parseInput(input: ActorInput | null): {
    startUrls: string[];
    state: ScraperState;
    requestsPerSecond: number;
} {
    const startUrls = (input?.startUrls ?? [])
        .map((entry) => entry.url)
        .filter((url): url is string => typeof url === 'string' && url.length > 0);

    if (startUrls.length === 0) {
        throw new Error(
            'Input inválido: forneça pelo menos uma URL em "startUrls". ' +
            'Default sugerido: https://guicheunico.gov.ao/empresas',
        );
    }

    const maxCompanies = Math.max(1, Math.min(input?.maxCompanies ?? 1000, 100_000));
    const requestsPerSecond = Math.max(1, Math.min(input?.requestsPerSecond ?? 1, 5));

    const sectorFilter = new Set<Sector>(
        (input?.sectorFilter ?? []).filter((s): s is Sector =>
            VALID_SECTORS.has(s as Sector),
        ),
    );
    const provinciaFilter = new Set<Provincia>(
        (input?.provinciaFilter ?? []).filter((p): p is Provincia =>
            VALID_PROVINCIAS.has(p as Provincia),
        ),
    );

    return {
        startUrls,
        requestsPerSecond,
        state: {
            scrapedCount: 0,
            maxCompanies,
            sectorFilter,
            provinciaFilter,
        },
    };
}

await Actor.main(async () => {
    const input = await Actor.getInput<ActorInput>();
    const { startUrls, state, requestsPerSecond } = parseInput(input);

    logger.info('MAIN', 'Starting IRGC scraper', {
        startUrls: startUrls.length,
        maxCompanies: state.maxCompanies,
        sectorFilter: Array.from(state.sectorFilter),
        provinciaFilter: Array.from(state.provinciaFilter),
        requestsPerSecond,
    });

    const crawler = createCrawler({ state, requestsPerSecond, startUrls });

    await crawler.run(
        startUrls.map((url) => ({ url, label: 'LISTING' })),
    );

    logger.info('MAIN', 'Scraper finished', {
        scrapedCount: state.scrapedCount,
        maxCompanies: state.maxCompanies,
    });
});
