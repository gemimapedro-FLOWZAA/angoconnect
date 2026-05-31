import { createClient } from '@/lib/supabase/server';
import { DashboardNav } from './nav';
import { SelectedCompaniesProvider } from '@/components/companies/selected-companies-context';
import { HeaderSelectionIndicator } from './header-selection-indicator';

type WorkspaceSummary = {
  id: string;
  name: string;
  credits_remaining: number | null;
};

async function getCurrentWorkspace(): Promise<WorkspaceSummary | null> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  // Tentativa best-effort: middleware já garante que o user tem workspace
  // antes de chegar a /(dashboard). Lemos directamente da tabela com RLS.
  const { data, error } = await supabase
    .from('workspaces')
    .select('id, name, credits_remaining')
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  return data as WorkspaceSummary;
}

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const workspace = await getCurrentWorkspace();

  return (
    <SelectedCompaniesProvider>
      <div className="flex min-h-screen flex-col bg-background">
        <header className="border-b border-border bg-card">
          <div className="container flex h-14 items-center justify-between">
            <div className="flex items-center gap-3">
              <a href="/search" className="text-base font-bold tracking-tight">
                AngoConnect
              </a>
              {workspace ? (
                <>
                  <span className="text-muted-foreground">/</span>
                  <span className="text-sm font-medium">{workspace.name}</span>
                </>
              ) : null}
            </div>
            <div className="flex items-center gap-3 text-sm">
              <HeaderSelectionIndicator />
              {workspace ? (
                <span className="rounded-md bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
                  {workspace.credits_remaining ?? 0} créditos
                </span>
              ) : null}
            </div>
          </div>
        </header>

        <div className="container flex flex-1 gap-6 py-6">
          <aside className="hidden w-56 shrink-0 lg:block">
            <DashboardNav />
          </aside>

          <section className="flex-1">{children}</section>
        </div>
      </div>
    </SelectedCompaniesProvider>
  );
}
