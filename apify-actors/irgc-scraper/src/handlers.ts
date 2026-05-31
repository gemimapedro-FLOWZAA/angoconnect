import { Actor } from 'apify';
import type { PlaywrightCrawlingContext } from 'crawlee';
import { extractDetailUrls, extractNextPageUrl, extractRawScrape } from './extractors.js';
import { buildDatasetItem } from './normalize.js';
import type { IRGCDatasetItem, Provincia, Sector } from './normalize.js';
import { logger } from './utils/logger.js';

export type RouteLabel = 'LISTING' | 'DETAIL';

export interface ScraperState {
    /** Quantas empresas já foram empurradas para o dataset */
    scrapedCount: number;
    /** Limite máximo da run */
    maxCompanies: number;
    /** Filtro de sectores (vazio = todos) */
    sectorFilter: Set<Sector>;
    /** Filtro de províncias (vazio = todas) */
    provinciaFilter: Set<Provincia>;
}

/**
 * Decide se um item passa nos filtros configurados.
 * Shape flat: campos vivem directamente no item, não em `item.company`.
 */
function passesFilters(item: IRGCDatasetItem, state: ScraperState): boolean {
    if (state.sectorFilter.size > 0) {
        if (!item.sector || !state.sectorFilter.has(item.sector)) return false;
    }
    if (state.provinciaFilter.size > 0) {
        if (!state.provinciaFilter.has(item.provincia)) return false;
    }
    return true;
}

/**
 * Persiste uma falha na Key-Value Store para inspecção posterior.
 */
async function recordFailure(url: string, error: unknown): Promise<void> {
    const store = await Actor.openKeyValueStore();
    const key = `failed-${Buffer.from(url).toString('base64url').slice(0, 80)}`;
    await store.setValue(key, {
        url,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: new Date().toISOString(),
    });
}

/**
 * Handler para páginas de LISTAGEM: enfileira detalhes e próxima página.
 */
export async function handleListing(
    ctx: PlaywrightCrawlingContext,
    state: ScraperState,
): Promise<void> {
    const { request, page, crawler } = ctx;
    logger.info('LISTING', 'Processing listing', { url: request.url });

    try {
        await page.waitForLoadState('domcontentloaded');

        const detailUrls = await extractDetailUrls(page);
        logger.info('LISTING', `Found ${detailUrls.length} detail URLs`, { url: request.url });

        const remaining = state.maxCompanies - state.scrapedCount;
        const toEnqueue = detailUrls.slice(0, Math.max(0, remaining));
        if (toEnqueue.length > 0) {
            await crawler.addRequests(
                toEnqueue.map((u) => ({ url: u, label: 'DETAIL' satisfies RouteLabel })),
            );
        }

        // Paginação — só continua se ainda houver budget
        if (state.scrapedCount < state.maxCompanies) {
            const nextUrl = await extractNextPageUrl(page);
            if (nextUrl) {
                const absolute = new URL(nextUrl, request.url).toString();
                logger.info('LISTING', 'Queuing next page', { next: absolute });
                await crawler.addRequests([
                    { url: absolute, label: 'LISTING' satisfies RouteLabel },
                ]);
            }
        }
    } catch (error) {
        logger.error('LISTING', 'Failed to process listing', {
            url: request.url,
            error: error instanceof Error ? error.message : String(error),
        });
        await recordFailure(request.url, error);
        throw error;
    }
}

/**
 * Handler para páginas de DETALHE: extrai, normaliza, persiste no dataset.
 */
export async function handleDetail(
    ctx: PlaywrightCrawlingContext,
    state: ScraperState,
): Promise<void> {
    const { request, page } = ctx;
    logger.info('DETAIL', 'Processing detail', { url: request.url });

    if (state.scrapedCount >= state.maxCompanies) {
        logger.info('DETAIL', 'Max companies reached, skipping', { url: request.url });
        return;
    }

    try {
        await page.waitForLoadState('domcontentloaded');
        const raw = await extractRawScrape(page, request.url);
        const item = buildDatasetItem(raw);

        if (!item) {
            // `buildDatasetItem` retorna null se faltar `name` OU se `provincia`
            // não mapear para o enum. Província é obrigatória no contrato flat.
            logger.warn('DETAIL', 'Item descartado: name ou provincia inválida', {
                url: request.url,
                nameRaw: raw.company.name,
                provinciaRaw: raw.company.provinciaRaw,
            });
            return;
        }

        if (!passesFilters(item, state)) {
            logger.debug('DETAIL', 'Item filtered out', {
                url: request.url,
                sector: item.sector,
                provincia: item.provincia,
            });
            return;
        }

        await Actor.pushData(item);
        state.scrapedCount += 1;
        logger.info('DETAIL', 'Pushed item', {
            url: request.url,
            name: item.name,
            scrapedCount: state.scrapedCount,
        });
    } catch (error) {
        logger.error('DETAIL', 'Failed to process detail', {
            url: request.url,
            error: error instanceof Error ? error.message : String(error),
        });
        await recordFailure(request.url, error);
        throw error;
    }
}
