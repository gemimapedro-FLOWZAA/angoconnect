/**
 * AngoConnect — Helpers de datasets Apify
 * ---------------------------------------------------------------------------
 * Wrappers tipados sobre a Apify Data API que devolvem items de datasets para
 * ingestão. A validação dos items fica do lado do caller (Zod em
 * `lib/validators/apify-dataset.ts`).
 *
 * Reference: https://docs.apify.com/api/v2#/reference/datasets/item-collection
 */

import { ApifyClientError, apifyGet } from './client';

export interface FetchDatasetOptions {
  /** Timeout em ms para a chamada. Default 30s. */
  timeoutMs?: number;
  /** AbortSignal externo (combina-se com o timeout interno). */
  externalSignal?: AbortSignal;
}

/**
 * Obtém todos os items de um dataset Apify (clean=true remove campos `#debug`).
 *
 * Devolve `unknown[]` deliberadamente — quem chama deve validar com Zod.
 */
export async function fetchDatasetItems(
  datasetId: string,
  options: FetchDatasetOptions = {}
): Promise<unknown[]> {
  const data = await apifyGet<unknown>(
    `/datasets/${encodeURIComponent(datasetId)}/items`,
    {
      timeoutMs: options.timeoutMs,
      externalSignal: options.externalSignal,
      query: { clean: 'true', format: 'json' },
    }
  );

  if (!Array.isArray(data)) {
    throw new ApifyClientError(
      'Apify dataset response não é um array',
      502,
      JSON.stringify(data).slice(0, 500)
    );
  }

  return data;
}
