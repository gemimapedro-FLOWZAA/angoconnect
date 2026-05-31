/**
 * AngoConnect — /api/whatsapp/templates/[id] (M3.4)
 * ===========================================================================
 * DELETE — remove template (não permite se já submetido à Meta).
 *
 * (POST :id/submit fica para um sub-route futuro quando integrarmos o submit
 * Meta real — por agora, o user submete o template manualmente na Meta App
 * settings e depois marca como 'submitted' via PATCH.)
 *
 * PATCH — actualiza status (útil para marcar como submitted/approved manualmente
 * enquanto não temos o submit real via Graph API).
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiError, apiOk } from '@/lib/api-response';
import { createClient } from '@/lib/supabase/server';

const patchSchema = z.object({
  status: z.enum([
    'local_draft',
    'submitted',
    'approved',
    'rejected',
    'paused',
    'disabled',
  ]),
  meta_template_id: z.string().max(120).optional(),
  rejection_reason: z.string().max(400).optional(),
});

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(
  request: NextRequest,
  ctx: { params: { id: string } }
) {
  const supabase = createClient();
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) return apiError('Não autenticado', 401, 'UNAUTHENTICATED');

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return apiError('Body não é JSON', 400, 'INVALID_JSON');
  }
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) {
    return apiError('Body inválido', 400, 'INVALID_BODY', {
      issues: parsed.error.issues,
    });
  }

  const { error } = await supabase
    .from('whatsapp_templates')
    .update({
      status: parsed.data.status,
      ...(parsed.data.meta_template_id !== undefined && {
        meta_template_id: parsed.data.meta_template_id,
      }),
      ...(parsed.data.rejection_reason !== undefined && {
        rejection_reason: parsed.data.rejection_reason,
      }),
    } as never)
    .eq('id', ctx.params.id);

  if (error) {
    console.error('[whatsapp/templates PATCH]', error);
    return apiError('Falha a actualizar', 500, 'DB_UPDATE_FAILED');
  }

  return apiOk({ id: ctx.params.id, status: parsed.data.status });
}

export async function DELETE(
  _request: NextRequest,
  ctx: { params: { id: string } }
) {
  const supabase = createClient();
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) return apiError('Não autenticado', 401, 'UNAUTHENTICATED');

  const { error } = await supabase
    .from('whatsapp_templates')
    .delete()
    .eq('id', ctx.params.id);

  if (error) {
    console.error('[whatsapp/templates DELETE]', error);
    return apiError('Falha a apagar', 500, 'DB_DELETE_FAILED');
  }

  return apiOk({ deleted: true, id: ctx.params.id });
}
