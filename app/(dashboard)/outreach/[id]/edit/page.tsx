import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import {
  SequenceBuilder,
  type SequenceDTO,
  type SequenceStep,
  type SequenceStatus,
} from './sequence-builder';

export const metadata = {
  title: 'Editar sequência — AngoConnect',
};

interface SequenceRow {
  id: string;
  workspace_id: string;
  name: string;
  status: SequenceStatus;
  steps: unknown;
}

/**
 * Normaliza o jsonb `steps` vindo da DB. Tolera shapes parciais (legacy) e
 * preenche defaults para `body`/`day_offset`/`channel`.
 */
function normalizeSteps(raw: unknown): SequenceStep[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s): SequenceStep | null => {
      if (!s || typeof s !== 'object') return null;
      const rec = s as Record<string, unknown>;
      const day = typeof rec.day_offset === 'number' ? rec.day_offset : 0;
      const ch =
        rec.channel === 'whatsapp' ? 'whatsapp' : 'email';
      const subject = typeof rec.subject === 'string' ? rec.subject : '';
      const body = typeof rec.body === 'string' ? rec.body : '';
      const templateId =
        typeof rec.template_id === 'string' ? rec.template_id : undefined;
      return {
        day_offset: day,
        channel: ch,
        subject,
        body,
        template_id: templateId,
      };
    })
    .filter((s): s is SequenceStep => s !== null);
}

interface WorkspaceRow {
  id: string;
  name: string;
}

export default async function EditSequencePage({
  params,
}: {
  params: { id: string };
}) {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: sequence } = await supabase
    .from('sequences')
    .select('id, workspace_id, name, status, steps')
    .eq('id', params.id)
    .maybeSingle()
    .overrideTypes<SequenceRow | null, { merge: false }>();

  if (!sequence) notFound();

  // Best-effort: vamos buscar o nome do workspace para pré-preencher o
  // sender_company no diálogo IA. Se a query falhar passamos defaults vazios
  // e o utilizador preenche à mão.
  const { data: workspace } = await supabase
    .from('workspaces')
    .select('id, name')
    .eq('id', sequence.workspace_id)
    .maybeSingle()
    .overrideTypes<WorkspaceRow | null, { merge: false }>();

  const userMeta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const senderName =
    typeof userMeta.full_name === 'string'
      ? userMeta.full_name
      : typeof userMeta.name === 'string'
        ? userMeta.name
        : (user.email ?? undefined);

  const aiContextDefaults = {
    senderName: senderName ?? undefined,
    senderCompany: workspace?.name ?? undefined,
  };

  const dto: SequenceDTO = {
    id: sequence.id,
    name: sequence.name,
    status: sequence.status,
    steps: normalizeSteps(sequence.steps),
  };

  return (
    <SequenceBuilder
      sequence={dto}
      workspaceId={sequence.workspace_id}
      aiContextDefaults={aiContextDefaults}
    />
  );
}
