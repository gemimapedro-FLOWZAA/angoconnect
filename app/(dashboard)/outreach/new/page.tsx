import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import type { Json } from '@/lib/supabase/types';

export const metadata = {
  title: 'Nova sequência — AngoConnect',
};

interface CreatedSequence {
  id: string;
}

/**
 * M3.2 — Em vez de mostrar um form linear, esta rota cria um draft mínimo
 * (1 step vazio) directamente na DB e redirecciona para o builder
 * `/outreach/[id]/edit`. Assim o utilizador entra logo no editor com DnD,
 * templates e preview.
 *
 * Nota: a criação é feita server-side (via Supabase SSR client) em vez de um
 * POST `/api/sequences` para evitar a viagem de ida-e-volta extra à API e
 * para garantir que o redirect acontece antes de qualquer hidratação cliente.
 */
export default async function NewSequencePage() {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: workspace } = await supabase
    .from('workspaces')
    .select('id')
    .limit(1)
    .maybeSingle()
    .overrideTypes<{ id: string } | null, { merge: false }>();

  if (!workspace) redirect('/onboarding');

  const draftSteps: Json = [
    {
      day_offset: 0,
      channel: 'email',
      subject: '',
      body: '',
    },
  ] as unknown as Json;

  const { data: created, error } = await supabase
    .from('sequences')
    .insert({
      workspace_id: workspace.id,
      name: 'Nova sequência',
      status: 'draft',
      steps: draftSteps,
      created_by: user.id,
    } as never)
    .select('id')
    .single()
    .overrideTypes<CreatedSequence | null, { merge: false }>();

  if (error || !created) {
    // Em caso de falha, voltamos para a listagem com um query param para
    // mostrar erro (o cliente pode interpretar se quiser).
    console.error('[outreach/new] falha a criar draft', error);
    redirect('/outreach?error=create_failed');
  }

  redirect(`/outreach/${created.id}/edit`);
}
