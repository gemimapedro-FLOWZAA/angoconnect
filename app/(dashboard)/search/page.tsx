import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { Spinner } from '@/components/ui/spinner';
import { SearchClient } from './search-client';

export const metadata = {
  title: 'Pesquisar empresas — AngoConnect',
};

type WorkspaceBootstrap = {
  id: string;
  credits_remaining: number | null;
};

function SearchFallback() {
  return (
    <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
      <Spinner /> A carregar pesquisa…
    </div>
  );
}

export default async function SearchPage() {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: workspace } = await supabase
    .from('workspaces')
    .select('id, credits_remaining')
    .limit(1)
    .maybeSingle()
    .overrideTypes<WorkspaceBootstrap, { merge: false }>();

  if (!workspace) redirect('/onboarding');

  return (
    // SearchClient usa `useSearchParams`. O Next 14 exige Suspense à volta
    // para evitar bail-out de static rendering.
    <Suspense fallback={<SearchFallback />}>
      <SearchClient
        workspaceId={workspace.id}
        initialCreditsRemaining={workspace.credits_remaining}
      />
    </Suspense>
  );
}
