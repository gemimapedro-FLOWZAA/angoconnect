-- ============================================================================
-- AngoConnect — Migration 0009 — email_templates + seed de templates PT
-- ----------------------------------------------------------------------------
-- M3.2 (Outreach Builder) introduz a biblioteca de templates de email
-- reutilizáveis. O builder de sequência drag-and-drop apresenta um picker
-- de templates já escritos em PT-AO, prontos para o utilizador adoptar e
-- adaptar com placeholders ({{first_name}}, {{company_name}}, etc.).
--
-- Modelo dual: `workspace_id` é NULLABLE.
--   * NULL  → template do SISTEMA (visível a todos os workspaces; só
--             editável via service_role / migration). 6 destes são criados
--             no seed em baixo (intro, follow_up x2, check_in, break_up,
--             reactivação).
--   * NOT NULL → template PRIVADO do workspace (criado/editado pelos
--                membros do workspace; nunca tem `is_system = true`).
--
-- Esta migration entrega:
--   1. Função `extract_template_variables(text)` — utilitária que extrai
--      placeholders `{{var}}` para o array `variables` na tabela.
--   2. Tabela `email_templates` + constraints + índices.
--   3. Trigger `handle_email_template_variables` que repopula `variables`
--      automaticamente em INSERT/UPDATE de subject/body.
--   4. Trigger `set_updated_at` (reutiliza `handle_updated_at`).
--   5. RLS policies (select público OR membro; mutações só workspace_id
--      NOT NULL e is_system=false).
--   6. Seed dos 6 templates do sistema em PT-AO.
--
-- DECISÕES (sem consultar):
--   * **Ordem dos objectos**: 1) função extract, 2) tabela, 3) função do
--     trigger, 4) trigger, 5) trigger updated_at, 6) RLS, 7) seed.
--     O seed beneficia do trigger (`variables` populado automaticamente),
--     mas mantenho `variables` explícito no INSERT como cinto+suspensórios.
--   * **`language` default = 'pt-PT'** (não 'pt-AO'), pois o seed quer
--     'pt-AO' explicitamente para os templates iniciais (mercado angolano).
--     Workspaces podem criar templates em qualquer das 3 línguas suportadas.
--   * **`is_system` é coluna física** (não derivada de `workspace_id IS NULL`)
--     para permitir, no futuro, templates de sistema com workspace_id
--     temporário (ex: templates partilhados por organização). Por agora,
--     a regra implícita é: `is_system=true` ↔ `workspace_id IS NULL`.
--     A RLS impede INSERT/UPDATE/DELETE com is_system=true por utilizadores
--     authenticated.
--   * **Limites de tamanho**: name ∈ [2,80], subject ∈ [1,300], body ∈
--     [10,10000]. Body máximo de 10k chars (~4-5 emails longos) é generoso
--     mas previne abuso.
--   * **`variables` como jsonb array de strings**: alinha com `sequences.steps`
--     (também jsonb). Permite serialização nativa para o frontend.
--   * **Função extract**: marcada `immutable` para o planeador poder usar
--     em índices funcionais no futuro; `regexp_matches(..., 'g')` é
--     determinístico para a mesma input.
--
-- Idempotência:
--   * `create or replace function`, `create table if not exists`,
--     `create index if not exists`, `drop policy if exists`, `drop trigger
--     if exists`.
--   * O seed usa `on conflict do nothing` numa constraint UNIQUE definida
--     para `(workspace_id, name)` quando `is_system = true` — assim re-correr
--     a migration não duplica os 6 templates.
-- ============================================================================


-- ============================================================================
-- 1) FUNÇÃO UTILITÁRIA — extract_template_variables
-- ----------------------------------------------------------------------------
-- Extrai o conjunto distinto de placeholders `{{var}}` de uma string.
-- Útil para popular `variables` no INSERT/UPDATE de email_templates.
-- ============================================================================

create or replace function public.extract_template_variables(p_template text)
returns text[]
language sql
immutable
as $$
  select coalesce(
    array_agg(distinct match[1] order by match[1]),
    array[]::text[]
  )
  from regexp_matches(p_template, '\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}', 'g') as match;
