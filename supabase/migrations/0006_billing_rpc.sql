-- ============================================================================
-- AngoConnect — Migration 0006 — RPC de créditos + ajustes a `subscriptions`
-- ----------------------------------------------------------------------------
-- Esta migration prepara o suporte de billing (M2.2):
--   1. RPC `public.add_credits(...)` — operação atómica que actualiza
--      `workspaces.credits_remaining` e regista uma linha em `credits_log`
--      na mesma transacção. Usada por:
--        * Webhook Stripe (`invoice.payment_succeeded`) para recarregar.
--        * Endpoints autenticados de débito (e.g. export de contacto).
--        * Operações administrativas (refund, manual_adjust).
--   2. `public.credits_for_plan(p_plan text)` — mapeamento puro plan→créditos
--      consumido pelo webhook Stripe na recarga.
--   3. ALTER TABLE `subscriptions` — adiciona `cancel_at_period_end` e
--      `stripe_price_id` (úteis para reconciliação Stripe).
--   4. Trigger `trg_subscription_active_sync` — quando uma `subscription` muda
--      para `status = 'active'` (ou é inserida activa), sincroniza
--      `workspaces.plan` com o plano da subscription. NÃO faz downgrade
--      automático em cancelamento — o webhook trata desse caso explicitamente
--      no fim do período.
--
-- DECISÕES (sem consultar) — documentadas no relatório:
--   * `pro` mapeia para 999_999 créditos/período. "Ilimitado" numa coluna
--     `int` resolve-se com um valor altíssimo; assim a aritmética e o
--     `credits_log` continuam coerentes. Justificação: 999_999 dá mais de
--     32 anos a 1 export/segundo — em prática inalcançável por um humano.
--   * `add_credits` recusa `amount = 0` (evita log fantasma).
--   * `add_credits` permite `balance_after < 0` apenas se
--     `reason in ('refund', 'manual_adjust')`. Justificação: refund pode
--     legitimamente deixar a conta negativa se o user já gastou; admin pode
--     forçar ajustes em incidentes. Para qualquer outro motivo (sobretudo
--     `contact_export`/`sequence_enrollment`), o saldo nunca pode ficar < 0
--     — recusa-se com erro `insufficient_credits` (P0001) e RAISE EXCEPTION
--     dispara rollback da transacção (UPDATE é desfeito).
--   * `GRANT EXECUTE` em `add_credits` restrito a `service_role`. Justificação:
--     todas as escritas a `credits_log` vêm do servidor (webhook Stripe ou
--     endpoints autenticados que já validaram `workspace_id`). Expor a
--     função a `authenticated` permitiria abusos onde o user passa um
--     `workspace_id` arbitrário (ou um `reason` falsificado para escapar à
--     verificação de saldo). Manter server-side é mais simples e seguro.
--   * Trigger só faz upgrade automático em transições para `status='active'`.
--     Cancelamento e downgrade ficam para lógica explícita no webhook,
--     porque envolvem decidir _quando_ aplicar (período actual vs imediato).
--
-- Idempotência:
--   * `create or replace function` em todas as funções.
--   * `add column if not exists` (Postgres ≥ 9.6) nos ALTER TABLE.
--   * `drop trigger if exists` antes de recriar.
-- ============================================================================


-- ============================================================================
-- 1) AJUSTES À TABELA `subscriptions`
-- ============================================================================
-- Adiciona colunas em falta para reconciliação Stripe.
--   * `cancel_at_period_end` — flag que o Stripe envia quando o user pediu
--     para não renovar. Usada pelo webhook para decidir se mantém ou não o
--     plan no fim do período.
--   * `stripe_price_id` — qual Price (não Product) está activo. Necessário
--     para distinguir variantes do mesmo plan (e.g. mensal vs anual) e para
--     reconciliação manual quando há divergência com o painel Stripe.

alter table public.subscriptions
  add column if not exists cancel_at_period_end boolean not null default false;

alter table public.subscriptions
  add column if not exists stripe_price_id text;

comment on column public.subscriptions.cancel_at_period_end is
  'Flag espelhada do Stripe. Quando true, o webhook sabe que não deve recarregar créditos no próximo invoice e deve fazer downgrade no fim do current_period_end.';

comment on column public.subscriptions.stripe_price_id is
  'ID do Stripe Price activo (não o Product). Permite distinguir variantes (mensal/anual) e ajuda em reconciliações manuais.';


