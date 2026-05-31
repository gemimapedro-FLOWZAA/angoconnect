/**
 * AngoConnect — /api/whatsapp/templates (M3.4)
 * ===========================================================================
 * GET  — lista templates do workspace (com filtro opcional ?status=)
 * POST — cria draft local via RPC `upsert_whatsapp_template`. Status fica em
 *        'local_draft' até o user submeter para aprovação Meta.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiError, apiOk } from '@/lib/api-response';
import { createClient } from '@/lib/supabase/server';
import type { Json } from '@/lib/supabase/types';

const listSchema = z.object({
  workspaceId: z.string().uuid(),
  status: z
    .enum(['local_draft', 'submitted', 'approved', 'rejected', 'paused', 'disabled'])
    .optional(),
});

const upsertSchema = z.object({
  workspaceId: z.string().uuid(),
  meta_template_name: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9_]+$/i, 'Apenas letras, dígitos e underscore'),
  language: z.enum(['pt_PT', 'pt_AO', 'pt_BR', 'en_US']),
  category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']),
  body: z.string().min(1).max(1024),
  header_format: z
    .enum(['NONE', 'TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT'])
    .default('NONE'),
  header_text: z.string().max(60).optional(),
  footer: z.string().max(60).optional(),
  buttons: z.array(z.unknown()).default([]),
});

interface TemplateRow {
  id: string;
  workspace_id: string;
  meta_template_name: string;
  meta_template_id: string | null;
  language: string;
  category: string;
  header_format: string;
  header_text: string | null;
  body: string;
  body_example: Json;
  footer: string | null;
  buttons: Json;
  status: string;
  rejection_reason: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function ensureMember(supabase: ReturnType<typeof createClient>, workspaceId: string, userId: string) {
  const { data } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle()
    .overrideTypes<{ workspace_id: string } | null, { merge: false }>();
  return data !== null;
}

export async function GET(request: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) return apiError('Não autenticado', 401, 'UNAUTHENTICATED');

  const { searchParams } = new URL(request.url);
  const parsed = listSchema.safeParse({
    workspaceId: searchParams.get('workspaceId') ?? undefined,
    status: searchParams.get('status') ?? undefined,
  });
  if (!parsed.success) {
    return apiError('Query inválida', 400, 'INVALID_QUERY', {
      issues: parsed.error.issues,
    });
  }
  const { workspaceId, status } = parsed.data;

  if (!(await ensureMember(supabase, workspaceId, user.id))) {
    return apiError('Não é membro deste workspace', 403, 'NOT_WORKSPACE_MEMBER');
  }

  let query = supabase
    .from('whatsapp_templates')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);

  const { data, error } = await query.overrideTypes<
    TemplateRow[],
    { merge: false }
  >();
  if (error) {
    console.error('[whatsapp/templates GET]', error);
    return apiError('Falha a listar templates', 500, 'DB_QUERY_FAILED');
  }
  return apiOk(data ?? []);
}

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) return apiError('Não autenticado', 401, 'UNAUTHENTICATED');

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return apiError('Body não é JSON válido', 400, 'INVALID_JSON');
  }

  const parsed = upsertSchema.safeParse(rawBody);
  if (!parsed.success) {
    return apiError('Body inválido', 400, 'INVALID_BODY', {
      issues: parsed.error.issues,
    });
  }
  const body = parsed.data;

  if (!(await ensureMember(supabase, body.workspaceId, user.id))) {
    return apiError('Não é membro deste workspace', 403, 'NOT_WORKSPACE_MEMBER');
  }

  const { data: templateId, error: rpcErr } = await supabase.rpc(
    'upsert_whatsapp_template' as never,
    {
      p_workspace_id: body.workspaceId,
      p_meta_template_name: body.meta_template_name,
      p_language: body.language,
      p_category: body.category,
      p_body: body.body,
      p_header_format: body.header_format,
      p_header_text: body.header_text ?? null,
      p_footer: body.footer ?? null,
      p_buttons: body.buttons as unknown as Json,
    } as never
  );

  if (rpcErr) {
    console.error('[whatsapp/templates POST]', rpcErr);
    return apiError('Falha a guardar template', 500, 'RPC_FAILED', {
      dbError: rpcErr.message,
    });
  }

  return apiOk({ id: templateId });
}
