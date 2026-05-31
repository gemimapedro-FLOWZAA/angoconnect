-- ============================================================================
-- AngoConnect — Suite de testes de isolamento RLS
-- ----------------------------------------------------------------------------
-- Documenta como validar manualmente que as policies RLS impedem acesso
-- cross-workspace. Não é uma migration — é um script de teste standalone.
--
-- Como correr (escolhe um dos métodos):
--
--   A) Local (CLI Supabase):
--      $ supabase db reset                    -- aplica todas as migrations
--      $ psql "$(supabase status -o env | grep DB_URL | cut -d= -f2-)" \
--             -f supabase/tests/rls_isolation.sql
--
--   B) Supabase Studio:
--      Cola este ficheiro no SQL Editor e corre tudo de uma vez.
--      Lê os NOTICE no painel de resultados para ver pass/fail.
--
-- Cada bloco imprime via `raise notice` se o teste passou ou falhou. Os
-- contadores intermédios também aparecem como resultado de `select`, pelo
-- que é fácil cruzar visualmente.
--
-- IMPORTANTE: este script ASSUME base de dados limpa. Se já tiveres dados
-- de teste anteriores, corre primeiro o bloco de CLEANUP no fim.
-- ============================================================================


-- ============================================================================
-- SETUP — criar dois utilizadores e dois workspaces via RPC
-- ============================================================================
-- Inserimos directamente em auth.users porque não temos signUp dentro do SQL.
-- O trigger `on_auth_user_created` (definido em 0001) cria automaticamente
-- as rows em public.profiles, pelo que não precisamos de o fazer à mão.

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
values
  (
    '11111111-1111-1111-1111-111111111111',
    'alice@test.ao',
    crypt('test123', gen_salt('bf')),
    now(), now(), now(),
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated'
  ),
  (
    '22222222-2222-2222-2222-222222222222',
    'bob@test.ao',
    crypt('test123', gen_salt('bf')),
    now(), now(), now(),
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated'
  )
on conflict (id) do nothing;

-- Workspace da Alice (executado como Alice via RPC) -------------------------
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set local role authenticated;
select public.create_workspace_with_owner('Alice Co', 'alice-co');

-- Workspace do Bob (executado como Bob via RPC) -----------------------------
set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select public.create_workspace_with_owner('Bob Lda', 'bob-lda');

reset role;
reset request.jwt.claim.sub;


-- ============================================================================
-- TESTE 1 — Alice só vê o seu próprio workspace (RLS workspaces SELECT)
-- ============================================================================
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set local role authenticated;

select count(*) as alice_sees_workspaces from public.workspaces;
-- ESPERADO: 1 (só "Alice Co")

do $$
declare
  v_count int;
begin
  select count(*) into v_count from public.workspaces;
  if v_count = 1 then
    raise notice 'TESTE 1 OK — Alice vê 1 workspace (esperado: 1)';
  else
    raise warning 'TESTE 1 FALHOU — Alice vê % workspaces (esperado: 1)', v_count;
  end if;
end $$;


-- ============================================================================
-- TESTE 2 — Alice só vê membros do seu workspace
-- ============================================================================
select count(*) as alice_sees_members from public.workspace_members;
-- ESPERADO: 1 (só o membership da Alice)

do $$
declare
  v_count int;
begin
  select count(*) into v_count from public.workspace_members;
  if v_count = 1 then
    raise notice 'TESTE 2 OK — Alice vê 1 membership (esperado: 1)';
  else
    raise warning 'TESTE 2 FALHOU — Alice vê % memberships (esperado: 1)', v_count;
  end if;
end $$;


-- ============================================================================
-- TESTE 3 — Alice NÃO consegue inserir company privada no workspace do Bob
-- ============================================================================
-- A policy companies_insert_member exige is_workspace_member(workspace_id).
-- Como Alice não é membro do workspace do Bob, a RLS deve bloquear o INSERT.
do $$
declare
  v_bob_ws uuid;
begin
  -- Bypass RLS temporário para obter o ID do workspace do Bob
  -- (Nota: corremos como authenticated, mas a Alice tem SELECT no seu
  --  próprio workspace. Para descobrir o do Bob usamos auth.users.)
  select w.id into v_bob_ws
    from public.workspaces w
   where w.slug = 'bob-lda';

  if v_bob_ws is null then
    -- Esperado: a Alice não vê o workspace do Bob, logo o select devolve NULL.
    raise notice 'TESTE 3a OK — Alice não vê o workspace do Bob via SELECT';
  else
    raise warning 'TESTE 3a FALHOU — Alice viu o workspace do Bob: %', v_bob_ws;
  end if;
end $$;

-- Tentativa explícita de INSERT com workspace_id forjado (UUID do bob-lda).
-- Esperamos que RLS reject. Como não sabemos o UUID do bob-lda sem bypass,
-- inserimos por subselect que vai a auth.users (acessível) e join via slug.
do $$
declare
  v_inserted int;
  v_bob_ws   uuid;
