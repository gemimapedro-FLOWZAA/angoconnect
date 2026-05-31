-- ============================================================================
-- AngoConnect — Migration 0008 — revealed_contacts + RPC reveal_contacts
-- ----------------------------------------------------------------------------
-- M3.1 (Search & Discovery) introduz o modelo de "revelação paga" de
-- contactos públicos:
--   * Listar empresas/contactos do catálogo público (workspace_id IS NULL)
--     é GRATIS — valor de descoberta.
--   * Revelar email/telefone de um contacto público custa 1 crédito.
--   * Contactos privados (criados pelo próprio workspace) são revelados
--     gratuitamente (já são "do" workspace).
--
-- Esta migration entrega:
--   1. Tabela `revealed_contacts` (append-only, UNIQUE(workspace_id, contact_id)).
--   2. RLS policies para SELECT/INSERT.
--   3. RPC `reveal_contacts(p_workspace_id, p_contact_ids[])` — atómica,
--      filtra elegíveis, debita créditos via add_credits, INSERT em batch.
--   4. Helper `is_contact_revealed(p_workspace_id, p_contact_id)` — útil em
--      queries do API que precisam de mascarar/desmascarar campos.
--
-- DECISÕES (sem consultar):
--   * **Custo fixo 1 crédito por contacto** — alinha com CLAUDE.md
--     ("1 crédito = 1 contacto exportado"). O campo `reveal_cost` no API é
--     constante por agora; quando introduzirmos níveis (e.g. contactos
--     verificados = 2), passa a coluna na tabela `contacts`.
--   * **Idempotência via UNIQUE(workspace_id, contact_id)** — revelar 2× o
--     mesmo contacto NÃO debita 2×. A RPC filtra contactos já revelados
--     antes de chamar add_credits.
--   * **Contactos privados são free** — quando o user passa um contact_id
--     que já é do seu workspace (workspace_id = X), filtramos antes do
--     débito. Não há necessidade de inserir em revealed_contacts (já são
--     visíveis).
--   * **Limite hard de 200 contactos por chamada** (alinhado com 0007 mas
--     menor, porque reveal pode ser mais frequente). Acima disto, o
--     frontend divide em batches.
--   * **Hard limit no append: `credits_log_id` referencia a row do
--     credits_log inserida por add_credits.** Como add_credits insere 1
--     row e devolve o saldo, recuperamos o id via SELECT lastval-equivalente
--     em PL/pgSQL (RETURNING não disponível porque add_credits devolve int).
--     Estratégia: depois do add_credits, SELECT o último credits_log do
--     workspace para este reason+performed_by, dentro da mesma TX.
--   * **Helper `is_contact_revealed` em vez de array_agg em sub-query** —
--     simplifica o código dos endpoints (que podem chamá-lo no SELECT por
--     contacto). Marcada `stable` para o planeador poder cachear.
--
-- Idempotência:
--   * `create table if not exists`, `create index if not exists`.
--   * `drop policy if exists` antes de cada `create policy`.
--   * `create or replace function`.
-- ============================================================================


-- ============================================================================
-- 1) TABELA — revealed_contacts
-- ============================================================================

create table if not exists public.revealed_contacts (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  contact_id      uuid not null references public.contacts(id) on delete cascade,
  revealed_at     timestamptz not null default now(),
  performed_by    uuid references public.profiles(id) on delete set null,
  credits_log_id  uuid references public.credits_log(id) on delete set null,

  constraint revealed_contacts_unique_pair
    unique (workspace_id, contact_id)
);

comment on table public.revealed_contacts is
  'Ledger append-only: regista quando um workspace pagou para revelar um contacto público. UNIQUE(workspace_id, contact_id) garante idempotência (revelar 2× não cobra 2×). Contactos privados do workspace NÃO precisam de aparecer aqui (já são visíveis por defeito).';

comment on column public.revealed_contacts.credits_log_id is
  'FK ao credits_log da operação de débito. ON DELETE SET NULL para preservar a row de revealed_contacts mesmo se o log for purgado.';


-- ============================================================================
-- 2) ÍNDICES
-- ============================================================================

create index if not exists idx_revealed_contacts_workspace
  on public.revealed_contacts (workspace_id, revealed_at desc);

-- Índice auxiliar para o lookup mais comum: "este contacto está revelado
-- para este workspace?" — coberto pela UNIQUE acima, mas explícito por
-- legibilidade.
create index if not exists idx_revealed_contacts_contact
  on public.revealed_contacts (contact_id);


-- ============================================================================
-- 3) ROW-LEVEL SECURITY
-- ============================================================================

alter table public.revealed_contacts enable row level security;

-- SELECT: só membros do workspace.
drop policy if exists revealed_contacts_select on public.revealed_contacts;
create policy revealed_contacts_select
  on public.revealed_contacts
  for select
  to authenticated
  using (public.is_workspace_member(workspace_id));

