import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { Spinner } from '@/components/ui/spinner';
import { AnalyticsClient } from './analytics-client';

export const metadata = {
  title: 'Analytics — AngoConnect',
};

type WorkspaceBootstrap = {
  id: string;
};

function AnalyticsFallback() {
  return (
    <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
      <Spinner /> A carregar analytics…
    </div>
  );
}

export default async function AnalyticsPage() {
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
    <Suspense fallback={<AnalyticsFallback />}>
      <AnalyticsClient workspaceId={workspace.id} />
    </Suspense>
  );
}
