/**
 * AngoConnect — Validadores Zod do contrato Apify
 * ---------------------------------------------------------------------------
 * Schemas que validam:
 *   1. O payload do webhook do Apify (`apifyWebhookPayloadSchema`).
 *   2. Cada item do dataset produzido pelos actors (`irgcDatasetItemSchema`).
 *
 * O contrato é partilhado com o Apify Data Engineer. Se mudar aqui, tem de
 * mudar do lado do actor (e vice-versa).
 *
 * ---------------------------------------------------------------------------
 * Shape canónico (CLAUDE.md → "Apify — convenções"):
 *
 *   interface IRGCDatasetItem {
 *     name: string;
 *     nif: string | null;
 *     sector: string | null;
 *     provincia: string;
 *     website: string | null;
 *     source: 'irgc' | 'linkedin' | 'bue' | 'news' | 'manual';
 *     scraped_at: string;            // ISO 8601
 *     raw: Record<string, unknown>;  // dados originais sem transformação
 *   }
 *
 * Notas importantes:
 *  - `provincia` é OBRIGATÓRIA (string) — não opcional.
 *  - `nif` e `sector` são chaves obrigatórias mas podem ser `null`.
 *  - Não há wrapper `company` nem `contacts[]` aninhados. Os contactos crus
 *    (se vierem do scraper) viajam dentro de `raw` e SÃO IGNORADOS pelo
 *    Backend em M1.0/M1.2. O `linkedin-scraper` (M1.3) é que vai processar
 *    contactos.
 */

import { z } from 'zod';
import {
  DATASET_SOURCES,
  PROVINCIAS,
  SECTORS,
} from '@/lib/constants/angola';

// ---------------------------------------------------------------------------
// Dataset item (shape FLAT — alinhado com CLAUDE.md)
// ---------------------------------------------------------------------------

/**
 * Aceita string trim() não-vazia ou null/undefined → converte para `null`.
 * Strings vazias depois de trim também viram `null`.
 */
const nullableTrimmedString = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => {
    if (v === null || v === undefined) return null;
    const trimmed = v.trim();
    return trimmed.length === 0 ? null : trimmed;
  });

/** Sector: enum válido ou null (sem `other`). */
const sectorOrNull = z
  .union([z.enum(SECTORS), z.null(), z.undefined()])
  .transform((v) => (v === undefined ? null : v));

export const irgcDatasetItemSchema = z.object({
  name: z.string().trim().min(1, 'name vazio'),
  nif: nullableTrimmedString,
  sector: sectorOrNull,
  provincia: z.enum(PROVINCIAS),
  website: nullableTrimmedString,
  source: z.enum(DATASET_SOURCES),
  scraped_at: z.string().datetime({ offset: true }),
  raw: z.record(z.string(), z.unknown()),
});

export const irgcDatasetItemArraySchema = z.array(irgcDatasetItemSchema);

export type IRGCDatasetItem = z.infer<typeof irgcDatasetItemSchema>;

// ---------------------------------------------------------------------------
// Webhook payload (Apify Webhooks v2)
// ---------------------------------------------------------------------------

/**
 * Apify dispara webhooks com este envelope. O dataset propriamente dito não
 * vem no payload — é referenciado por `resource.defaultDatasetId` e tem de
 * ser obtido com uma chamada à Apify Data API.
 *
 * Reference: https://docs.apify.com/platform/integrations/webhooks/events
 */
export const apifyWebhookPayloadSchema = z.object({
  userId: z.string(),
  createdAt: z.string().datetime({ offset: true }),
  eventType: z.enum([
    'ACTOR.RUN.SUCCEEDED',
    'ACTOR.RUN.FAILED',
    'ACTOR.RUN.TIMED_OUT',
    'ACTOR.RUN.ABORTED',
    'ACTOR.RUN.CREATED',
    'ACTOR.RUN.RESURRECTED',
  ]),
  eventData: z.object({
    actorId: z.string(),
    actorRunId: z.string(),
  }),
  resource: z.object({
    id: z.string(),
    actId: z.string(),
    status: z.string(),
    defaultDatasetId: z.string(),
    defaultKeyValueStoreId: z.string().optional(),
    startedAt: z.string().datetime({ offset: true }).optional(),
    finishedAt: z.string().datetime({ offset: true }).optional(),
  }),
});

export type ApifyWebhookPayload = z.infer<typeof apifyWebhookPayloadSchema>;
