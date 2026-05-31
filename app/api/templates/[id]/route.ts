/**
 * AngoConnect — PATCH + DELETE /api/templates/[id]
 * ===========================================================================
 * Actualiza ou apaga um template privado do workspace. Templates de sistema
 * (is_system=true, workspace_id NULL) são imutáveis via API.
 *
 * Erros:
 *   UNAUTHENTICATED       401
 *   INVALID_ID/BODY/JSON  400
 *   NOT_FOUND             404
 *   SYSTEM_TEMPLATE       403 (tentar editar/apagar template de sistema)
 *   DB_UPDATE/DELETE      500
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiError, apiOk } from '@/lib/api-response';
import {
  type EmailTemplateRow,
  TEMPLATE_SELECT as SHARED_TEMPLATE_SELECT,
  templateCategorySchema,
} from '@/lib/templates/schemas';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TEMPLATE_SELECT =
  'id, workspace_id, name, category, subject, body, language, is_system, variables, created_at';

// ---------------------------------------------------------------------------
// PATCH
// ---------------------------------------------------------------------------

const patchTemplateSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    category: templateCategorySchema.optional(),
    subject: z.string().trim().min(1).max(300).optional(),
    body: z.string().min(10).max(10_000).optional(),
  })
  .refine(
    (b) =>
      b.name !== undefined ||
      b.category !== undefined ||
      b.subject !== undefined ||
      b.body !== undefined,
    {
      message:
        'Body deve conter pelo menos um campo (name/category/subject/body)',
    }
  );

type PatchTemplateBody = z.infer<typeof patchTemplateSchema>;

export async function PATCH(
  request: NextRequest,
  context: { params: { id: string } }
) {
  // 0) Validar UUID
  const idParsed = z.string().uuid().safeParse(context.params.id);
  if (!idParsed.success) {
    return apiError('Template id inválido', 400, 'INVALID_ID', {
      issues: idParsed.error.issues,
    });
  }
  const templateId = idParsed.data;

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

  const parsed = patchTemplateSchema.safeParse(rawBody);
  if (!parsed.success) {
    return apiError('Body inválido — ver issues', 400, 'INVALID_BODY', {
      issues: parsed.error.issues,
    });
  }
  const body: PatchTemplateBody = parsed.data;

  // 3) Lookup — devolve 404 se RLS esconder ou não existir
  const { data: existing, error: lookupErr } = await supabase
    .from('email_templates')
    .select('id, workspace_id, is_system')
    .eq('id', templateId)
    .maybeSingle()
    .overrideTypes<
      { id: string; workspace_id: string | null; is_system: boolean } | null,
      { merge: false }
    >();

  if (lookupErr) {
    console.error('[templates/[id]] lookup falhou', lookupErr);
    return apiError('Falha a procurar template', 500, 'LOOKUP_FAILED');
  }
  if (!existing) {
    return apiError('Template não encontrado', 404, 'NOT_FOUND');
  }

  // 4) System check — templates de sistema não são editáveis via API
  if (existing.is_system || existing.workspace_id === null) {
    return apiError(
      'Templates de sistema não podem ser editados',
      403,
      'SYSTEM_TEMPLATE'
    );
  }

  // 5) UPDATE
  const update: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (body.name !== undefined) update.name = body.name;
  if (body.category !== undefined) update.category = body.category;
  if (body.subject !== undefined) update.subject = body.subject;
  if (body.body !== undefined) update.body = body.body;

  const { data: row, error: updErr } = await supabase
    .from('email_templates')
    .update(update as never)
    .eq('id', templateId)
    .select(TEMPLATE_SELECT)
    .single()
    .overrideTypes<EmailTemplateRow | null, { merge: false }>();

  if (updErr || !row) {
    console.error('[templates/[id]] update falhou', updErr);
    return apiError('Falha a actualizar template', 500, 'DB_UPDATE_FAILED', {
      dbError: updErr?.message,
    });
  }

  return apiOk(row);
}

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

export async function DELETE(
  _request: NextRequest,
  context: { params: { id: string } }
) {
  // 0) Validar UUID
  const idParsed = z.string().uuid().safeParse(context.params.id);
  if (!idParsed.success) {
    return apiError('Template id inválido', 400, 'INVALID_ID', {
      issues: idParsed.error.issues,
    });
  }
  const templateId = idParsed.data;

  // 1) Auth
  const supabase = createClient();
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    return apiError('Não autenticado', 401, 'UNAUTHENTICATED');
  }

  // 2) Lookup — sistema/RLS
  const { data: existing, error: lookupErr } = await supabase
    .from('email_templates')
    .select('id, workspace_id, is_system')
    .eq('id', templateId)
    .maybeSingle()
    .overrideTypes<
      { id: string; workspace_id: string | null; is_system: boolean } | null,
      { merge: false }
    >();

  if (lookupErr) {
    console.error('[templates/[id]] lookup falhou', lookupErr);
    return apiError('Falha a procurar template', 500, 'LOOKUP_FAILED');
  }
  if (!existing) {
    return apiError('Template não encontrado', 404, 'NOT_FOUND');
  }

  if (existing.is_system || existing.workspace_id === null) {
    return apiError(
      'Templates de sistema não podem ser apagados',
      403,
      'SYSTEM_TEMPLATE'
    );
  }

  // 3) DELETE (RLS confirma membership)
  const { error: delErr } = await supabase
    .from('email_templates')
    .delete()
    .eq('id', templateId);

  if (delErr) {
    console.error('[templates/[id]] delete falhou', delErr);
    return apiError('Falha a apagar template', 500, 'DB_DELETE_FAILED', {
      dbError: delErr.message,
    });
  }

  return apiOk({ deleted: true, id: templateId });
}
