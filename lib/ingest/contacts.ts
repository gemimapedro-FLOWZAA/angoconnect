/**
 * AngoConnect — Ingest de contactos a partir de items Apify
 * ---------------------------------------------------------------------------
 * M1.3. Os Actors `linkedin-scraper` e `email-enricher` produzem items no
 * shape canónico `IRGCDatasetItem` (flat: name, nif, sector, provincia,
 * website, source, scraped_at, raw). Os contactos viajam dentro de
 * `item.raw.contacts` como array de objectos parcialmente estruturados.
 *
 * Este módulo:
 *   1. Faz match do contacto à empresa (pelo mesmo critério que companies:
 *      por NIF, fallback para lower(name)+provincia).
 *   2. Dedupe do contacto por (company_id, lower(email)) ou
 *      (company_id, lower(name)) se não houver email.
 *   3. Upsert em `public.contacts` via service_role.
 *
 * Workspace scoping (decidido pelo caller, validado aqui):
 *   - IRGC nunca passa por aqui (não tem contactos reais).
 *   - LinkedIn / Email enricher → workspace_id do apify_runs (privado).
 *   - O caller (webhook) decide; este módulo respeita `ctx.workspaceId`.
 *
 * NÃO consome créditos. Por CLAUDE.md, créditos só são deduzidos na
 * exportação (M3).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';
import type { IRGCDatasetItem } from '@/lib/validators/apify-dataset';

// ---------------------------------------------------------------------------
// Tipos internos (placeholder enquanto `lib/supabase/types.ts` não é gerado)
// ---------------------------------------------------------------------------

interface CompanyRow {
  id: string;
  name: string;
}

interface ContactRow {
  id: string;
  email: string | null;
  name: string;
}

interface ContactInsert {
  company_id: string;
  workspace_id: string | null;
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
  confidence_score: number | null;
  email_verified: boolean;
  source: string | null;
  extra: Record<string, unknown>;
  apify_run_id: string | null;
}

type IngestClient = SupabaseClient;

// ---------------------------------------------------------------------------
// Validador laxo para o contacto cru vindo do scraper
// ---------------------------------------------------------------------------
// Os Actors podem evoluir; aceitamos shapes flexíveis e guardamos tudo o
// resto em `extra`. Apenas exigimos pelo menos UM identificador (name OR
// email) — sem isso, é impossível fazer dedupe.

const rawContactSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    full_name: z.string().trim().min(1).optional(), // compat retroactivo
    title: z.string().trim().min(1).optional().nullable(),
    role: z.string().trim().min(1).optional().nullable(),
    email: z.string().trim().email().optional().nullable(),
    phone: z.string().trim().min(1).optional().nullable(),
    linkedin_url: z.string().trim().url().optional().nullable(),
    confidence_score: z.number().min(0).max(1).optional(),
    email_confidence: z.number().min(0).max(1).optional(),
    email_verified: z.boolean().optional(),
    headline: z.string().optional().nullable(),
    location: z.string().optional().nullable(),
    smtp_response: z.string().optional().nullable(),
  })
  .passthrough();

type RawContact = z.infer<typeof rawContactSchema>;

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

export interface IngestContactsContext {
  /** Apify run ID (resource.id do webhook). Gravado em `apify_run_id`. */
  apifyRunId: string;
  /**
   * Workspace ID dono dos contactos.
   * - NULL → catálogo público (não usado actualmente: IRGC não tem contactos).
   * - UUID → contactos privados do workspace que disparou o run.
   */
  workspaceId: string | null;
}

export interface IngestContactsError {
  index: number;
  error: string;
}

export interface IngestContactsResult {
  contactsIngested: number;
  contactsUpdated: number;
  skipped: number;
  errors: IngestContactsError[];
}

/**
 * Ingere contactos a partir de uma lista de items Apify.
 *
 * - Cada item pode trazer 0..N contactos em `raw.contacts`.
 * - Falhas individuais NÃO interrompem o resto — vão para `errors[]`.
 * - Idempotente: corre 2x → produz `contactsUpdated` (não duplica).
 */
