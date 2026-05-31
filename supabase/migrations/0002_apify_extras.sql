-- ============================================================================
-- AngoConnect — Migration 0002 — Apify extras
-- ----------------------------------------------------------------------------
-- Adiciona suporte a:
--   1. Campos extra do contrato Apify (address, phone, email, registration_date,
--      capital_social, role, etc.) que não cabem nas colunas dedicadas — vão
--      para uma coluna jsonb `extra` em `companies` e `contacts`.
--   2. Coluna `apify_run_id` (text) em ambas as tabelas para audit trail —
--      permite saber qual run criou ou actualizou cada row.
--
-- Idempotente: usa `if not exists`.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- companies — coluna extra (jsonb) + apify_run_id (text)
-- ----------------------------------------------------------------------------
alter table public.companies
  add column if not exists extra jsonb not null default '{}'::jsonb;

comment on column public.companies.extra is
  'Campos opcionais que vêm dos scrapers (Apify) e não têm coluna dedicada: address, phone, email, registration_date, capital_social, etc.';

alter table public.companies
  add column if not exists apify_run_id text;

comment on column public.companies.apify_run_id is
  'ID da run Apify que inseriu/actualizou esta empresa, para audit trail.';


-- ----------------------------------------------------------------------------
-- contacts — coluna extra (jsonb) + apify_run_id (text)
-- ----------------------------------------------------------------------------
alter table public.contacts
  add column if not exists extra jsonb not null default '{}'::jsonb;

comment on column public.contacts.extra is
  'Campos opcionais do payload Apify que não têm coluna dedicada (e.g. role, phone alternativo).';

alter table public.contacts
  add column if not exists apify_run_id text;

comment on column public.contacts.apify_run_id is
  'ID da run Apify que inseriu/actualizou este contacto, para audit trail.';


-- ----------------------------------------------------------------------------
-- Índices GIN em `extra` para queries futuras (filtros tipo extra->>'phone').
-- jsonb_path_ops é mais compacto e rápido para queries `@>`/path.
-- ----------------------------------------------------------------------------
create index if not exists idx_companies_extra_gin
  on public.companies using gin (extra jsonb_path_ops);

create index if not exists idx_contacts_extra_gin
  on public.contacts using gin (extra jsonb_path_ops);


-- ----------------------------------------------------------------------------
-- Índices em apify_run_id — útil para reprocessar uma run específica
-- ----------------------------------------------------------------------------
create index if not exists idx_companies_apify_run_id
  on public.companies (apify_run_id)
  where apify_run_id is not null;

create index if not exists idx_contacts_apify_run_id
  on public.contacts (apify_run_id)
  where apify_run_id is not null;


-- ============================================================================
-- FIM — 0002_apify_extras.sql
-- ============================================================================
