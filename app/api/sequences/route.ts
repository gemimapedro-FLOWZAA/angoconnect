/**
 * AngoConnect — POST /api/sequences
 * ===========================================================================
 * Cria uma nova sequence (cadência de outreach).
 *
 * Body:
 *   {
 *     workspaceId: uuid,
 *     name: string (2-80),
 *     steps: [{ day_offset, channel, subject?, body, template_id? }, ...],
 *     status?: 'draft' | 'active'   (default 'draft')
 *   }
 *
 * Erros:
 *   UNAUTHENTICATED       401
 *   INVALID_JSON          400
 *   INVALID_BODY          400
 *   NOT_WORKSPACE_MEMBER  403
 *   DB_INSERT_FAILED      500
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiError, apiOk } from '@/lib/api-response';
import { createClient } from '@/lib/supabase/server';
import type { Json, SequenceStatus } from '@/lib/supabase/types';

interface SequenceRow {
  id: string;
  workspace_id: string;
  name: string;
  status: SequenceStatus;
  steps: Json;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Zod — partilhado também pelo PATCH
// ---------------------------------------------------------------------------

// sequenceStepSchema vive em lib/sequences/schemas.ts (route.ts não pode
// exportar não-handlers)
import { sequenceStepSchema } from '@/lib/sequences/schemas';

const createSequenceSchema = z.object({
  workspaceId: z.string().uuid({ message: 'workspaceId tem de ser UUID' }),
  name: z.string().trim().min(2).max(80),
  steps: z.array(sequenceStepSchema).min(1).max(20),
  status: z.enum(['draft', 'active']).default('draft'),
});

type CreateSequenceBody = z.infer<typeof createSequenceSchema>;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// GET /api/sequences — lista sequences do workspace (M3.1)
// Query: ?workspaceId=uuid&status=draft|active|paused|archived (opcional)
// ---------------------------------------------------------------------------

const listSequencesSchema = z.object({
  workspaceId: z.string().uuid(),
  status: z.enum(['draft', 'active', 'paused', 'archived']).optional(),
});

interface SequenceListRow {
  id: string;
  name: string;
  status: SequenceStatus;
  steps: Json;
  created_at: string;
}

export async function GET(request: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    return apiError('Não autenticado', 401, 'UNAUTHENTICATED');
  }

  const { searchParams } = new URL(request.url);
  const parsed = listSequencesSchema.safeParse({
    workspaceId: searchParams.get('workspaceId') ?? undefined,
    status: searchParams.get('status') ?? undefined,
  });
  if (!parsed.success) {
    return apiError('Query inválida', 400, 'INVALID_QUERY', {
      issues: parsed.error.issues,
    });
  }
  const { workspaceId, status } = parsed.data;

  // Membership (defesa em profundidade; RLS já isola)
  const { data: member } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('workspace_id', workspaceId)
    .eq('user_id', user.id)
    .maybeSingle()
    .overrideTypes<{ workspace_id: string } | null, { merge: false }>();

  if (!member) {
    return apiError('Não é membro deste workspace', 403, 'NOT_WORKSPACE_MEMBER');
  }

  let query = supabase
    .from('sequences')
    .select('id, name, status, steps, created_at')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false });

  if (status) query = query.eq('status', status);

  const { data, error } = await query.overrideTypes<
    SequenceListRow[],
    { merge: false }
  >();

  if (error) {
    console.error('[sequences] list falhou', error);
    return apiError('Falha a listar sequences', 500, 'DB_QUERY_FAILED');
  }

  return apiOk(data ?? []);
}

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

  const parsed = createSequenceSchema.safeParse(rawBody);
  if (!parsed.success) {
    return apiError('Body inválido — ver issues', 400, 'INVALID_BODY', {
      issues: parsed.error.issues,
    });
  }
  const body: CreateSequenceBody = parsed.data;

  // 3) Workspace membership
  const { data: member, error: memberErr } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('workspace_id', body.workspaceId)
    .eq('user_id', user.id)
    .maybeSingle()
    .overrideTypes<{ workspace_id: string } | null, { merge: false }>();

  if (memberErr) {
    console.error('[sequences] erro a verificar workspace_members', memberErr);
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

  // 4) INSERT (RLS valida em profundidade)
  // Cast `as never` na linha .insert — mesmo padrão dos endpoints de
  // billing/apify para tabelas onde os stubs do Database type ainda não
  // ficaram 100% certos (sequences foi adicionada nesta milestone).
  const { data: row, error: insertErr } = await supabase
    .from('sequences')
    .insert({
      workspace_id: body.workspaceId,
      name: body.name,
      status: body.status,
      steps: body.steps as unknown as Json,
      created_by: user.id,
    } as never)
    .select(
      'id, workspace_id, name, status, steps, created_by, created_at, updated_at'
    )
    .single()
    .overrideTypes<SequenceRow | null, { merge: false }>();

  if (insertErr || !row) {
    console.error('[sequences] insert falhou', insertErr);
    return apiError(
      'Falha a criar sequence',
      500,
      'DB_INSERT_FAILED',
      { dbError: insertErr?.message }
    );
  }

  return apiOk(row);
}