$$;

comment on function public.extract_template_variables(text) is
  'Extrai placeholders {{var_name}} distintos (ordenados) de uma string. Usado pelo trigger handle_email_template_variables para popular email_templates.variables automaticamente.';

grant execute on function public.extract_template_variables(text) to authenticated;


-- ============================================================================
-- 2) TABELA — email_templates
-- ============================================================================

create table if not exists public.email_templates (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid references public.workspaces(id) on delete cascade,
  name          text not null,
  category      text not null,
  subject       text not null,
  body          text not null,
  language      text not null default 'pt-PT',
  is_system     boolean not null default false,
  variables     jsonb not null default '[]'::jsonb,
  created_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint email_templates_name_length_check
    check (length(trim(name)) >= 2 and length(name) <= 80),
  constraint email_templates_category_check
    check (category in ('intro', 'follow_up', 'break_up', 'check_in', 'custom')),
  constraint email_templates_subject_length_check
    check (length(subject) >= 1 and length(subject) <= 300),
  constraint email_templates_body_length_check
    check (length(body) >= 10 and length(body) <= 10000),
  constraint email_templates_language_check
    check (language in ('pt-PT', 'pt-AO', 'en')),
  -- regra implícita: is_system=true ⇒ workspace_id IS NULL
  constraint email_templates_system_consistency_check
    check (
      (is_system = false)
      or (is_system = true and workspace_id is null)
    )
);

comment on table public.email_templates is
  'Biblioteca de templates de email reutilizáveis no Outreach Builder. workspace_id NULL + is_system=true ⇒ template do sistema (visível a todos, editável só via migration). workspace_id NOT NULL ⇒ template privado do workspace.';

comment on column public.email_templates.workspace_id is
  'NULL → template do sistema (partilhado). NOT NULL → template privado do workspace.';

comment on column public.email_templates.variables is
  'Array jsonb de strings com os placeholders detectados em subject+body. Populado automaticamente pelo trigger handle_email_template_variables.';

comment on column public.email_templates.is_system is
  'TRUE = template canónico fornecido pela plataforma (read-only para utilizadores). FALSE = template criado por um workspace.';


-- ============================================================================
-- 3) ÍNDICES
-- ============================================================================

-- Lookup rápido de templates privados do workspace (filter sidebar do builder)
create index if not exists idx_email_templates_workspace
  on public.email_templates (workspace_id)
  where workspace_id is not null;

-- Lookup rápido de templates do sistema por categoria (default tab no picker)
create index if not exists idx_email_templates_system
  on public.email_templates (category)
  where is_system = true;

-- Unique parcial para idempotência do seed: dois templates do sistema com o
-- mesmo `name` não podem coexistir. Permite `on conflict do nothing` no seed.
create unique index if not exists uq_email_templates_system_name
  on public.email_templates (name)
  where is_system = true;


-- ============================================================================
-- 4) TRIGGER FUNCTION — handle_email_template_variables
-- ----------------------------------------------------------------------------
-- Repopula `variables` a partir de subject+body em qualquer INSERT ou UPDATE
-- de subject/body. Evita que o frontend tenha de calcular isto e mantém
-- consistência se body for editado directamente via SQL.
-- ============================================================================

create or replace function public.handle_email_template_variables()
returns trigger
language plpgsql
as $$
begin
  new.variables := to_jsonb(
    public.extract_template_variables(
      coalesce(new.subject, '') || ' ' || coalesce(new.body, '')
    )
  );
  return new;
end;
$$;

comment on function public.handle_email_template_variables() is
  'Trigger function: repopula email_templates.variables a partir de subject+body em INSERT/UPDATE.';


-- ============================================================================
-- 5) TRIGGERS
-- ============================================================================

-- updated_at automático
drop trigger if exists set_updated_at on public.email_templates;
create trigger set_updated_at
  before update on public.email_templates
  for each row execute function public.handle_updated_at();

