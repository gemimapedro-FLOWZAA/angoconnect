/**
 * AngoConnect — Helpers de queries de companies/contacts (M3.1)
 * ===========================================================================
 * Funções partilhadas entre vários endpoints de Search & Discovery.
 * Nada de side-effects fora do Supabase — toda a auth/membership é
 * responsabilidade do caller (mantém estas funções testáveis).
 */

import { createClient as createServerSupabaseClient } from '@/lib/supabase/server';

// `@supabase/ssr` devolve um cliente com mais genéricos (schema name + tipos
// inferidos) do que `SupabaseClient<Database>` de `@supabase/supabase-js`.
// Derivamos o tipo directamente da factory para evitar mismatch.
export type ServerClient = ReturnType<typeof createServerSupabaseClient>;

// ---------------------------------------------------------------------------
// Membership check (defesa em profundidade — RLS já valida em todas as
// queries, mas queremos um 403 distinto de RLS-empty-result no API).
// ---------------------------------------------------------------------------

export async function assertWorkspaceMembership(
  supabase: ServerClient,
  workspaceId: string,
  userId: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle()
    .overrideTypes<{ workspace_id: string } | null, { merge: false }>();

  if (error) {
    console.error('[companies/queries] membership check falhou', error);
    return false;
  }
  return data !== null;
}

// ---------------------------------------------------------------------------
// Verifica que uma company é visível ao workspace (catálogo público OU
// privada do workspace). Devolve o `workspace_id` actual da company, ou
// null se não existe / não visível.
// ---------------------------------------------------------------------------

export async function getVisibleCompany(
  supabase: ServerClient,
  companyId: string,
  workspaceId: string
): Promise<
  | { id: string; workspace_id: string | null; is_in_catalog: boolean }
  | null
> {
  const { data, error } = await supabase
    .from('companies')
    .select('id, workspace_id')
    .eq('id', companyId)
    .maybeSingle()
    .overrideTypes<
      { id: string; workspace_id: string | null } | null,
      { merge: false }
    >();

  if (error) {
    console.error('[companies/queries] getVisibleCompany falhou', error);
    return null;
  }
  if (!data) return null;

  const isPublic = data.workspace_id === null;
  const isOwned = data.workspace_id === workspaceId;
  if (!isPublic && !isOwned) return null;

  return {
    id: data.id,
    workspace_id: data.workspace_id,
    is_in_catalog: isPublic,
  };
}

// ---------------------------------------------------------------------------
// Lista os contact_ids já revelados pelo workspace para um subset de
// contact_ids candidatos. Útil para decidir mascarar em batch.
// ---------------------------------------------------------------------------

export async function getRevealedContactIds(
  supabase: ServerClient,
  workspaceId: string,
  contactIds: string[]
): Promise<Set<string>> {
  if (contactIds.length === 0) return new Set<string>();

  const { data, error } = await supabase
    .from('revealed_contacts')
    .select('contact_id')
    .eq('workspace_id', workspaceId)
    .in('contact_id', contactIds)
    .overrideTypes<Array<{ contact_id: string }>, { merge: false }>();

  if (error) {
    console.error('[companies/queries] getRevealedContactIds falhou', error);
    return new Set<string>();
  }
  return new Set((data ?? []).map((r) => r.contact_id));
}
