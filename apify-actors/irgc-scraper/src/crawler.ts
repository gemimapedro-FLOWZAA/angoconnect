import { PlaywrightCrawler } from 'crawlee';
import { handleListing, handleDetail, type RouteLabel, type ScraperState } from './handlers.js';
import { logger } from './utils/logger.js';

/**
 * Domínios considerados sensíveis (gov.ao, co.ao) — forçam rate limit de 1 req/s.
 */
const SENSITIVE_DOMAIN_PATTERN = /\.(gov|co)\.ao$/i;

/**
 * Verifica se uma URL deve respeitar rate limit conservador.
 */
function isSensitiveDomain(url: string): boolean {
    try {
        return SENSITIVE_DOMAIN_PATTERN.test(new URL(url).hostname);
    } catch {
        return false;
    }
}

export interface CreateCrawlerOptions {
    state: ScraperState;
    requestsPerSecond: number;
    startUrls: string[];
}

/**
 * Cria a instância do PlaywrightCrawler configurada com:
 * - maxConcurrency 1 quando há domínios .gov.ao/.co.ao
 * - 3 retries com backoff exponencial
 * - Timeout de 60s por request
 * - Routing por label (LISTING / DETAIL)
 */
export function createCrawler(opts: CreateCrawlerOptions): PlaywrightCrawler {
    const { state, requestsPerSecond, startUrls } = opts;
    const sensitive = startUrls.some(isSensitiveDomain);
    const effectiveRps = sensitive ? 1 : requestsPerSecond;
    const maxConcurrency = sensitive ? 1 : Math.min(requestsPerSecond, 5);

    logger.info('CRAWLER', 'Initializing crawler', {
        sensitive,
        maxConcurrency,
        effectiveRps,
        maxRequests: state.maxCompanies * 2 + 50,
    });

    return new PlaywrightCrawler({
        maxConcurrency,
        maxRequestsPerMinute: effectiveRps * 60,
        // Listing pages podem gerar muitas detail pages — damos margem
        maxRequestsPerCrawl: state.maxCompanies * 2 + 50,
        requestHandlerTimeoutSecs: 60,
        navigationTimeoutSecs: 45,
        maxRequestRetries: 3,
        launchContext: {
            launchOptions: {
                headless: true,
            },
        },
        async requestHandler(ctx) {
            const label = (ctx.request.label ?? 'LISTING') as RouteLabel;
            if (label === 'DETAIL') {
                await handleDetail(ctx, state);
            } else {
                await handleListing(ctx, state);
            }
        },
        async failedRequestHandler({ request, error }) {
            logger.error('CRAWLER', 'Request failed permanently', {
                url: request.url,
                retries: request.retryCount,
                error: error instanceof Error ? error.message : String(error),
            });
        },
    });
}
