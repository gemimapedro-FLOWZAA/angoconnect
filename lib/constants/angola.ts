/**
 * AngoConnect — Constantes Angola
 * ---------------------------------------------------------------------------
 * Enums partilhados entre validators (Zod) e a base de dados. Estes valores
 * têm de bater EXACTAMENTE com os CHECK constraints definidos em
 * `supabase/migrations/*.sql` — qualquer divergência fará com que inserts
 * no Supabase falhem com "violates check constraint".
 *
 * Mantém este ficheiro como única fonte de verdade no lado da aplicação.
 */

/**
 * Sectores económicos suportados (corresponde a companies_sector_check).
 *
 * Ordem alinhada com o CLAUDE.md (secção "Schema core do Supabase"):
 *   oil_gas, construction, telecom, banking, insurance, retail, agro,
 *   health, education, logistics, tech, government.
 *
 * Notas:
 *  - `healthcare` foi renomeado para `health` (migration 0003).
 *  - `insurance` adicionado para alinhar com CLAUDE.md.
 *  - `other` removido — empresas sem sector classificado ficam com NULL.
 */
export const SECTORS = [
  'oil_gas',
  'construction',
  'telecom',
  'banking',
  'insurance',
  'retail',
  'agro',
  'health',
  'education',
  'logistics',
  'tech',
  'government',
] as const;

export type Sector = (typeof SECTORS)[number];

/** As 18 províncias de Angola (corresponde a companies_provincia_check). */
export const PROVINCIAS = [
  'Bengo',
  'Benguela',
  'Bié',
  'Cabinda',
  'Cuando Cubango',
  'Cuanza Norte',
  'Cuanza Sul',
  'Cunene',
  'Huambo',
  'Huíla',
  'Luanda',
  'Lunda Norte',
  'Lunda Sul',
  'Malanje',
  'Moxico',
  'Namibe',
  'Uíge',
  'Zaire',
] as const;

export type Provincia = (typeof PROVINCIAS)[number];

/** Tamanhos de empresa (corresponde a companies_size_check). */
export const COMPANY_SIZES = [
  'micro',
  'small',
  'medium',
  'large',
  'enterprise',
] as const;

export type CompanySize = (typeof COMPANY_SIZES)[number];

/**
 * Roles dos contactos dentro de uma empresa.
 *
 * Nota: não existe CHECK constraint na tabela `contacts` para este campo
 * — guardamos esta informação na coluna `extra` (jsonb). Os valores aqui
 * representam o contrato com o Apify Data Engineer (validação na ingest).
 */
export const CONTACT_ROLES = [
  'gerente',
  'socio',
  'administrador',
  'representante',
  'decisor',
  'other',
] as const;

export type ContactRole = (typeof CONTACT_ROLES)[number];

/**
 * Sources reconhecidas para o catálogo público.
 * Tem de bater com o enum `source` do shape `IRGCDatasetItem` (CLAUDE.md).
 */
export const DATASET_SOURCES = [
  'irgc',
  'linkedin',
  'bue',
  'news',
  'manual',
] as const;

export type DatasetSource = (typeof DATASET_SOURCES)[number];
