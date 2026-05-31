import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { Spinner } from '@/components/ui/spinner';
import { KanbanBoard } from './kanban-board';

export const metadata = {
  title: 'CRM — AngoConnect',
};

type WorkspaceBootstrap = {
  id: string;
};

function CrmFallback() {
  return (
    <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
      <Spinner /> A carregar pipeline…
    </div>
  );
}

export default async function CrmPage() {
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
    .overrideTypes<WorkspaceBootstrap, { merge: false }>();

  if (!workspace) redirect('/onboarding');

  return (
    <Suspense fallback={<CrmFallback />}>
      <KanbanBoard workspaceId={workspace.id} />
    </Suspense>
  );
}
