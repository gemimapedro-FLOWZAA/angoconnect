import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Cliente admin do Supabase exclusivo para os testes E2E.
 *
 * IMPORTANTE: usa `SUPABASE_SERVICE_ROLE_KEY` — só pode ser invocado a partir
 * dos ficheiros em `e2e/`, nunca do código da app. Os E2E correm contra uma
 * instância **local** do Supabase (`supabase start`), nunca produção.
 *
 * Lemos das vars `E2E_SUPABASE_URL` / `E2E_SUPABASE_SERVICE_KEY` em vez das
 * defaults `NEXT_PUBLIC_*` para tornar explícito que isto é setup de testes.
 */
function getServiceClient(): SupabaseClient {
  const url = process.env.E2E_SUPABASE_URL;
  const key = process.env.E2E_SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error(
      'E2E_SUPABASE_URL e E2E_SUPABASE_SERVICE_KEY são obrigatórias. ' +
        'Inicia o Supabase local (`supabase start`) e exporta as keys. ' +
        'Ver e2e/README.md.'
    );
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface TestUser {
  userId: string;
  email: string;
  password: string;
}

export interface TestWorkspace {
  workspaceId: string;
  name: string;
  slug: string;
  ownerId: string;
}

/**
 * Cria um utilizador confirmado no Supabase via admin API. Devolve credenciais
 * que podem ser usadas na UI de login.
 */
export async function createTestUser(opts?: {
  email?: string;
  password?: string;
}): Promise<TestUser> {
  const supabase = getServiceClient();
  const email = opts?.email ?? `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = opts?.password ?? 'TestPass123!@#';

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (error || !data.user) {
    throw new Error(`createTestUser failed: ${error?.message ?? 'no user returned'}`);
  }

  return { userId: data.user.id, email, password };
}

/**
 * Cria um workspace + ownership via RPC (mesma função que o onboarding usa).
 * Permite saltar a UI de onboarding em testes que se focam noutros fluxos.
 */
export async function createTestWorkspace(opts: {
  ownerId: string;
  name?: string;
  slug?: string;
  credits?: number;
}): Promise<TestWorkspace> {
  const supabase = getServiceClient();
  const name = opts.name ?? `E2E Workspace ${Date.now()}`;
  const slug = opts.slug ?? `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  // Usa a RPC oficial criada em M2.1 (mesma que o /api/workspaces invoca).
  const { data, error } = await supabase.rpc('create_workspace_with_owner', {
    p_user_id: opts.ownerId,
    p_name: name,
    p_slug: slug,
  });

  if (error) {
    throw new Error(`createTestWorkspace failed: ${error.message}`);
  }

  const workspaceId = typeof data === 'string' ? data : (data?.workspace_id ?? null);
  if (!workspaceId) {
    throw new Error('createTestWorkspace: RPC did not return workspace_id');
  }

  if (typeof opts.credits === 'number') {
    await supabase
      .from('workspaces')
      .update({ credits_remaining: opts.credits })
      .eq('id', workspaceId);
  }

  return { workspaceId, name, slug, ownerId: opts.ownerId };
}

/**
 * Limpa um utilizador e tudo o que está associado a ele (workspaces caem por
 * cascata desde que as FK estejam ON DELETE CASCADE).
 */
export async function deleteTestUser(userId: string): Promise<void> {
  const supabase = getServiceClient();
  await supabase.auth.admin.deleteUser(userId).catch(() => {
    // Silencioso — limpeza best-effort em afterEach.
  });
}

/**
 * Insere uma company + contact no workspace para os testes que precisam de
 * dados pré-existentes (search results, reveal contact, etc.).
 */
export async function seedCompanyWithContact(opts: {
  workspaceId: string;
  companyName?: string;
  sector?: string;
  provincia?: string;
  contactEmail?: string;
}): Promise<{ companyId: string; contactId: string }> {
  const supabase = getServiceClient();

  const companyName = opts.companyName ?? `E2E Co ${Date.now()}`;
  const { data: company, error: companyErr } = await supabase
    .from('companies')
    .insert({
      workspace_id: opts.workspaceId,
      name: companyName,
      sector: opts.sector ?? 'banking',
      provincia: opts.provincia ?? 'Luanda',
      source: 'manual',
    })
    .select('id')
    .single();

  if (companyErr || !company) {
    throw new Error(`seedCompany failed: ${companyErr?.message}`);
  }

  const { data: contact, error: contactErr } = await supabase
    .from('contacts')
    .insert({
      company_id: company.id,
      name: 'Director Teste',
      title: 'Director Comercial',
      email: opts.contactEmail ?? `director-${Date.now()}@example.test`,
      phone: '+244923000000',
      confidence_score: 0.85,
    })
    .select('id')
    .single();

  if (contactErr || !contact) {
    throw new Error(`seedContact failed: ${contactErr?.message}`);
  }

  return { companyId: company.id, contactId: contact.id };
}

/**
 * Cria uma sequência em draft para o workspace — para testes que arrancam no
 * builder (`/outreach/:id/edit`).
 */
export async function seedDraftSequence(opts: {
  workspaceId: string;
  name?: string;
}): Promise<{ sequenceId: string }> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('sequences')
    .insert({
      workspace_id: opts.workspaceId,
      name: opts.name ?? `E2E Sequence ${Date.now()}`,
      status: 'draft',
      steps: [
        { day_offset: 0, channel: 'email', subject: 'Olá {{first_name}}', body: 'Mensagem inicial.' },
        { day_offset: 3, channel: 'email', subject: 'Follow-up', body: 'Segunda mensagem.' },
      ],
    })
    .select('id')
    .single();

  if (error || !data) {
    throw new Error(`seedDraftSequence failed: ${error?.message}`);
  }
  return { sequenceId: data.id };
}

