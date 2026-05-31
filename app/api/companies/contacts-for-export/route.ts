/**
 * AngoConnect — POST /api/companies/contacts-for-export
 * ===========================================================================
 * Endpoint auxiliar para o modal de export do frontend. Dado um conjunto
 * de companies seleccionadas, devolve os contact_ids elegíveis para export
 * (i.e., têm email) e um resumo para o preview de créditos a debitar.
 *
 * Body:
 *   { workspaceId: uuid, companyIds: uuid[] (1..200) }
 *
 * Lógica:
 *   - Contactos visíveis ao workspace (públicos OU privados do ws).
 *   - Apenas contactos com email não null.
 *   - Devolve também:
 *       * `total_contacts_visible`           — todos os contactos visíveis
 *           (apenas conta, não revela emails).
 *       * `contacts_with_email`              — subset com email.
 *       * `already_revealed_count`           — entre os elegíveis, quantos
 *           já estão revelados pelo workspace (custo 0).
 *       * `to_reveal_count`                  — quantos serão cobrados se
 *           o export for confirmado.
 *       * `estimated_credits`                — to_reveal_count * 1 (cost).
 *
 *   O frontend usa `contactIds` para passar ao endpoint de enrolment ou de
 *   reveal, e usa `estimated_credits` no modal de confirmação.
 *
 * Resposta:
 *   {
 *     data: {
 *       contactIds: uuid[],
 *       summary: {
 *         companies_scanned: number,
 *         total_contacts_visible: number,
 *         contacts_with_email: number,
 *         already_revealed_count: number,
 *         to_reveal_count: number,
 *         estimated_credits: number
 *       }
 *     }
 *   }
 *
 * Erros:
 *   UNAUTHENTICATED       401
 *   INVALID_BODY          400
 *   NOT_WORKSPACE_MEMBER  403
 *   DB_QUERY_FAILED       500
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiError, apiOk } from '@/lib/api-response';
import { createClient } from '@/lib/supabase/server';
import {
  assertWorkspaceMembership,
  getRevealedContactIds,
} from '@/lib/companies/queries';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REVEAL_COST = 1;

const bodySchema = z.object({
  workspaceId: z.string().uuid(),
  companyIds: z.array(z.string().uuid()).min(1).max(200),
});

interface ContactRow {
  id: string;
  company_id: string;
  workspace_id: string | null;
  email: string | null;
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

  // 2) Body
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return apiError('Body não é JSON válido', 400, 'INVALID_JSON');
  }

  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return apiError('Body inválido — ver issues', 400, 'INVALID_BODY', {
      issues: parsed.error.issues,
    });
  }
  const body = parsed.data;

  // 3) Membership
  const isMember = await assertWorkspaceMembership(
    supabase,
    body.workspaceId,
    user.id
  );
  if (!isMember) {
    return apiError(
      'Não é membro deste workspace',
      403,
      'NOT_WORKSPACE_MEMBER'
    );
  }

  // 4) Busca contactos visíveis dessas companies.
  //    O cap de 200 companies × ~50 contacts médios = ~10k rows max — ok
  //    para uma chamada única.
  const { data: contactRows, error: contactsErr } = await supabase
    .from('contacts')
    .select('id, company_id, workspace_id, email')
    .in('company_id', body.companyIds)
    .or(`workspace_id.is.null,workspace_id.eq.${body.workspaceId}`)
    .overrideTypes<ContactRow[], { merge: false }>();

  if (contactsErr) {
    console.error('[contacts-for-export] query falhou', contactsErr);
    return apiError(
      'Falha a procurar contactos',
      500,
      'DB_QUERY_FAILED',
      { dbError: contactsErr.message }
    );
  }

  const rows: ContactRow[] = contactRows ?? [];

  const totalVisible = rows.length;
  const withEmail = rows.filter((r) => r.email && r.email.trim().length > 0);

  // Privados do workspace: free.
  // Públicos: precisamos de saber quais já estão revelados.
  const publicWithEmail = withEmail.filter((r) => r.workspace_id === null);
  const privateWithEmail = withEmail.filter(
    (r) => r.workspace_id === body.workspaceId
  );

  const revealedSet = await getRevealedContactIds(
    supabase,
    body.workspaceId,
    publicWithEmail.map((r) => r.id)
  );

  const publicAlreadyRevealed = publicWithEmail.filter((r) =>
    revealedSet.has(r.id)
  );
  const publicToReveal = publicWithEmail.filter((r) => !revealedSet.has(r.id));

  const eligibleIds = [
    ...privateWithEmail.map((r) => r.id),
    ...publicAlreadyRevealed.map((r) => r.id),
    ...publicToReveal.map((r) => r.id),
  ];

  return apiOk({
    contactIds: eligibleIds,
    summary: {
      companies_scanned: body.companyIds.length,
      total_contacts_visible: totalVisible,
      contacts_with_email: withEmail.length,
      already_revealed_count: publicAlreadyRevealed.length,
      to_reveal_count: publicToReveal.length,
      estimated_credits: publicToReveal.length * REVEAL_COST,
    },
  });
}