-- variables automático (INSERT + UPDATE de subject/body)
drop trigger if exists trg_email_templates_variables on public.email_templates;
create trigger trg_email_templates_variables
  before insert or update of subject, body on public.email_templates
  for each row execute function public.handle_email_template_variables();


-- ============================================================================
-- 6) RLS — ROW-LEVEL SECURITY
-- ============================================================================

alter table public.email_templates enable row level security;

-- SELECT: vê templates do sistema (workspace_id IS NULL) OU privados do
-- workspace do qual é membro.
drop policy if exists email_templates_select on public.email_templates;
create policy email_templates_select
  on public.email_templates
  for select
  to authenticated
  using (
    workspace_id is null
    or public.is_workspace_member(workspace_id)
  );

-- INSERT: só rows com workspace_id NOT NULL, membro do workspace, e
-- is_system=false. Bloqueia criação de templates do sistema por utilizadores.
drop policy if exists email_templates_insert on public.email_templates;
create policy email_templates_insert
  on public.email_templates
  for insert
  to authenticated
  with check (
    workspace_id is not null
    and public.is_workspace_member(workspace_id)
    and is_system = false
  );

-- UPDATE: só templates do workspace do qual é membro e que NÃO são do
-- sistema. Tentativas de editar templates do sistema falham (workspace_id
-- IS NULL na row → ambas condições falsas).
drop policy if exists email_templates_update on public.email_templates;
create policy email_templates_update
  on public.email_templates
  for update
  to authenticated
  using (
    workspace_id is not null
    and public.is_workspace_member(workspace_id)
    and is_system = false
  )
  with check (
    workspace_id is not null
    and public.is_workspace_member(workspace_id)
    and is_system = false
  );

-- DELETE: mesmo critério do UPDATE.
drop policy if exists email_templates_delete on public.email_templates;
create policy email_templates_delete
  on public.email_templates
  for delete
  to authenticated
  using (
    workspace_id is not null
    and public.is_workspace_member(workspace_id)
    and is_system = false
  );


-- ============================================================================
-- 7) SEED — 6 templates do sistema (PT-AO)
-- ----------------------------------------------------------------------------
-- Inseridos com workspace_id = NULL, is_system = true.
-- O trigger `trg_email_templates_variables` calcula `variables` automaticamente.
-- ON CONFLICT (uq_email_templates_system_name) DO NOTHING para idempotência.
-- ============================================================================

-- 1. Intro — Conexão inicial
insert into public.email_templates (
  workspace_id, name, category, subject, body, language, is_system
) values (
  null,
  'Intro — Conexão inicial',
  'intro',
  '{{first_name}}, uma ideia rápida para {{company_name}}',
  E'Olá {{first_name}},\n\n' ||
  E'Reparei que a {{company_name}} actua no sector e vi que estão a crescer.\n\n' ||
  E'Trabalhamos com várias empresas angolanas a ajudar a {{value_prop}}.\n' ||
  E'Faz sentido marcarmos uma conversa de 15 minutos esta semana?\n\n' ||
  E'Cumprimentos,\n{{sender_name}}',
  'pt-AO',
  true
)
on conflict on constraint uq_email_templates_system_name do nothing;

-- 2. Follow-up — Dia 3
insert into public.email_templates (
  workspace_id, name, category, subject, body, language, is_system
) values (
  null,
  'Follow-up — Dia 3',
  'follow_up',
  'Re: {{first_name}}, uma ideia rápida para {{company_name}}',
  E'Olá {{first_name}},\n\n' ||
  E'Só queria confirmar que recebeste o meu email anterior.\n\n' ||
  E'Sei que tens muito que fazer — basta uma resposta curta a dizer se faz sentido ou não.\n\n' ||
  E'Cumprimentos,\n{{sender_name}}',
  'pt-AO',
  true
)
on conflict on constraint uq_email_templates_system_name do nothing;

