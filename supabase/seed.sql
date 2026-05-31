-- ============================================================================
-- AngoConnect — Seed mínimo (catálogo público)
-- ----------------------------------------------------------------------------
-- Insere 3 empresas-âncora do mercado angolano no catálogo público
-- (workspace_id = NULL). Permite testar UI de pesquisa imediatamente após
-- `supabase db reset` sem precisar de scraper.
--
-- Sectores válidos: oil_gas | banking | telecom | construction | retail
--                   agro | healthcare | education | logistics | tech
--                   government | other
-- ============================================================================

insert into public.companies (name, sector, provincia, size, website, source, description)
values
  (
    'Sonangol',
    'oil_gas',
    'Luanda',
    'enterprise',
    'https://www.sonangol.co.ao',
    'manual',
    'Sociedade Nacional de Combustíveis de Angola — concessionária nacional do sector petrolífero.'
  ),
  (
    'Unitel',
    'telecom',
    'Luanda',
    'enterprise',
    'https://www.unitel.ao',
    'manual',
    'Maior operadora móvel de Angola.'
  ),
  (
    'Banco BAI',
    'banking',
    'Luanda',
    'enterprise',
    'https://www.bancobai.ao',
    'manual',
    'Banco Angolano de Investimentos — um dos maiores bancos comerciais do país.'
  )
on conflict do nothing;
