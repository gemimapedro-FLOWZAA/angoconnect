import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PLAN_IDS, PLANS, type PlanId } from '@/lib/billing/plans';
import { CheckoutButton } from './checkout-button';
import { PortalButton } from './portal-button';

export const metadata = {
  title: 'Faturação — AngoConnect',
};

type SearchParams = {
  success?: string;
  canceled?: string;
};

const PT_DATE = new Intl.DateTimeFormat('pt-PT', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return PT_DATE.format(d);
}

function formatCredits(credits: number, planId: PlanId): string {
  // O sentinel 999_999 representa "ilimitado" no plano Pro.
  if (planId === 'pro' || credits >= 999_000) return 'Ilimitado';
  return new Intl.NumberFormat('pt-PT').format(credits);
}

export default async function BillingPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Casts via overrideTypes contornam a inferência incompleta de
  // createServerClient<Database> com select(...) projectado. Removível quando
  // tipos forem regenerados via supabase gen types typescript.
  const { data: workspace } = await supabase
    .from('workspaces')
    .select('id, name, plan, credits_remaining')
    .limit(1)
    .single()
    .overrideTypes<
      { id: string; name: string; plan: PlanId; credits_remaining: number },
      { merge: false }
    >();

  if (!workspace) redirect('/onboarding');

  const { data: subscription } = await supabase
    .from('subscriptions')
    .select('plan, status, current_period_end, cancel_at_period_end')
    .eq('workspace_id', workspace.id)
    .maybeSingle()
    .overrideTypes<
      {
        plan: PlanId;
        status: 'active' | 'past_due' | 'canceled' | 'trialing' | 'incomplete' | 'unpaid';
        current_period_end: string | null;
        cancel_at_period_end: boolean;
      },
      { merge: false }
    >();

  const hasActiveSubscription = Boolean(
    subscription && ['active', 'trialing', 'past_due'].includes(subscription.status)
  );

  const currentPlanId: PlanId = (subscription?.plan ?? workspace.plan) as PlanId;
  const currentPlanDef = PLANS[currentPlanId];
  const renewsAt = formatDate(subscription?.current_period_end ?? null);

  const showSuccess = searchParams.success === '1';
  const showCanceled = searchParams.canceled === '1';

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Faturação e plano
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Gere a tua subscrição, vê os créditos disponíveis e altera de plano
          quando precisares.
        </p>
      </div>

      {showSuccess ? (
        <Alert className="border-emerald-200 bg-emerald-50 text-emerald-900">
          <AlertTitle>Subscrição activada com sucesso</AlertTitle>
          <AlertDescription>
            O pagamento foi confirmado. Os créditos do novo plano vão aparecer
            em alguns segundos.
          </AlertDescription>
        </Alert>
      ) : null}

      {showCanceled ? (
        <Alert className="border-amber-200 bg-amber-50 text-amber-900">
          <AlertTitle>Checkout cancelado</AlertTitle>
          <AlertDescription>
            Não foi cobrado nenhum valor. Podes voltar a escolher um plano em
            baixo quando estiveres pronto.
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Resumo: plano actual + créditos */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-2">
              <div>
                <CardDescription>Plano actual</CardDescription>
                <CardTitle className="mt-1">{currentPlanDef.name}</CardTitle>
              </div>
              {subscription?.cancel_at_period_end ? (
                <Badge variant="warning">Cancela no fim do período</Badge>
              ) : hasActiveSubscription ? (
                <Badge variant="success">Activo</Badge>
              ) : (
                <Badge variant="secondary">Sem subscrição</Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              ${currentPlanDef.priceMonthly}/mês ·{' '}
              {currentPlanDef.seatsIncluded >= 999
                ? 'utilizadores ilimitados'
                : `${currentPlanDef.seatsIncluded} ${currentPlanDef.seatsIncluded === 1 ? 'utilizador' : 'utilizadores'}`}
            </p>
            {renewsAt ? (
              <p className="text-sm text-muted-foreground">
                {subscription?.cancel_at_period_end
                  ? `Termina em ${renewsAt}`
                  : `Renova em ${renewsAt}`}
              </p>
            ) : null}
            {hasActiveSubscription ? (
              <PortalButton />
            ) : (
              <Button variant="outline" disabled className="w-fit">
                Ainda sem subscrição
              </Button>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription>Créditos</CardDescription>
            <CardTitle className="mt-1">
              {formatCredits(workspace.credits_remaining, currentPlanId)}
              {currentPlanId !== 'pro' ? (
                <span className="ml-1 text-base font-normal text-muted-foreground">
                  / {formatCredits(currentPlanDef.creditsIncluded, currentPlanId)}
                </span>
              ) : null}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {renewsAt
                ? `Repõem em ${renewsAt}.`
                : 'Subscreve um plano para começar a receber créditos automaticamente.'}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Plan picker */}
      <div className="flex flex-col gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">
            Mudar de plano
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Todos os planos cobram em USD e renovam mensalmente. Cancela a
            qualquer altura.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          {PLAN_IDS.map((planId) => {
            const plan = PLANS[planId];
            const isCurrent = planId === currentPlanId && hasActiveSubscription;
            const isUpgrade =
              PLAN_IDS.indexOf(planId) > PLAN_IDS.indexOf(currentPlanId);

            return (
              <Card
                key={planId}
                className={
                  planId === 'growth'
                    ? 'border-primary/40 shadow-md'
                    : undefined
                }
              >
                <CardHeader>
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle>{plan.name}</CardTitle>
                    {isCurrent ? (
                      <Badge variant="success">Plano actual</Badge>
                    ) : planId === 'growth' ? (
                      <Badge variant="default">Mais popular</Badge>
                    ) : null}
                  </div>
                  <div className="mt-2 flex items-baseline gap-1">
                    <span className="text-3xl font-semibold tracking-tight">
                      ${plan.priceMonthly}
                    </span>
                    <span className="text-sm text-muted-foreground">/mês</span>
                  </div>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <ul className="flex flex-col gap-2 text-sm">
                    {plan.features.map((feature) => (
                      <li
                        key={feature}
                        className="flex items-start gap-2 text-foreground"
                      >
                        <span
                          aria-hidden="true"
                          className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                        />
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>

                  {isCurrent ? (
                    <Button variant="outline" disabled className="w-full">
                      Plano actual
                    </Button>
                  ) : (
                    <CheckoutButton
                      workspaceId={workspace.id}
                      planId={planId}
                      label={isUpgrade ? `Fazer upgrade` : `Mudar para ${plan.name}`}
                      variant={planId === 'growth' ? 'default' : 'outline'}
                    />
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Pagamentos processados pela Stripe. Não guardamos dados de cartão nos
        nossos servidores.
      </p>
    </div>
  );
}