-- ============================================================================
-- 2) FUNÇÃO IMUTÁVEL — credits_for_plan
-- ============================================================================
-- Mapeamento determinístico plan → créditos por período de billing.
-- Marcada `immutable` para que o planeador a possa inlinar e cachear.
-- "Pro" é "ilimitado" no plano comercial — modelamos como 999_999 (ver
-- decisões no topo do ficheiro).

create or replace function public.credits_for_plan(p_plan text)
returns int
language sql
immutable
as $$
  select case p_plan
    when 'starter' then 500
    when 'growth'  then 2000
    when 'pro'     then 999999  -- "ilimitado" — valor altíssimo
    else 0
  end
$$;

comment on function public.credits_for_plan(text) is
  'Mapeamento puro plan→créditos por período. Consumida pelo webhook Stripe em invoice.payment_succeeded para saber quanto recarregar. "pro" devolve 999999 (modelo de "ilimitado" sem mudar tipo da coluna).';

revoke all on function public.credits_for_plan(text) from public;
grant execute on function public.credits_for_plan(text) to authenticated, service_role;


-- ============================================================================
-- 3) RPC ATÓMICA — add_credits
-- ============================================================================
-- Faz numa única transacção (= mesma linha de execução, mesmo CTID lock):
--   a) Lock pessimista da linha do workspace em `workspaces` via FOR UPDATE.
--      Evita race entre dois `invoice.payment_succeeded` concorrentes (ou um
--      payment + um export simultâneo) — o segundo bloqueia até o primeiro
--      fazer commit, garantindo `balance_after` correcto no log.
--   b) UPDATE em `workspaces.credits_remaining += amount`.
--   c) INSERT em `credits_log` com o `balance_after` calculado.
--
-- Tudo falha (ROLLBACK) se qualquer passo lançar excepção — não há janela
-- onde `credits_remaining` esteja actualizado sem entrada correspondente
-- no ledger.

create or replace function public.add_credits(
  p_workspace_id          uuid,
  p_amount                int,
  p_reason                text,
  p_performed_by          uuid default null,
  p_related_entity_type   text default null,
  p_related_entity_id     uuid default null
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current_balance int;
  v_new_balance     int;
begin
  -- ------------------------------------------------------------------
  -- 1) Validação de inputs.
  --    SQLSTATE 22023 = invalid_parameter_value.
  -- ------------------------------------------------------------------
  if p_workspace_id is null then
    raise exception 'workspace_id_required' using errcode = '22023';
  end if;

  if p_amount is null or p_amount = 0 then
    -- amount = 0 não faz sentido e geraria um log fantasma.
    raise exception 'amount_must_be_nonzero' using errcode = '22023';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  -- ------------------------------------------------------------------
  -- 2) Lock pessimista da linha do workspace.
  --    FOR UPDATE serializa qualquer outra chamada concorrente a este
  --    workspace; a transacção em curso vê o saldo correcto antes de
  --    fazer UPDATE.
  --    Se o workspace não existir, a chamada falha (NOT FOUND).
  -- ------------------------------------------------------------------
  select credits_remaining
    into v_current_balance
    from public.workspaces
   where id = p_workspace_id
   for update;

  if not found then
    raise exception 'workspace_not_found' using errcode = '22023';
  end if;

  v_new_balance := v_current_balance + p_amount;

  -- ------------------------------------------------------------------
  -- 3) Regra de saldo:
  --    * Para a maioria dos `reason`, balance_after >= 0 é obrigatório.
  --    * Excepções: `refund` e `manual_adjust` — admin pode forçar
  --      saldo negativo (ver decisões no topo).
  --    SQLSTATE P0001 = raise_exception genérico (lado app mapeia para
  --    "insufficient_credits").
  --
  --    NOTA: a constraint `credits_log_balance_nonneg_check` (definida
  --    em 0001) também impede `balance_after < 0`. Em refund/adjust,
  --    se quisermos deixar o ledger com balance_after negativo, é
  --    preciso relaxar essa constraint OU clamp em 0. Decisão: clamp
  --    em 0 (o saldo na tabela workspaces fica 0; o log regista 0).
  --    Isto mantém o invariante "balance_after >= 0" no ledger e
  --    `workspaces.credits_remaining >= 0` (constraint `workspaces_
  --    credits_nonneg_check`).
  -- ------------------------------------------------------------------
  if v_new_balance < 0 then
    if p_reason in ('refund', 'manual_adjust') then
      -- Admin força ajuste para baixo. Saldo nunca fica negativo
      -- (clamp em 0) para respeitar as constraints existentes; a
      -- intenção do operador fica registada no `amount` original do log.
      v_new_balance := 0;
    else
      -- Débito normal não pode descobrir o saldo.
      raise exception 'insufficient_credits' using errcode = 'P0001';
    end if;
  end if;

  -- ------------------------------------------------------------------
  -- 4) UPDATE do saldo no workspace. `updated_at` é gerido pelo trigger
  --    `set_updated_at` definido em 0001.
  -- ------------------------------------------------------------------
  update public.workspaces
     set credits_remaining = v_new_balance
   where id = p_workspace_id;

  -- ------------------------------------------------------------------
  -- 5) INSERT no ledger. Note-se que o `amount` registado é o original
  --    pedido pelo chamador (mesmo nos casos de clamp), preservando a
  --    intenção. `balance_after` é o estado final efectivo.
  -- ------------------------------------------------------------------
  insert into public.credits_log (
    workspace_id,
    amount,
    reason,
    balance_after,
    performed_by,
    related_entity_type,
    related_entity_id
  )
  values (
    p_workspace_id,
    p_amount,
    p_reason,
    v_new_balance,
    p_performed_by,
    p_related_entity_type,
    p_related_entity_id
  );

  -- ------------------------------------------------------------------
  -- 6) Devolve o novo saldo (útil para responder ao webhook/API).
  -- ------------------------------------------------------------------
  return v_new_balance;