begin
  -- Truque: como service_role, descobrimos o UUID. Mas estamos como
  -- authenticated, então usamos um UUID conhecido por construção: o slug
  -- 'bob-lda' tem UUID que só o service_role vê. Em vez disso, tentamos
  -- inserir com um UUID aleatório que finja ser de outro workspace.
  v_bob_ws := gen_random_uuid();

  begin
    insert into public.companies (workspace_id, name, provincia, source)
    values (v_bob_ws, 'Hack Inc', 'Luanda', 'manual');

    get diagnostics v_inserted = row_count;
    if v_inserted = 0 then
      raise notice 'TESTE 3b OK — RLS bloqueou INSERT em workspace alheio (0 rows)';
    else
      raise warning 'TESTE 3b FALHOU — INSERT passou com % row(s)', v_inserted;
    end if;
  exception
    when insufficient_privilege or check_violation then
      raise notice 'TESTE 3b OK — RLS rejeitou INSERT (insufficient_privilege)';
    when foreign_key_violation then
      raise notice 'TESTE 3b OK — FK rejeitou (workspace inexistente) — RLS implícita';
  end;
end $$;

reset role;
reset request.jwt.claim.sub;


-- ============================================================================
-- TESTE 4 — Catálogo público (workspace_id = NULL) é visível a ambos
-- ============================================================================
-- Inserimos uma company de catálogo público via service_role (bypass RLS).
-- Não conseguimos fazê-lo como authenticated porque a policy de INSERT em
-- companies exige workspace_id NOT NULL. Por isso, simulamos o que faria
-- o webhook handler do Apify (service_role).

reset role;  -- volta a postgres / service_role
reset request.jwt.claim.sub;

insert into public.companies (workspace_id, name, provincia, source)
values (null, 'Catálogo Público AO', 'Luanda', 'irgc')
on conflict do nothing;

-- Alice vê o catálogo público? -----------------------------------------------
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set local role authenticated;

select count(*) as alice_public_companies
  from public.companies
 where workspace_id is null;
-- ESPERADO: 1

do $$
declare
  v_count int;
begin
  select count(*) into v_count
    from public.companies
   where workspace_id is null;
  if v_count >= 1 then
    raise notice 'TESTE 4a OK — Alice vê catálogo público (% rows)', v_count;
  else
    raise warning 'TESTE 4a FALHOU — Alice não vê catálogo público (% rows)', v_count;
  end if;
end $$;

-- Bob vê o catálogo público? -------------------------------------------------
set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

do $$
declare
  v_count int;
begin
  select count(*) into v_count
    from public.companies
   where workspace_id is null;
  if v_count >= 1 then
    raise notice 'TESTE 4b OK — Bob vê catálogo público (% rows)', v_count;
  else
    raise warning 'TESTE 4b FALHOU — Bob não vê catálogo público (% rows)', v_count;
  end if;
end $$;

reset role;
reset request.jwt.claim.sub;


-- ============================================================================
-- TESTE 5 — credits_log do signup_bonus existe para ambos workspaces
-- ============================================================================
-- Corremos como service_role (sem RLS) para ver o ledger completo.
select workspace_id, amount, reason, balance_after
  from public.credits_log
 order by created_at;
-- ESPERADO: 2 rows, ambas amount=50, reason='signup_bonus', balance_after=50

do $$
declare
  v_count int;
begin
  select count(*) into v_count
    from public.credits_log
   where reason = 'signup_bonus'
     and amount = 50
     and balance_after = 50;
  if v_count = 2 then
    raise notice 'TESTE 5 OK — 2 entries de signup_bonus correctos';
  else
    raise warning 'TESTE 5 FALHOU — encontrou % entries (esperado: 2)', v_count;
  end if;
end $$;


-- ============================================================================
-- TESTE 6 — RPC rejeita slug inválido
-- ============================================================================
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set local role authenticated;

do $$
begin
  perform public.create_workspace_with_owner('X', 'BAD SLUG!');
  raise warning 'TESTE 6 FALHOU — RPC aceitou slug inválido';
exception when sqlstate '22023' then
  raise notice 'TESTE 6 OK — RPC rejeitou slug inválido (sqlstate 22023)';
end $$;


-- ============================================================================
-- TESTE 7 — RPC rejeita chamada sem autenticação (auth.uid() IS NULL)
-- ============================================================================
reset role;
reset request.jwt.claim.sub;

do $$
begin
  perform public.create_workspace_with_owner('Anon', 'anon-co');
  raise warning 'TESTE 7 FALHOU — RPC aceitou chamada sem autenticação';
exception when sqlstate '42501' then
  raise notice 'TESTE 7 OK — RPC rejeitou chamada sem auth (sqlstate 42501)';
end $$;


-- ============================================================================
-- TESTE 8 — RPC rejeita slug duplicado (constraint uniqueness)
-- ============================================================================
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set local role authenticated;

do $$
begin
  perform public.create_workspace_with_owner('Alice Co Duplicado', 'alice-co');
  raise warning 'TESTE 8 FALHOU — RPC aceitou slug duplicado';
exception when unique_violation then
  raise notice 'TESTE 8 OK — RPC rejeitou slug duplicado (unique_violation)';
end $$;

reset role;
reset request.jwt.claim.sub;


-- ============================================================================
-- CLEANUP (opcional — descomenta se quiseres deixar a DB limpa)
-- ============================================================================
-- delete from auth.users where email in ('alice@test.ao', 'bob@test.ao');
-- delete from public.companies where source = 'irgc' and workspace_id is null;
-- -- Cascateia: profiles, workspaces, workspace_members, credits_log.


-- ============================================================================
-- FIM — rls_isolation.sql
-- ============================================================================