-- INSERT: só membros do workspace (em prática, INSERT é feito via
-- security definer RPC, mas a policy é defesa em profundidade).
drop policy if exists revealed_contacts_insert on public.revealed_contacts;
create policy revealed_contacts_insert
  on public.revealed_contacts
  for insert
  to authenticated
  with check (public.is_workspace_member(workspace_id));

-- Sem UPDATE/DELETE policies — append-only.


-- ============================================================================
-- 4) HELPER — is_contact_revealed
-- ============================================================================
-- Útil para queries do API ("este contacto está revelado para este ws?").
-- Marcada stable para que o planeador a possa cachear dentro do mesmo
-- statement (e.g. SELECT ... WHERE is_contact_revealed(ws, contacts.id)).

create or replace function public.is_contact_revealed(
  p_workspace_id uuid,
  p_contact_id   uuid
)
returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.revealed_contacts rc
     where rc.workspace_id = p_workspace_id
       and rc.contact_id   = p_contact_id
  );
$$;

comment on function public.is_contact_revealed(uuid, uuid) is
  'Helper estável: TRUE se o contacto já foi revelado pelo workspace. Útil em SELECTs do API para decidir mascarar email/phone.';

revoke all on function public.is_contact_revealed(uuid, uuid) from public;
grant execute on function public.is_contact_revealed(uuid, uuid) to authenticated, service_role;


-- ============================================================================
-- 5) RPC — reveal_contacts
-- ============================================================================
-- Fluxo (tudo numa transacção, lock pessimista no workspace via add_credits):
--   a) Validações: auth.uid() not null, p_workspace_id not null, user é membro.
--   b) Filtra p_contact_ids → apenas elegíveis a cobrança:
--        - Existem em `contacts`.
--        - Visíveis ao workspace (public OR já do workspace).
--        - NÃO são privados do próprio workspace (estes são free → não
--          inserir em revealed_contacts).
--        - NÃO estão já revelados para este workspace.
--   c) Conta v_to_charge.
--      Se 0 → retorna (0, already_revealed, 0, saldo_actual) sem mexer
--      em créditos.
--   d) DEBIT via add_credits(workspace, -v_to_charge, 'contact_reveal',
--      user, 'contact_batch', null). Se falhar (P0001), propaga.
--   e) Lê o credits_log_id da row inserida (último log deste ws+user+reason
--      desta transacção — janela mínima porque tudo na mesma TX).
--   f) INSERT em revealed_contacts (batch) com credits_log_id.
--   g) Retorna {revealed_count, already_revealed_count, credits_debited, new_balance}.
--
-- NOTA: `credits_log` constraint `credits_log_reason_check` (0001) não inclui
-- 'contact_reveal'. Esta migration alarga a constraint para o suportar.

-- Primeiro: alargar a constraint de credits_log.reason para aceitar 'contact_reveal'.
alter table public.credits_log
  drop constraint if exists credits_log_reason_check;

alter table public.credits_log
  add constraint credits_log_reason_check
  check (
    reason in (
      'contact_export',
      'contact_reveal',
      'sequence_enrollment',
      'plan_renewal',
      'manual_adjust',
      'refund',
      'signup_bonus'
    )
  );

comment on constraint credits_log_reason_check on public.credits_log is
  'Enum de motivos de movimento. Alargado em 0008 para aceitar contact_reveal (revelar contacto público).';


