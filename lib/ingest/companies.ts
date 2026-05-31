/**
 * AngoConnect — Ingest do catálogo público de empresas
 * ---------------------------------------------------------------------------
 * Recebe items já validados pelo Zod (ver `lib/validators/apify-dataset.ts`)
 * no shape FLAT canónico do CLAUDE.md e faz upsert em `companies` como
 * catálogo público (workspace_id NULL). Bypass de RLS via cliente
 * service_role.
 *
 * Estratégia de deduplicação:
 *   - Empresas COM NIF: dedupe por NIF (índice único parcial em companies.nif).
 *   - Empresas SEM NIF: dedupe por (lower(name) + provincia). Como não temos
 *     constraint única para esse caso, fazemos SELECT + INSERT/UPDATE manuais.
 *
 * Idempotência: correr o mesmo dataset 2x produz `updated` (não `ingested`),
 * mas nunca duplica.
 *
 * Coluna `extra` (jsonb): recebe o blob `raw` integral do item Apify. Esse
 * blob é o "catch-all" canónico para tudo o que não cabe nas colunas
 * dedicadas (address, phone, email, capital_social, registration_date,
 * description, contactos crus, etc.).
 *
 * NOTA SOBRE CONTACTOS:
 *   M1.0 (este milestone) NÃO processa contactos. Se `raw.contacts` existir,
 *   é simplesmente preservado dentro de `extra.contacts` para uso futuro.
 *   O `linkedin-scraper` (M1.3) é que vai fazer ingest de contactos com a
 *   estrutura adequada (e o nome da coluna já é `name`, não `full_name`,
 *   após a migration 0003).
 *
 * Esta função NÃO consome créditos do workspace — o catálogo é público.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import type { IRGCDatasetItem } from '@/lib/validators/apify-dataset';

/**
 * Tipos parciais das tabelas que tocamos. Manualmente declarados aqui porque
 * `lib/supabase/types.ts` ainda é um placeholder (será gerado pelo Supabase
 * CLI). Quando `Database` for regenerado, este bloco pode ser removido ou
 * ajustado para reexportar `Database['public']['Tables']['companies']['Row']`.
 */
interface CompanyRow {
  id: string;
  name: string;
}

interface CompanyInsert {
  workspace_id: string | null;
  name: string;
  nif: string | null;
  sector: string | null;
  provincia: string;
  website: string | null;
  source: string;
  extra: Record<string, unknown>;
  apify_run_id: string | null;
}

/** Cast do cliente para não depender do `Database` (placeholder) actual. */
type IngestClient = SupabaseClient;

export interface IngestError {
  index: number;
  error: string;
}

export interface IngestResult {
  ingested: number;
  updated: number;
  skipped: number;
  errors: IngestError[];
}

interface IngestOptions {
  /** Apify run ID — gravado em `apify_run_id` para audit trail. */
  apifyRunId?: string;
  /**
   * Workspace ID que disparou o run, ou `null` para catálogo público.
   *
   * - `irgc` → SEMPRE `null` (catálogo público partilhado), mesmo que o run
   *   tenha sido disparado por um workspace.
   * - `linkedin` / `manual` (email-enricher) → workspace específico do caller.
   *
   * A decisão por source é feita aqui (não no caller) para garantir que
   * IRGC nunca polui o catálogo privado por engano.
   */
  workspaceId?: string | null;
}

