-- ============================================================================
-- AngoConnect — Suite de testes para billing/credits (M2.2)
-- ----------------------------------------------------------------------------
-- Valida a RPC `public.add_credits` e a função `public.credits_for_plan`
-- introduzidas em `0006_billing_rpc.sql`.
--
-- Como correr:
--
--   A) Local (CLI Supabase):
--      $ supabase db reset
--      $ psql "$(supabase status -o env | grep DB_URL | cut -d= -f2-)" \
--             -f supabase/tests/billing_credits.sql
--
--   B) Supabase Studio:
--      Cola este ficheiro no SQL Editor e corre tudo de uma vez.
--      Lê os NOTICE no painel de resultados para ver pass/fail.
--
-- IMPORTANTE: este script ASSUME base de dados limpa. Corre o bloco de
-- CLEANUP no fim se precisares de reaplicar.
--
-- Estes testes correm como `service_role` (bypass RLS) porque a RPC
-- `add_credits` está restrita a esse role. Em produção, o cliente nunca
-- a chama directamente — é sempre invocada pelo backend autenticado.
-- ============================================================================


-- ============================================================================
-- SETUP — criar utilizador + workspace de teste
-- ============================================================================
-- Inserimos um auth.user; o trigger `on_auth_user_created` (definido em 0001)
-- cria automaticamente o profile. Depois criamos directamente o workspace
-- via INSERT (não via RPC) para controlar exactamente o `credits_remaining`
-- inicial.

set local role postgres;  -- bypass RLS para setup

insert into auth.users (
  id,
  email,
  encrypted_password,
  email_confirmed_at,
  created_at,
  updated_at,
  instance_id,
  aud,
  role
)
values (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'billing-test@test.ao',
  crypt('test123', gen_salt('bf')),
  now(), now(), now(),
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated'
)
on conflict (id) do nothing;

-- Workspace de teste com 100 créditos iniciais (valor escolhido para
-- testar tanto débitos válidos como overdrafts em poucos passos).
insert into public.workspaces (id, name, slug, owner_id, plan, credits_remaining)
values (
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'Billing Test Co',
  'billing-test-co',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'starter',
  100
)
on conflict (id) do nothing;

-- Garantir membership owner (a RPC normal trataria disto; aqui forçamos).
insert into public.workspace_members (workspace_id, user_id, role)
values (
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'owner'
)
on conflict (workspace_id, user_id) do nothing;


-- ============================================================================
-- TESTE 1 — add_credits com amount positivo
--   Cenário: webhook Stripe recarga 500 créditos (plan_renewal).
--   Esperado: balance_remaining sobe para 600 e há nova linha no log.
-- ============================================================================
do $$
declare
  v_returned_balance int;
  v_db_balance       int;
  v_log_count        int;
begin
  -- Snapshot pré-teste
  select credits_remaining into v_db_balance
    from public.workspaces
   where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  if v_db_balance <> 100 then
    raise warning 'TESTE 1 SKIP — saldo inicial era % (esperado 100)', v_db_balance;
    return;
  end if;

  -- Chamada à RPC
  v_returned_balance := public.add_credits(
    p_workspace_id => 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    p_amount       => 500,
    p_reason       => 'plan_renewal'
  );

  -- Verificação 1.1 — RPC devolve novo saldo
  if v_returned_balance <> 600 then
    raise warning 'TESTE 1a FALHOU — RPC devolveu % (esperado 600)', v_returned_balance;
    return;
  end if;

  -- Verificação 1.2 — saldo persistido em workspaces
  select credits_remaining into v_db_balance
    from public.workspaces
   where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  if v_db_balance <> 600 then
    raise warning 'TESTE 1b FALHOU — workspaces.credits_remaining = % (esperado 600)', v_db_balance;
    return;
  end if;

  -- Verificação 1.3 — log tem nova entrada (plan_renewal, +500, balance_after=600)
  select count(*) into v_log_count
    from public.credits_log
   where workspace_id  = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
     and reason        = 'plan_renewal'
     and amount        = 500
     and balance_after = 600;
  if v_log_count <> 1 then
    raise warning 'TESTE 1c FALHOU — credits_log tem % entradas matching (esperado 1)', v_log_count;
    return;
  end if;

  raise notice 'TESTE 1 OK — add_credits(+500, plan_renewal): saldo 100→600, log criado';
end $$;


-- ============================================================================
-- TESTE 2 — add_credits com débito > saldo (reason normal) → raises
--   Cenário: tentativa de débito de 1000 com saldo de 600.
--   Esperado: levanta SQLSTATE P0001 (`insufficient_credits`); saldo intacto.
-- ============================================================================
do $$
declare
  v_balance_before int;
  v_balance_after  int;
  v_caught_error   boolean := false;
  v_caught_state   text;