create or replace function public.reveal_contacts(
  p_workspace_id uuid,
  p_contact_ids  uuid[]
)
returns table (
  revealed_count           int,
  already_revealed_count   int,
  credits_debited          int,
  new_balance              int
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id              uuid := auth.uid();
  v_input_count          int;
  v_to_charge            int;
  v_already_revealed     int;
  v_new_balance          int;
  v_credits_log_id       uuid;
begin
  -- ------------------------------------------------------------------
  -- 1) Auth obrigatória.
  -- ------------------------------------------------------------------
  if v_user_id is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  -- ------------------------------------------------------------------
  -- 2) Validações de input.
  -- ------------------------------------------------------------------
  if p_workspace_id is null then
    raise exception 'workspace_id_required' using errcode = '22023';
  end if;

  if not public.is_workspace_member(p_workspace_id) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  if p_contact_ids is null or array_length(p_contact_ids, 1) is null then
    raise exception 'contact_ids_required' using errcode = '22023';
  end if;

  v_input_count := array_length(p_contact_ids, 1);

  if v_input_count > 200 then
    raise exception 'too_many_contacts'
      using errcode = '22023',
            detail  = jsonb_build_object(
              'requested', v_input_count,
              'max_per_call', 200
            )::text;
  end if;

  -- ------------------------------------------------------------------
  -- 3) Tabela temporária com contactos elegíveis a cobrança.
  --
  --    Elegível = contacto público (workspace_id IS NULL) que ainda não
  --    está em revealed_contacts para este workspace.
  --
  --    Contactos privados do workspace (workspace_id = p_workspace_id)
  --    são free → excluídos via LEFT JOIN.
  --
  --    Contactos de OUTROS workspaces são invisíveis → naturalmente
  --    excluídos pelo predicado `workspace_id IS NULL`.
  -- ------------------------------------------------------------------
  drop table if exists pg_temp.tmp_reveal_eligible;

  create temporary table tmp_reveal_eligible
    on commit drop
    as
    select c.id as contact_id
      from public.contacts c
     where c.id = any(p_contact_ids)
       and c.workspace_id is null
       and not exists (
         select 1
           from public.revealed_contacts rc
          where rc.workspace_id = p_workspace_id
            and rc.contact_id   = c.id
       );

  select count(*)::int into v_to_charge from tmp_reveal_eligible;

  -- Conta também "já revelados" (públicos que já estão em revealed_contacts).
  -- Útil para o resumo devolvido ao chamador.
  select count(*)::int
    into v_already_revealed
    from public.contacts c
    join public.revealed_contacts rc
      on rc.contact_id = c.id
     and rc.workspace_id = p_workspace_id
   where c.id = any(p_contact_ids)
     and c.workspace_id is null;

  -- ------------------------------------------------------------------
  -- 4) Se nada elegível, sai cedo sem tocar em créditos.
  -- ------------------------------------------------------------------
  if v_to_charge = 0 then
    select w.credits_remaining
      into v_new_balance
      from public.workspaces w
     where w.id = p_workspace_id;

    revealed_count         := 0;
    already_revealed_count := v_already_revealed;
    credits_debited        := 0;
    new_balance            := coalesce(v_new_balance, 0);
    return next;
    return;
  end if;

  -- ------------------------------------------------------------------
  -- 5) Débito atómico via add_credits. Propaga P0001 (insufficient_credits)
  --    se o saldo não chegar. Lock pessimista no workspace lá dentro.
  -- ------------------------------------------------------------------
  v_new_balance := public.add_credits(
    p_workspace_id        := p_workspace_id,
    p_amount              := -v_to_charge,
    p_reason              := 'contact_reveal',
    p_performed_by        := v_user_id,
    p_related_entity_type := 'contact_batch',
    p_related_entity_id   := null
  );

  -- ------------------------------------------------------------------
  -- 6) Recupera o id do credits_log que add_credits acabou de inserir.
  --    Como toda esta função corre numa única transacção, o último
  --    credits_log para este workspace + reason + performed_by é o nosso.
  -- ------------------------------------------------------------------
  select cl.id
    into v_credits_log_id
    from public.credits_log cl
   where cl.workspace_id = p_workspace_id
     and cl.reason       = 'contact_reveal'
     and cl.performed_by = v_user_id
   order by cl.created_at desc
   limit 1;

  -- ------------------------------------------------------------------
  -- 7) INSERT em batch para revealed_contacts.
  --    `on conflict do nothing` é safety net adicional contra race
  --    conditions (duas chamadas concorrentes com o mesmo contact_id).
  -- ------------------------------------------------------------------
  insert into public.revealed_contacts (
    workspace_id,
    contact_id,
    performed_by,
    credits_log_id
  )
  select
    p_workspace_id,
    tre.contact_id,
    v_user_id,
    v_credits_log_id
  from tmp_reveal_eligible tre
  on conflict (workspace_id, contact_id) do nothing;

  -- ------------------------------------------------------------------
  -- 8) Retorna resumo.
  -- ------------------------------------------------------------------
  revealed_count         := v_to_charge;
  already_revealed_count := v_already_revealed;
  credits_debited        := v_to_charge;
  new_balance            := v_new_balance;
  return next;
end;
$$;

comment on function public.reveal_contacts(uuid, uuid[]) is
  'Revela contactos públicos para um workspace. Filtra eligíveis (públicos + não revelados), debita 1 crédito por contacto via add_credits, INSERT em revealed_contacts. Idempotente — revelar 2× não cobra 2×. Limit 200 contactos/call. Raises: unauthorized (42501), validações (22023), insufficient_credits (P0001).';


-- ============================================================================
-- 6) PERMISSÕES
-- ============================================================================

revoke all on function public.reveal_contacts(uuid, uuid[]) from public;
grant execute on function public.reveal_contacts(uuid, uuid[])
  to authenticated, service_role;


-- ============================================================================
-- FIM — 0008_revealed_contacts.sql
-- ============================================================================


-- ============================================================================
-- ROLLBACK (referência — NÃO executar):
-- ----------------------------------------------------------------------------
-- drop function if exists public.reveal_contacts(uuid, uuid[]);
-- drop function if exists public.is_contact_revealed(uuid, uuid);
-- drop policy if exists revealed_contacts_insert on public.revealed_contacts;
-- drop policy if exists revealed_contacts_select on public.revealed_contacts;
-- drop index if exists public.idx_revealed_contacts_contact;
-- drop index if exists public.idx_revealed_contacts_workspace;
-- drop table if exists public.revealed_contacts;
-- alter table public.credits_log drop constraint if exists credits_log_reason_check;
-- alter table public.credits_log
--   add constraint credits_log_reason_check
--   check (reason in ('contact_export','sequence_enrollment','plan_renewal',
--                     'manual_adjust','refund','signup_bonus'));
-- ============================================================================