/** Helper: normaliza string para comparação case-insensitive + trim. */
function normalize(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Resolve o `workspace_id` efectivo para um item, com base na source.
 *
 * - `irgc` → SEMPRE NULL (catálogo público), independente do ctx.
 * - Restantes (`linkedin`, `manual`, `bue`, `news`) → ctx.workspaceId
 *   (que pode ser NULL se não houver caller — comportamento legacy).
 */
function resolveWorkspaceId(
  item: IRGCDatasetItem,
  ctxWorkspaceId: string | null | undefined
): string | null {
  if (item.source === 'irgc') return null;
  return ctxWorkspaceId ?? null;
}

/**
 * Faz upsert de uma empresa e devolve o id + se foi insert ou update.
 *
 * O blob `extra` recebe directamente o `item.raw` integral — é o catch-all
 * canónico do CLAUDE.md. Não há transformação adicional aqui.
 */
async function upsertCompany(
  admin: IngestClient,
  item: IRGCDatasetItem,
  apifyRunId: string | undefined,
  ctxWorkspaceId: string | null | undefined
): Promise<{ id: string; mode: 'inserted' | 'updated' }> {
  const effectiveWorkspaceId = resolveWorkspaceId(item, ctxWorkspaceId);

  const baseRow: CompanyInsert = {
    workspace_id: effectiveWorkspaceId,
    name: item.name.trim(),
    nif: item.nif,
    sector: item.sector,
    provincia: item.provincia,
    website: item.website,
    source: item.source,
    extra: item.raw,
    apify_run_id: apifyRunId ?? null,
  };

  // ----- Caso 1: tem NIF -> dedupe por NIF (índice único parcial) -----------
  // O índice `uq_companies_nif` é único parcial WHERE nif IS NOT NULL,
  // global (sem distinguir workspace). Mantemos esse contrato — dedupe
  // mundial por NIF — e o `workspace_id` é actualizado em caso de match.
  if (item.nif) {
    const { data: existing, error: selectErr } = await admin
      .from('companies')
      .select('id')
      .eq('nif', item.nif)
      .maybeSingle()
      .overrideTypes<CompanyRow | null, { merge: false }>();

    if (selectErr) {
      throw new Error(`select por NIF falhou: ${selectErr.message}`);
    }

    if (existing) {
      const { error: updateErr } = await admin
        .from('companies')
        .update(baseRow satisfies CompanyInsert)
        .eq('id', existing.id);
      if (updateErr) {
        throw new Error(`update por NIF falhou: ${updateErr.message}`);
      }
      return { id: existing.id, mode: 'updated' };
    }

    const { data: inserted, error: insertErr } = await admin
      .from('companies')
      .insert(baseRow satisfies CompanyInsert)
      .select('id')
      .single()
      .overrideTypes<CompanyRow, { merge: false }>();
    if (insertErr) {
      throw new Error(`insert por NIF falhou: ${insertErr.message}`);
    }
    return { id: inserted.id, mode: 'inserted' };
  }

  // ----- Caso 2: sem NIF -> dedupe por (lower(name), provincia) -------------
  // O scope do dedupe respeita `workspace_id`: catálogo público dedup contra
  // catálogo público, workspace privado dedup só contra o seu próprio scope.
  const normalizedName = normalize(item.name);

  let query = admin
    .from('companies')
    .select('id, name')
    .is('nif', null)
    .eq('provincia', item.provincia)
    .ilike('name', item.name.trim())
    .limit(5);

  if (effectiveWorkspaceId === null) {
    query = query.is('workspace_id', null);
  } else {
    query = query.eq('workspace_id', effectiveWorkspaceId);
  }

  const { data: matches, error: selectErr } = await query.overrideTypes<
    CompanyRow[],
    { merge: false }
  >();

  if (selectErr) {
    throw new Error(`select por nome falhou: ${selectErr.message}`);
  }

  const exact = matches?.find(
    (row: CompanyRow) => normalize(row.name) === normalizedName
  );

  if (exact) {
    const { error: updateErr } = await admin
      .from('companies')
      .update(baseRow satisfies CompanyInsert)
      .eq('id', exact.id);
    if (updateErr) {
      throw new Error(`update por nome falhou: ${updateErr.message}`);
    }
    return { id: exact.id, mode: 'updated' };
  }

  const { data: inserted, error: insertErr } = await admin
    .from('companies')
    .insert(baseRow satisfies CompanyInsert)
    .select('id')
    .single()
    .overrideTypes<CompanyRow, { merge: false }>();
  if (insertErr) {
    throw new Error(`insert por nome falhou: ${insertErr.message}`);
  }
  return { id: inserted.id, mode: 'inserted' };
}

/**
 * Ingere uma lista de items para o catálogo público.
 *
 * - Cada item é processado independentemente: falhas individuais NÃO
 *   interrompem o resto, são acumuladas em `errors[]`.
 * - Idempotente: dedupe por NIF ou (name+provincia).
 * - NÃO processa contactos (responsabilidade do M1.3 via linkedin-scraper).
 */
export async function ingestPublicCatalog(
  items: IRGCDatasetItem[],
  options: IngestOptions = {}
): Promise<IngestResult> {
  // `Database` ainda é placeholder em `lib/supabase/types.ts`. Reduzimos o
  // cliente para `SupabaseClient` não-genérico — a segurança de tipos é
  // mantida via `.overrideTypes<>()` em cada `.select(...)`. Quando os tipos
  // forem regenerados (`supabase gen types typescript`), este cast desaparece.
  const admin: IngestClient = createAdminClient() as unknown as IngestClient;
  const { apifyRunId, workspaceId } = options;

  const result: IngestResult = {
    ingested: 0,
    updated: 0,
    skipped: 0,
    errors: [],
  };

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) {
      result.skipped += 1;
      continue;
    }

    try {
      const outcome = await upsertCompany(admin, item, apifyRunId, workspaceId);
      if (outcome.mode === 'inserted') result.ingested += 1;
      else result.updated += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[ingestPublicCatalog] item ${i} falhou: ${message}`,
        item.name
      );
      result.errors.push({ index: i, error: message });
    }
  }

  return result;
}
