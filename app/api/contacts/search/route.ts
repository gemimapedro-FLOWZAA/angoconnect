/**
 * AngoConnect — GET /api/contacts/search (M3.4)
 * ===========================================================================
 * Autocomplete de contactos para o NewDealDialog do CRM.
 * Query: ?workspaceId=uuid&q=string&limit=10
 *
 * Filtros aplicados:
 *   - workspace_id IS NULL (catálogo público) OR workspace_id = workspaceId
 *   - name ILIKE '%q%' OR email ILIKE '%q%'
 *   - email IS NOT NULL (sem email, não dá para criar deal útil)
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiError, apiOk } from '@/lib/api-response';
import { createClient } from '@/lib/supabase/server';

const searchSchema = z.object({
  workspaceId: z.string().uuid(),
  q: z.string().trim().min(2).max(120),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

interface ContactSearchRow {
  id: string;
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  company:
    | { id: string; name: string; sector: string | null; provincia: string | null }
    | null;
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
  const parsed = searchSchema.safeParse({
    workspaceId: searchParams.get('workspaceId') ?? undefined,
    q: searchParams.get('q') ?? undefined,
    limit: searchParams.get('limit') ?? undefined,
  });
  if (!parsed.success) {
    return apiError('Query inválida', 400, 'INVALID_QUERY', {
      issues: parsed.error.issues,
    });
  }
  const { workspaceId, q, limit } = parsed.data;

  // Membership check
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

  // Escape % e _ no q para evitar wildcards inesperados
  const safeQ = q.replace(/[%_]/g, (m) => `\\${m}`);
  const pattern = `%${safeQ}%`;

  const { data, error } = await supabase
    .from('contacts')
    .select(
      `id, name, title, email, phone,
       company:companies(id, name, sector, provincia)`
    )
    .or(`workspace_id.is.null,workspace_id.eq.${workspaceId}`)
    .not('email', 'is', null)
    .or(`name.ilike.${pattern},email.ilike.${pattern}`)
    .order('name', { ascending: true })
    .limit(limit)
    .overrideTypes<ContactSearchRow[], { merge: false }>();

  if (error) {
    console.error('[contacts/search]', error);
    return apiError('Falha a procurar contactos', 500, 'DB_QUERY_FAILED');
  }

  return apiOk(data ?? []);
}
