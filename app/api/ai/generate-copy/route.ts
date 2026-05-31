/**
 * AngoConnect — POST /api/ai/generate-copy (M3.4)
 * ===========================================================================
 * Recebe contexto da sequence + step e devolve 1-5 variantes de copy via
 * Claude API. NÃO debita créditos em M3.4 (IA é benefício de plano Pro).
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiError, apiOk } from '@/lib/api-response';
import { createClient } from '@/lib/supabase/server';
import {
  AiConfigError,
  AiParseError,
  generateOutreachCopy,
} from '@/lib/ai/copy-generator';

const contextSchema = z.object({
  companyName: z.string().min(1).max(200),
  sector: z.string().max(80).optional(),
  provincia: z.string().max(80).optional(),
  recipientName: z.string().max(120).optional(),
  recipientTitle: z.string().max(120).optional(),
  senderName: z.string().max(120).optional(),
  senderCompany: z.string().max(120).optional(),
  sequenceGoal: z.string().min(2).max(400),
  tone: z.enum(['profissional', 'amistoso', 'urgente']).optional(),
  previousMessage: z.string().max(4000).optional(),
});

const bodySchema = z.object({
  workspaceId: z.string().uuid(),
  channel: z.enum(['email', 'whatsapp']),
  context: contextSchema,
  variantCount: z.number().int().min(1).max(5).optional(),
});

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    return apiError('Não autenticado', 401, 'UNAUTHENTICATED');
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return apiError('Body não é JSON válido', 400, 'INVALID_JSON');
  }

  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return apiError('Body inválido', 400, 'INVALID_BODY', {
      issues: parsed.error.issues,
    });
  }
  const body = parsed.data;

  // Membership check
  const { data: member } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('workspace_id', body.workspaceId)
    .eq('user_id', user.id)
    .maybeSingle()
    .overrideTypes<{ workspace_id: string } | null, { merge: false }>();
  if (!member) {
    return apiError('Não é membro deste workspace', 403, 'NOT_WORKSPACE_MEMBER');
  }

  try {
    const variants = await generateOutreachCopy({
      channel: body.channel,
      context: body.context,
      variantCount: body.variantCount,
    });
    return apiOk({ variants });
  } catch (err) {
    if (err instanceof AiConfigError) {
      console.error('[ai/generate-copy] config', err.message);
      return apiError(
        'Serviço de IA não configurado',
        503,
        'AI_NOT_CONFIGURED'
      );
    }
    if (err instanceof AiParseError) {
      console.error('[ai/generate-copy] parse', err.message);
      return apiError(
        'Resposta inválida do serviço de IA',
        502,
        'AI_PARSE_FAILED'
      );
    }
    console.error('[ai/generate-copy] unexpected', err);
    return apiError('Erro inesperado a gerar copy', 500, 'AI_UNEXPECTED');
  }
}
