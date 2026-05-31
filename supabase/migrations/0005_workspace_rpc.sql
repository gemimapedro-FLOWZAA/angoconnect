-- ============================================================================
-- AngoConnect — Migration 0005 — RPC atómica de criação de workspace + owner
-- ----------------------------------------------------------------------------
-- Cria a função `public.create_workspace_with_owner(p_name, p_slug)` que faz
-- numa única transacção:
--   1. Valida que existe um utilizador autenticado (auth.uid() IS NOT NULL).
--   2. Valida o input (`p_name` não vazio, `p_slug` em formato kebab-case).
--   3. INSERT em `public.workspaces` (owner_id = auth.uid(), plano 'starter',
--      50 créditos de bónus de signup).
--   4. INSERT em `public.workspace_members` (role = 'owner') para o user.
--   5. INSERT em `public.credits_log` (signup_bonus, +50, balance_after = 50).
--   6. Devolve a row do workspace criado.
--
-- DECISÃO (sem consulta): Bónus de signup = 50 créditos. Justificação:
--   * Plano starter pago tem 500 créditos/mês. 50 = 10% — o suficiente para
--     o user testar o produto (export ~50 contactos) sem queimar a quota mensal.
--   * Lado da auditoria fica limpo: cada workspace nasce com uma entrada em
--     credits_log que justifica o `credits_remaining` inicial.
--
-- DECISÃO (sem consulta): Slug regex = `^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])?$`.
--   * Lowercase alfanumérico, hífens internos permitidos, sem traço inicial/final.
--   * Tamanho 3–40 caracteres. Compatível com sub-domínios futuros.
--
-- SEGURANÇA:
--   * `security definer` para que a função possa inserir em workspaces e
--     workspace_members na mesma transacção independentemente das RLS
--     (a RLS de INSERT em workspaces exige owner_id = auth.uid() o que está
--     OK aqui, mas evitamos riscos de race em policies por mudar).
--   * `search_path` fixo em `public, pg_temp` para mitigar function hijacking.
--   * `auth.uid()` é a única barreira: se for NULL, a função rejeita.
--   * EXECUTE revogado do `public`, concedido apenas a `authenticated`.
--
-- Idempotência: `create or replace function` permite reaplicar a migration.
-- ============================================================================


-- ============================================================================
-- 1) FUNÇÃO RPC — create_workspace_with_owner
-- ============================================================================
create or replace function public.create_workspace_with_owner(
  p_name text,
  p_slug text
)
returns table (
  id                uuid,
  name              text,
  slug              text,
  plan              text,
  credits_remaining int,
  created_at        timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id      uuid;
  v_workspace_id uuid;
begin
  -- ------------------------------------------------------------------
  -- 1) Validação: a chamada tem de ser feita por um user autenticado.
  -- ------------------------------------------------------------------
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  -- ------------------------------------------------------------------
  -- 2) Validação de inputs.
  --    * Nome: obrigatório, não vazio (trim).
  --    * Slug: kebab-case, 3–40 chars, sem traço inicial/final.
  -- ------------------------------------------------------------------
  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'name_required' using errcode = '22023';
  end if;

  if p_slug is null
     or not (p_slug ~ '^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])?$')
  then
    raise exception 'slug_invalid' using errcode = '22023';
  end if;

  -- ------------------------------------------------------------------
  -- 3) INSERT do workspace.
  --    owner_id := auth.uid()   (single source of truth de quem é dono)
  --    plan     := 'starter'    (default plan para todos os novos signups)
  --    credits  := 50           (bónus de signup — ver decisões no topo)
  --
  --    Se o slug já existir, a constraint `workspaces_slug_unique` lança
  --    SQLSTATE 23505 que o cliente pode mapear para "slug_taken".
  -- ------------------------------------------------------------------
  insert into public.workspaces (name, slug, owner_id, plan, credits_remaining)
  values (trim(p_name), p_slug, v_user_id, 'starter', 50)
  returning workspaces.id into v_workspace_id;

  -- ------------------------------------------------------------------
  -- 4) INSERT do owner em workspace_members.
  --    Garante atomicidade: nunca fica um workspace órfão sem membros.
  -- ------------------------------------------------------------------
  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_workspace_id, v_user_id, 'owner');

  -- ------------------------------------------------------------------
  -- 5) Log da atribuição de créditos de signup no ledger imutável.
  --    Mantém credits_log consistente com workspaces.credits_remaining.
  -- ------------------------------------------------------------------
  insert into public.credits_log (
    workspace_id,
    amount,
    reason,
    balance_after,
    performed_by
  )
  values (
    v_workspace_id,
    50,
    'signup_bonus',
    50,
    v_user_id
  );

  -- ------------------------------------------------------------------
  -- 6) Devolve a row criada (forma canónica do recurso).
  -- ------------------------------------------------------------------
  return query
    select w.id, w.name, w.slug, w.plan, w.credits_remaining, w.created_at
      from public.workspaces w
     where w.id = v_workspace_id;
end;
$$;

comment on function public.create_workspace_with_owner(text, text) is
  'RPC atómica para criação de workspace: insere em workspaces + workspace_members (role=owner) + credits_log (signup_bonus=50) na mesma transacção. SECURITY DEFINER com search_path fixo; auth.uid() é a barreira de autorização. Executável apenas por authenticated.';


-- ============================================================================
-- 2) PERMISSÕES — revogar do public, conceder apenas a authenticated
-- ============================================================================
revoke all on function public.create_workspace_with_owner(text, text) from public;
grant execute on function public.create_workspace_with_owner(text, text) to authenticated;


-- ============================================================================
-- FIM — 0005_workspace_rpc.sql
-- ============================================================================


-- ============================================================================
-- ROLLBACK (referência — NÃO executar):
--   drop function if exists public.create_workspace_with_owner(text, text);
-- ============================================================================