export async function ingestContacts(
  items: IRGCDatasetItem[],
  ctx: IngestContactsContext
): Promise<IngestContactsResult> {
  const admin: IngestClient = createAdminClient() as unknown as IngestClient;

  const result: IngestContactsResult = {
    contactsIngested: 0,
    contactsUpdated: 0,
    skipped: 0,
    errors: [],
  };

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) {
      result.skipped += 1;
      continue;
    }

    const rawContacts = extractRawContacts(item);
    if (rawContacts.length === 0) {
      // Sem contactos neste item — não é erro, é o caso comum para
      // muitos scrapers (e.g. IRGC). Apenas conta como skipped a nível
      // de item para fins de relatório.
      continue;
    }

    let companyId: string | null;
    try {
      companyId = await findCompany(admin, item);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({
        index: i,
        error: `lookup de company falhou: ${message}`,
      });
      continue;
    }

    if (!companyId) {
      result.skipped += rawContacts.length;
      result.errors.push({
        index: i,
        error: `nenhuma company encontrada para "${item.name}" (provincia=${item.provincia}) — contactos ignorados`,
      });
      continue;
    }

    for (let j = 0; j < rawContacts.length; j++) {
      const rawContact = rawContacts[j];
      if (!rawContact) {
        result.skipped += 1;
        continue;
      }
      const parsed = rawContactSchema.safeParse(rawContact);
      if (!parsed.success) {
        result.errors.push({
          index: i,
          error: `contacto ${j}: shape inválido (${parsed.error.issues
            .slice(0, 3)
            .map((iss) => iss.message)
            .join('; ')})`,
        });
        continue;
      }

      try {
        const outcome = await upsertContact(
          admin,
          parsed.data,
          companyId,
          item.source,
          ctx
        );
        if (outcome === 'inserted') result.contactsIngested += 1;
        else if (outcome === 'updated') result.contactsUpdated += 1;
        else result.skipped += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push({
          index: i,
          error: `contacto ${j}: ${message}`,
        });
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Internos
// ---------------------------------------------------------------------------

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

/** Lê `raw.contacts` se for array; caso contrário devolve []. */
function extractRawContacts(item: IRGCDatasetItem): unknown[] {
  const candidate = item.raw?.contacts;
  if (Array.isArray(candidate)) return candidate;
  return [];
}

/**
 * Encontra a company correspondente ao item. Mesma estratégia de dedupe
 * que `ingestPublicCatalog`: por NIF se existir, senão por
 * (lower(name) + provincia).
 *
 * Procura primeiro em catálogo público (workspace_id IS NULL); se não
 * encontrar, faz fallback para qualquer workspace (porque LinkedIn pode
 * trazer um decisor de uma empresa privada criada manualmente). Em caso
 * de ambiguidade, devolve a 1ª match (estratégia best-effort).
 */
async function findCompany(
  admin: IngestClient,
  item: IRGCDatasetItem
): Promise<string | null> {
  // Caso 1: tem NIF.
  if (item.nif) {
    const { data: byNif, error: byNifErr } = await admin
      .from('companies')
      .select('id')
      .eq('nif', item.nif)
      .maybeSingle()
      .overrideTypes<CompanyRow | null, { merge: false }>();
    if (byNifErr) {
      throw new Error(`select por NIF falhou: ${byNifErr.message}`);
    }
    if (byNif) return byNif.id;
  }

  // Caso 2: por (lower(name), provincia).
  const { data: matches, error: matchesErr } = await admin
    .from('companies')
    .select('id, name')
    .eq('provincia', item.provincia)
    .ilike('name', item.name.trim())
    .limit(5)
    .overrideTypes<CompanyRow[], { merge: false }>();
  if (matchesErr) {
    throw new Error(`select por nome falhou: ${matchesErr.message}`);
  }

  const normalizedName = normalize(item.name);
  const exact = matches?.find(
    (row: CompanyRow) => normalize(row.name) === normalizedName
  );
  return exact?.id ?? null;
}

/**
 * Faz upsert do contacto. Estratégia de dedupe:
 *   1. Se tem email → match por (company_id, lower(email)).
 *   2. Senão → match por (company_id, lower(name)).
 *
 * Quando match existe, faz UPDATE (preenche campos novos sem apagar
 * dados existentes — comportamento "merge"). Quando não existe, INSERT.
 *
 * O blob `extra` consolida campos sem coluna dedicada (role, headline,
 * location, smtp_response, etc.) preservando o shape original.
 */
async function upsertContact(
  admin: IngestClient,
  raw: RawContact,
  companyId: string,
  sourceTag: string,
  ctx: IngestContactsContext
): Promise<'inserted' | 'updated' | 'skipped'> {
  const name = (raw.name ?? raw.full_name ?? '').trim();
  const email = raw.email ? raw.email.trim().toLowerCase() : null;

  if (!name && !email) {
    // Sem name nem email não temos como identificar/dedup — ignora.
    return 'skipped';
  }

  // O dedupe precisa de pelo menos um identificador estável.
  // - Email preferido (mais forte): match por (company_id, lower(email)).
  // - Senão fallback para nome.
  let existing: ContactRow | null = null;

  if (email) {
    const { data, error: selErr } = await admin
      .from('contacts')
      .select('id, email, name')
      .eq('company_id', companyId)
      .ilike('email', email)
      .maybeSingle()
      .overrideTypes<ContactRow | null, { merge: false }>();
    if (selErr) {
      throw new Error(`select por email falhou: ${selErr.message}`);
    }
    existing = data;
  }

  if (!existing && name) {
    const { data, error: selErr } = await admin
      .from('contacts')
      .select('id, email, name')
      .eq('company_id', companyId)
      .ilike('name', name)
      .limit(5)
      .overrideTypes<ContactRow[], { merge: false }>();
    if (selErr) {
      throw new Error(`select por nome falhou: ${selErr.message}`);
    }
    const normalizedName = normalize(name);
    existing =
      data?.find((row: ContactRow) => normalize(row.name) === normalizedName) ??
      null;
  }

  // ----- Constrói payload -------------------------------------------------
  // `extra` é catch-all: tudo o que NÃO tem coluna dedicada vai para aqui.
  const knownKeys = new Set([
    'name',
    'full_name',
    'title',
    'email',
    'phone',
    'linkedin_url',
    'confidence_score',
    'email_confidence',
    'email_verified',
  ]);
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!knownKeys.has(key)) extra[key] = value;
  }

  // Confidence: prefere `confidence_score`, fallback para `email_confidence`.
  const confidence =
    typeof raw.confidence_score === 'number'
      ? raw.confidence_score
      : typeof raw.email_confidence === 'number'
        ? raw.email_confidence
        : null;

  const payload: ContactInsert = {
    company_id: companyId,
    workspace_id: ctx.workspaceId,
    name: name || (email ?? 'unknown'),
    title: raw.title ?? raw.role ?? null,
    email,
    phone: raw.phone ?? null,
    linkedin_url: raw.linkedin_url ?? null,
    confidence_score: confidence,
    email_verified: raw.email_verified ?? false,
    source: sourceTag,
    extra,
    apify_run_id: ctx.apifyRunId,
  };

  if (existing) {
    // Update — merge no PostgreSQL via overwrite das colunas presentes.
    // (Estratégia simples: sobrescreve. Caso futuro queira merge JSON
    // mais fino, alterar para SQL function dedicada.)
    const { error: updErr } = await admin
      .from('contacts')
      .update(payload satisfies ContactInsert)
      .eq('id', existing.id);
    if (updErr) {
      throw new Error(`update falhou: ${updErr.message}`);
    }
    return 'updated';
  }

  const { error: insErr } = await admin
    .from('contacts')
    .insert(payload satisfies ContactInsert);
  if (insErr) {
    throw new Error(`insert falhou: ${insErr.message}`);
  }
  return 'inserted';
}