end;
$$;

comment on function public.add_credits(uuid, int, text, uuid, text, uuid) is
  'RPC atómica para movimentar créditos: UPDATE workspaces.credits_remaining + INSERT credits_log na mesma transacção, com lock pessimista (FOR UPDATE) para evitar race conditions. Permite saldo a chegar a 0 em refund/manual_adjust (clamp); recusa qualquer outro débito que ultrapasse o saldo (raise insufficient_credits, P0001). Restrita a service_role.';


-- ============================================================================
-- 4) PERMISSÕES — add_credits restrito a service_role
-- ============================================================================
-- Recargas vêm do webhook Stripe (server-side, service_role).
-- Débitos vêm de endpoints autenticados que já validam workspace_id do JWT
-- antes de chamar a RPC (também com service_role no servidor).
-- NÃO conceder a `authenticated` para impedir que o cliente chame
-- directamente com `workspace_id` arbitrário.

revoke all on function public.add_credits(uuid, int, text, uuid, text, uuid) from public;
revoke all on function public.add_credits(uuid, int, text, uuid, text, uuid) from authenticated;
grant execute on function public.add_credits(uuid, int, text, uuid, text, uuid) to service_role;


-- ============================================================================
-- 5) TRIGGER — sincroniza workspaces.plan quando subscription fica activa
-- ============================================================================
-- Quando uma `subscription` muda para `status='active'` (ou é inserida
-- directamente nesse estado), copia o `plan` para `workspaces.plan`.
-- NÃO faz downgrade automático em cancelamento — esse caso fica para o
-- webhook decidir (provavelmente "mantém plano até current_period_end").

create or replace function public.handle_subscription_active()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- INSERT directo com status='active' (ex.: migração inicial) → sincroniza.
  -- UPDATE que transita para 'active' a partir de outro estado → sincroniza.
  -- Qualquer outra transição (active→canceled, etc.) é ignorada aqui.
  if new.status = 'active'
     and (tg_op = 'INSERT' or old.status is distinct from 'active')
  then
    update public.workspaces
       set plan       = new.plan,
           updated_at = now()
     where id = new.workspace_id;
  end if;

  return new;
end;
$$;

comment on function public.handle_subscription_active() is
  'Trigger function: sincroniza workspaces.plan com subscription.plan quando a subscription transita para status=active (ou é inserida activa). Não trata cancelamentos — esses são geridos pelo webhook Stripe explicitamente.';

drop trigger if exists trg_subscription_active_sync on public.subscriptions;
create trigger trg_subscription_active_sync
  after insert or update of status, plan on public.subscriptions
  for each row execute function public.handle_subscription_active();


-- ============================================================================
-- FIM — 0006_billing_rpc.sql
-- ============================================================================


-- ============================================================================
-- ROLLBACK (referência — NÃO executar):
-- ----------------------------------------------------------------------------
-- drop trigger if exists trg_subscription_active_sync on subscriptions;
-- drop function if exists public.handle_subscription_active();
-- drop function if exists public.credits_for_plan(text);
-- drop function if exists public.add_credits(uuid, int, text, uuid, text, uuid);
-- alter table subscriptions drop column if exists cancel_at_period_end;
-- alter table subscriptions drop column if exists stripe_price_id;
-- ============================================================================