-- 3. Follow-up — Dia 7 com valor
insert into public.email_templates (
  workspace_id, name, category, subject, body, language, is_system
) values (
  null,
  'Follow-up — Dia 7 (valor)',
  'follow_up',
  'Caso de estudo: como ajudámos a [empresa similar]',
  E'Olá {{first_name}},\n\n' ||
  E'Sei que está atarefado, então vou ser breve.\n\n' ||
  E'Ajudámos recentemente uma empresa angolana parecida com a {{company_name}} a {{specific_outcome}}. Os resultados foram interessantes.\n\n' ||
  E'Anexo a apresentação se tiveres 2 minutos para ver.\n\n' ||
  E'{{sender_name}}',
  'pt-AO',
  true
)
on conflict on constraint uq_email_templates_system_name do nothing;

-- 4. Check-in suave — Dia 10
insert into public.email_templates (
  workspace_id, name, category, subject, body, language, is_system
) values (
  null,
  'Check-in suave — Dia 10',
  'check_in',
  '{{first_name}}, ainda faz sentido?',
  E'Olá {{first_name}},\n\n' ||
  E'Como vão as coisas na {{company_name}}?\n\n' ||
  E'Continuamos disponíveis se quiseres explorar como podemos colaborar. Diz só "sim" ou "agora não" para eu saber como proceder.\n\n' ||
  E'Cumprimentos,\n{{sender_name}}',
  'pt-AO',
  true
)
on conflict on constraint uq_email_templates_system_name do nothing;

-- 5. Break-up — Última mensagem
insert into public.email_templates (
  workspace_id, name, category, subject, body, language, is_system
) values (
  null,
  'Break-up — Última mensagem',
  'break_up',
  'Último email, {{first_name}} — devo arquivar?',
  E'Olá {{first_name}},\n\n' ||
  E'Imagino que isto não seja prioridade agora. Vou parar de enviar emails — mas a porta fica aberta.\n\n' ||
  E'Se mudar de ideias, a minha resposta está a um clique.\n\n' ||
  E'Boa semana,\n{{sender_name}}',
  'pt-AO',
  true
)
on conflict on constraint uq_email_templates_system_name do nothing;

-- 6. Reactivação — Lead frio
insert into public.email_templates (
  workspace_id, name, category, subject, body, language, is_system
) values (
  null,
  'Reactivação — Lead frio',
  'intro',
  '{{first_name}}, novidades na {{sender_company}}',
  E'Olá {{first_name}},\n\n' ||
  E'Faz algum tempo que não falamos. Houve novidades do nosso lado que podem ser relevantes para a {{company_name}}.\n\n' ||
  E'Resumindo: {{news_summary}}\n\n' ||
  E'Faz sentido voltarmos a conversar?\n\n' ||
  E'Cumprimentos,\n{{sender_name}}',
  'pt-AO',
  true
)
on conflict on constraint uq_email_templates_system_name do nothing;


-- ============================================================================
-- FIM — 0009_email_templates.sql
-- ============================================================================


-- ============================================================================
-- ROLLBACK (manual; não executar no apply normal)
-- ----------------------------------------------------------------------------
-- Para reverter esta migration, executar em ordem inversa:
--
--   -- Apagar seed
--   delete from public.email_templates where is_system = true;
--
--   -- Apagar triggers
--   drop trigger if exists trg_email_templates_variables on public.email_templates;
--   drop trigger if exists set_updated_at on public.email_templates;
--
--   -- Apagar policies
--   drop policy if exists email_templates_select on public.email_templates;
--   drop policy if exists email_templates_insert on public.email_templates;
--   drop policy if exists email_templates_update on public.email_templates;
--   drop policy if exists email_templates_delete on public.email_templates;
--
--   -- Apagar índices
--   drop index if exists public.idx_email_templates_workspace;
--   drop index if exists public.idx_email_templates_system;
--   drop index if exists public.uq_email_templates_system_name;
--
--   -- Apagar tabela (cascade para dependências)
--   drop table if exists public.email_templates cascade;
--
--   -- Apagar funções
--   drop function if exists public.handle_email_template_variables();
--   drop function if exists public.extract_template_variables(text);
--
-- ============================================================================