/**
 * Cria deal stages padrão do workspace (caso o seed não tenha corrido) e
 * popula 3 deals (1 por stage) para o teste do Kanban.
 */
export async function seedKanbanScenario(opts: {
  workspaceId: string;
  ownerId: string;
}): Promise<{
  stageIds: { novo: string; contactado: string; qualificado: string };
  dealIds: string[];
}> {
  const supabase = getServiceClient();

  // 1. Buscar stages (seeds correm via migration 0010).
  const { data: stages, error: stagesErr } = await supabase
    .from('deal_stages')
    .select('id, name, position')
    .or(`workspace_id.eq.${opts.workspaceId},workspace_id.is.null`)
    .order('position', { ascending: true });

  if (stagesErr || !stages || stages.length === 0) {
    throw new Error(`seedKanbanScenario: no stages found — ${stagesErr?.message}`);
  }

  const find = (name: string) => stages.find((s) => s.name === name)?.id;
  const novo = find('Novo');
  const contactado = find('Contactado');
  const qualificado = find('Qualificado');

  if (!novo || !contactado || !qualificado) {
    throw new Error('seedKanbanScenario: stages Novo/Contactado/Qualificado em falta');
  }

  // 2. Criar 3 companies + contacts + deals (1 por stage).
  const dealIds: string[] = [];
  for (const stageId of [novo, contactado, qualificado]) {
    const { companyId, contactId } = await seedCompanyWithContact({
      workspaceId: opts.workspaceId,
      companyName: `E2E Kanban Co ${stageId.slice(0, 6)}`,
    });

    const { data: deal, error: dealErr } = await supabase
      .from('deals')
      .insert({
        workspace_id: opts.workspaceId,
        contact_id: contactId,
        company_id: companyId,
        stage_id: stageId,
        owner_id: opts.ownerId,
        value_akz: 1_000_000,
        status: 'open',
      })
      .select('id')
      .single();

    if (dealErr || !deal) {
      throw new Error(`seedKanban deal insert failed: ${dealErr?.message}`);
    }
    dealIds.push(deal.id);
  }

  return { stageIds: { novo, contactado, qualificado }, dealIds };
}
