/**
 * AngoConnect — GET + POST + DELETE /api/whatsapp/config
 * ===========================================================================
 * Gestão da config WhatsApp Cloud API por workspace.
 *
 * GET ?workspaceId=...
 *   Retorna a view `workspace_whatsapp_config_safe` (sem `access_token`).
 *   Devolve null se ainda não configurado.
 *
 * POST
 *   Onboarding inicial. Body:
 *     { workspaceId, waba_id, phone_number_id, phone_number, access_token }
 *   - Gera `webhook_verify_token = randomBytes(32).hex()`.
 *   - Upsert no `workspace_whatsapp_config`.
 *   - Marca `is_active=true`, `connected_at=now()`.
 *   - Retorna `{ webhook_verify_token, webhook_url }` para o user copiar
 *     ao Meta App Dashboard.
 *
 * DELETE ?workspaceId=...
 *   Soft disconnect — `is_active=false, disconnected_at=now()`. Mantém os
 *   credentials em DB caso o utilizador queira reactivar mais tarde sem
 *   reonboard.
 *
 * Erros:
 *   UNAUTHENTICATED      401
 *   INVALID_QUERY/BODY   400
 *   NOT_WORKSPACE_MEMBER 403
 *   DB_*                 500
 */

import { randomBytes } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiError, apiOk } from '@/lib/api-response';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { assertWorkspaceMembership } from '@/lib/companies/queries';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Untyped escape hatch para tabelas/views fora dos stubs (migration 0011).
interface UntypedFrom {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (
        col: string,
        val: unknown
      ) => {
        maybeSingle: () => Promise<{
          data: unknown | null;
          error: { message: string } | null;
        }>;
      };
    };
    upsert: (
      values: Record<string, unknown>,
      opts?: { onConflict?: string }
    ) => {
      select: (cols: string) => {
        single: () => Promise<{
          data: unknown | null;
          error: { message: string } | null;
        }>;
      };
    };
    update: (values: Record<string, unknown>) => {
      eq: (
        col: string,
        val: unknown
      ) => Promise<{
        data: unknown | null;
        error: { message: string } | null;
      }>;
    };
  };
}

interface WhatsAppConfigSafe {
  workspace_id: string;
  waba_id: string | null;
  phone_number_id: string;
  phone_number: string | null;
  is_active: boolean;
  connected_at: string | null;
  disconnected_at: string | null;
  webhook_verify_token: string | null;
}

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

const getSchema = z.object({
  workspaceId: z.string().uuid({ message: 'workspaceId tem de ser UUID' }),
});

export async function GET(request: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    return apiError('Não autenticado', 401, 'UNAUTHENTICATED');
  }

  const parsed = getSchema.safeParse({
    workspaceId: request.nextUrl.searchParams.get('workspaceId') ?? undefined,
  });
  if (!parsed.success) {
    return apiError('Query inválida', 400, 'INVALID_QUERY', {
      issues: parsed.error.issues,
    });
  }
  const { workspaceId } = parsed.data;

  const member = await assertWorkspaceMembership(
    supabase,
    workspaceId,
    user.id
  );
  if (!member) {
    return apiError(
      'Não é membro deste workspace',
      403,
      'NOT_WORKSPACE_MEMBER'
    );
  }

  // Usa a VIEW safe (sem access_token).
  const { data, error } = await (
    supabase as unknown as UntypedFrom
  )
    .from('workspace_whatsapp_config_safe')
    .select(
      'workspace_id, waba_id, phone_number_id, phone_number, is_active, connected_at, disconnected_at, webhook_verify_token'
    )
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  if (error) {
    console.error('[whatsapp/config] GET falhou', error);
    return apiError('Lookup falhou', 500, 'DB_QUERY_FAILED', {
      dbError: error.message,
    });
  }

  return apiOk(data as WhatsAppConfigSafe | null);
}

// ---------------------------------------------------------------------------
// POST — onboarding (upsert)
// ---------------------------------------------------------------------------

const postSchema = z.object({
  workspaceId: z.string().uuid({ message: 'workspaceId tem de ser UUID' }),
  waba_id: z.string().trim().min(1).max(80),
  phone_number_id: z.string().trim().min(1).max(80),
  phone_number: z
    .string()
    .trim()
    .regex(/^\+?\d{6,20}$/, 'phone_number tem de ser E.164')
    .optional(),
  access_token: z.string().trim().min(20).max(2000),
});

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

  const parsed = postSchema.safeParse(rawBody);
  if (!parsed.success) {
    return apiError('Body inválido', 400, 'INVALID_BODY', {
      issues: parsed.error.issues,
    });
  }
  const body = parsed.data;

  const member = await assertWorkspaceMembership(
    supabase,
    body.workspaceId,
    user.id
  );
  if (!member) {
    return apiError(
      'Não é membro deste workspace',
      403,
      'NOT_WORKSPACE_MEMBER'
    );
  }

  // access_token é sensível → usa admin client (bypass RLS — colunas
  // restritas por policy). Geramos um verify_token por workspace.
  const admin = createAdminClient();
  const webhook_verify_token = randomBytes(32).toString('hex');

  const { data, error } = await (admin as unknown as UntypedFrom)
    .from('workspace_whatsapp_config')
    .upsert(
      {
        workspace_id: body.workspaceId,
        waba_id: body.waba_id,
        phone_number_id: body.phone_number_id,
        phone_number: body.phone_number ?? null,
        access_token: body.access_token,
        webhook_verify_token,
        is_active: true,
        connected_at: new Date().toISOString(),
        disconnected_at: null,
      },
      { onConflict: 'workspace_id' }
    )
    .select(
      'workspace_id, waba_id, phone_number_id, phone_number, is_active, connected_at, webhook_verify_token'
    )
    .single();

  if (error || !data) {
    console.error('[whatsapp/config] upsert falhou', error);
    return apiError('Falha a guardar config', 500, 'DB_UPSERT_FAILED', {
      dbError: error?.message,
    });
  }

  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL ?? 'https://example.invalid';
  const webhook_url = `${appUrl.replace(/\/$/, '')}/api/whatsapp/webhook`;

  return apiOk({
    config: data,
    webhook_verify_token,
    webhook_url,
  });
}

// ---------------------------------------------------------------------------
// DELETE — soft disconnect
// ---------------------------------------------------------------------------

const deleteSchema = z.object({
  workspaceId: z.string().uuid(),
});

export async function DELETE(request: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    return apiError('Não autenticado', 401, 'UNAUTHENTICATED');
  }

  const parsed = deleteSchema.safeParse({
    workspaceId: request.nextUrl.searchParams.get('workspaceId') ?? undefined,
  });
  if (!parsed.success) {
    return apiError('Query inválida', 400, 'INVALID_QUERY', {
      issues: parsed.error.issues,
    });
  }

  const { workspaceId } = parsed.data;

  const member = await assertWorkspaceMembership(
    supabase,
    workspaceId,
    user.id
  );
  if (!member) {
    return apiError(
      'Não é membro deste workspace',
      403,
      'NOT_WORKSPACE_MEMBER'
    );
  }

  const admin = createAdminClient();
  const { error } = await (admin as unknown as UntypedFrom)
    .from('workspace_whatsapp_config')
    .update({
      is_active: false,
      disconnected_at: new Date().toISOString(),
    })
    .eq('workspace_id', workspaceId);

  if (error) {
    console.error('[whatsapp/config] DELETE falhou', error);
    return apiError('Falha a desligar config', 500, 'DB_UPDATE_FAILED', {
      dbError: error.message,
    });
  }

  return apiOk({ disconnected: true });
}
