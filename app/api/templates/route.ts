/**
 * AngoConnect — GET + POST /api/templates
 * ===========================================================================
 * Endpoints para gerir templates de email do Outreach Builder (M3.2).
 *
 * GET /api/templates
 *   Lista templates visíveis ao workspace (system + privados).
 *   Query params:
 *     workspaceId    uuid     (required)
 *     category       enum     (optional) intro | follow_up | break_up | check_in | custom
 *     includeSystem  boolean  (default true)
 *     language       enum     (optional) pt-PT | pt-AO | en
 *   Resposta: { data: Template[], error: null, meta: { totalSystem, totalPrivate } }
 *
 * POST /api/templates
 *   Cria um template privado do workspace (is_system=false). `variables` é
 *   populado automaticamente pelo trigger SQL (migration 0009).
 *
 * Erros:
 *   UNAUTHENTICATED       401
 *   INVALID_QUERY/BODY    400
 *   INVALID_JSON          400
 *   NOT_WORKSPACE_MEMBER  403
 *   DB_QUERY_FAILED       500
 *   DB_INSERT_FAILED      500
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiError, apiOk } from '@/lib/api-response';
import { createClient } from '@/lib/supabase/server';
import type {
  EmailTemplateCategory,
  EmailTemplateLanguage,
  Json,
} from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Shape canónico devolvido pelos endpoints (partilhado também pelo [id])
// ---------------------------------------------------------------------------

// Shapes + schemas vivem em lib/templates/schemas.ts (route.ts não pode
// exportar não-handlers)
import {
  type EmailTemplateRow,
  TEMPLATE_SELECT,
  templateCategorySchema,
  templateLanguageSchema,
} from '@/lib/templates/schemas';

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

const listTemplatesSchema = z.object({
  workspaceId: z.string().uuid({ message: 'workspaceId tem de ser UUID' }),
  category: templateCategorySchema.optional(),
  includeSystem: z
    .union([z.boolean(), z.string()])
    .transform((v) => {
      if (typeof v === 'boolean') return v;
      // 'false' / '0' → false; tudo o resto → true (default true)
      return !(v === 'false' || v === '0');
    })
    .default(true),
  language: templateLanguageSchema.optional(),
});

export async function GET(request: NextRequest) {
  // 1) Auth
  const supabase = createClient();
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    return apiError('Não autenticado', 401, 'UNAUTHENTICATED');
  }

  // 2) Query Zod
  const { searchParams } = new URL(request.url);
  const parsed = listTemplatesSchema.safeParse({
    workspaceId: searchParams.get('workspaceId') ?? undefined,
    category: searchParams.get('category') ?? undefined,
    includeSystem: searchParams.get('includeSystem') ?? undefined,
    language: searchParams.get('language') ?? undefined,
  });
  if (!parsed.success) {
    return apiError('Query inválida', 400, 'INVALID_QUERY', {
      issues: parsed.error.issues,
    });
  }
  const { workspaceId, category, includeSystem, language } = parsed.data;

  // 3) Membership (defesa em profundidade; RLS já isola)
  const { data: member, error: memberErr } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('workspace_id', workspaceId)
    .eq('user_id', user.id)
    .maybeSingle()
    .overrideTypes<{ workspace_id: string } | null, { merge: false }>();

  if (memberErr) {
    console.error('[templates] erro a verificar workspace_members', memberErr);
    return apiError(
      'Falha a verificar permissões do workspace',
      500,
      'WORKSPACE_CHECK_FAILED'
    );
  }
  if (!member) {
    return apiError(
      'Não é membro deste workspace',
      403,
      'NOT_WORKSPACE_MEMBER'
    );
  }

  // 4) Query
  // - includeSystem=true  → workspace_id IS NULL OR workspace_id = :ws
  // - includeSystem=false → workspace_id = :ws
  // (RLS confirma que apenas membros vêem privados; system é universal.)
  let query = supabase
    .from('email_templates')
    .select(TEMPLATE_SELECT)
    .order('is_system', { ascending: false }) // system primeiro
    .order('category', { ascending: true })
    .order('created_at', { ascending: false });

  if (includeSystem) {
    query = query.or(`workspace_id.is.null,workspace_id.eq.${workspaceId}`);
  } else {
    query = query.eq('workspace_id', workspaceId);
  }

  if (category) query = query.eq('category', category);
  if (language) query = query.eq('language', language);

  const { data, error } = await query.overrideTypes<
    EmailTemplateRow[],
    { merge: false }
  >();

  if (error) {
    console.error('[templates] list falhou', error);
    return apiError('Falha a listar templates', 500, 'DB_QUERY_FAILED', {
      dbError: error.message,
    });
  }

  const rows: EmailTemplateRow[] = data ?? [];
  let totalSystem = 0;
  let totalPrivate = 0;
  for (const row of rows) {
    if (row.is_system) totalSystem += 1;
    else totalPrivate += 1;
  }

  return apiOk(rows, { totalSystem, totalPrivate });
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

const createTemplateSchema = z.object({
  workspaceId: z.string().uuid({ message: 'workspaceId tem de ser UUID' }),
  name: z.string().trim().min(2).max(80),
  category: templateCategorySchema,
  subject: z.string().trim().min(1).max(300),
  body: z.string().min(10).max(10_000),
  language: templateLanguageSchema,
});

type CreateTemplateBody = z.infer<typeof createTemplateSchema>;

export async function POST(request: NextRequest) {
  // 1) Auth
  const supabase = createClient();
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    return apiError('Não autenticado', 401, 'UNAUTHENTICATED');
  }

  // 2) Body Zod
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return apiError('Body não é JSON válido', 400, 'INVALID_JSON');
  }

  const parsed = createTemplateSchema.safeParse(rawBody);
  if (!parsed.success) {
    return apiError('Body inválido — ver issues', 400, 'INVALID_BODY', {
      issues: parsed.error.issues,
    });
  }
  const body: CreateTemplateBody = parsed.data;

  // 3) Workspace membership
  const { data: member, error: memberErr } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('workspace_id', body.workspaceId)
    .eq('user_id', user.id)
    .maybeSingle()
    .overrideTypes<{ workspace_id: string } | null, { merge: false }>();

  if (memberErr) {
    console.error('[templates] erro a verificar workspace_members', memberErr);
    return apiError(
      'Falha a verificar permissões do workspace',
      500,
      'WORKSPACE_CHECK_FAILED'
    );
  }
  if (!member) {
    return apiError(
      'Não é membro deste workspace',
      403,
      'NOT_WORKSPACE_MEMBER'
    );
  }

  // 4) INSERT (RLS valida via policy email_templates_insert; trigger SQL
  // popula `variables` a partir de subject+body)
  const { data: row, error: insertErr } = await supabase
    .from('email_templates')
    .insert({
      workspace_id: body.workspaceId,
      name: body.name,
      category: body.category,
      subject: body.subject,
      body: body.body,
      language: body.language,
      is_system: false,
      created_by: user.id,
    } as never)
    .select(TEMPLATE_SELECT)
    .single()
    .overrideTypes<EmailTemplateRow | null, { merge: false }>();

  if (insertErr || !row) {
    console.error('[templates] insert falhou', insertErr);
    return apiError('Falha a criar template', 500, 'DB_INSERT_FAILED', {
      dbError: insertErr?.message,
    });
  }

  return apiOk(row);
}
