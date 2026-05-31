import { log } from 'apify';

/**
 * Wrapper fino sobre o logger do Apify para mantermos um padrão de mensagens
 * uniforme: [contexto] mensagem { ...payload }
 *
 * Mesmo formato usado no irgc-scraper.
 */
export const logger = {
    info(context: string, message: string, payload?: Record<string, unknown>): void {
        log.info(`[${context}] ${message}`, payload);
    },
    warn(context: string, message: string, payload?: Record<string, unknown>): void {
        log.warning(`[${context}] ${message}`, payload);
    },
    error(context: string, message: string, payload?: Record<string, unknown>): void {
        log.error(`[${context}] ${message}`, payload);
    },
    debug(context: string, message: string, payload?: Record<string, unknown>): void {
        log.debug(`[${context}] ${message}`, payload);
    },
};

export type Logger = typeof logger;