begin
  select credits_remaining into v_balance_before
    from public.workspaces
   where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  begin
    perform public.add_credits(
      p_workspace_id => 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      p_amount       => -1000,
      p_reason       => 'contact_export'
    );
  exception
    when raise_exception then
      v_caught_error := true;
      get stacked diagnostics v_caught_state = returned_sqlstate;
  end;

  if not v_caught_error then
    raise warning 'TESTE 2a FALHOU — débito > saldo não lançou excepção';
    return;
  end if;

  if v_caught_state <> 'P0001' then
    raise warning 'TESTE 2b FALHOU — SQLSTATE inesperado: % (esperado P0001)', v_caught_state;
    return;
  end if;

  -- Saldo tem de ficar igual (rollback da excepção)
  select credits_remaining into v_balance_after
    from public.workspaces
   where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  if v_balance_after <> v_balance_before then
    raise warning 'TESTE 2c FALHOU — saldo mudou de % para % apesar da excepção',
                  v_balance_before, v_balance_after;
    return;
  end if;

  raise notice 'TESTE 2 OK — débito > saldo com contact_export: P0001 raised, saldo intacto (=%)', v_balance_after;
end $$;


-- ============================================================================
-- TESTE 3 — add_credits com débito > saldo MAS reason='refund' → permite
--   Cenário: refund de 1000 com saldo de 600.
--   Esperado: RPC aceita; saldo cai para 0 (clamp); log regista amount=-1000.
--
-- Decisão documentada na migration: para preservar a constraint
-- `credits_log_balance_nonneg_check`, refund/manual_adjust clampam o saldo
-- em 0 em vez de o deixar ir negativo. A intenção do operador fica
-- preservada no `amount` do log.
-- ============================================================================
do $$
declare
  v_returned_balance int;
  v_db_balance       int;
  v_log_count        int;
begin
  v_returned_balance := public.add_credits(
    p_workspace_id => 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    p_amount       => -1000,
    p_reason       => 'refund'
  );

  -- Verificação 3.1 — RPC devolve 0 (clamp aplicado)
  if v_returned_balance <> 0 then
    raise warning 'TESTE 3a FALHOU — RPC devolveu % (esperado 0 após clamp)', v_returned_balance;
    return;
  end if;

  -- Verificação 3.2 — saldo persistido em workspaces = 0
  select credits_remaining into v_db_balance
    from public.workspaces
   where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  if v_db_balance <> 0 then
    raise warning 'TESTE 3b FALHOU — workspaces.credits_remaining = % (esperado 0)', v_db_balance;
    return;
  end if;

  -- Verificação 3.3 — log preserva o amount original (-1000) com balance_after=0
  select count(*) into v_log_count
    from public.credits_log
   where workspace_id  = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
     and reason        = 'refund'
     and amount        = -1000
     and balance_after = 0;
  if v_log_count <> 1 then
    raise warning 'TESTE 3c FALHOU — credits_log refund matching = % (esperado 1)', v_log_count;
    return;
  end if;

  raise notice 'TESTE 3 OK — refund de -1000 com saldo 600: clamp para 0, log preserva intenção';
end $$;


-- ============================================================================
-- TESTE 4 — credits_for_plan mapeia plans correctos
--   Esperado: starter=500, growth=2000, pro=999999, outro=0.
-- ============================================================================
do $$
declare
  v_starter int;
  v_growth  int;
  v_pro     int;
  v_unknown int;
begin
  v_starter := public.credits_for_plan('starter');
  v_growth  := public.credits_for_plan('growth');
  v_pro     := public.credits_for_plan('pro');
  v_unknown := public.credits_for_plan('enterprise_dream');

  if v_starter <> 500 then
    raise warning 'TESTE 4a FALHOU — starter = % (esperado 500)', v_starter;
    return;
  end if;
  if v_growth <> 2000 then
    raise warning 'TESTE 4b FALHOU — growth = % (esperado 2000)', v_growth;
    return;
  end if;
  if v_pro <> 999999 then
    raise warning 'TESTE 4c FALHOU — pro = % (esperado 999999)', v_pro;
    return;
  end if;
  if v_unknown <> 0 then
    raise warning 'TESTE 4d FALHOU — plan desconhecido = % (esperado 0)', v_unknown;
    return;
  end if;

  raise notice 'TESTE 4 OK — credits_for_plan: starter=500, growth=2000, pro=999999, outro=0';
end $$;


-- ============================================================================
-- CLEANUP (opcional — descomenta para reaplicar)
-- ----------------------------------------------------------------------------
-- delete from public.credits_log
--  where workspace_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
-- delete from public.workspace_members
--  where workspace_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
-- delete from public.workspaces
--  where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
-- delete from auth.users
--  where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
-- ============================================================================

reset role;
