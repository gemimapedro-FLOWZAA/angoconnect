import type { Page } from '@playwright/test';
import {
  createTestUser,
  createTestWorkspace,
  type TestUser,
  type TestWorkspace,
} from './db';

/**
 * Faz login via UI usando as credenciais de um utilizador criado pela admin
 * API. Devolve quando a navegação para `/onboarding` ou `/search` estiver
 * concluída (ambos são destinos válidos consoante o utilizador já tenha
 * workspace).
 */
export async function loginViaUI(page: Page, user: TestUser): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  // Aguarda saída do /login — pode ir para /onboarding ou /search.
  await page.waitForURL(/\/(onboarding|search)/, { timeout: 15_000 });
}

/**
 * Setup "tudo pronto": cria utilizador confirmado + workspace + faz login UI.
 * Usar nos testes que querem arrancar já dentro do dashboard.
 */
export async function loginAsAuthenticatedUser(
  page: Page,
  opts?: { credits?: number }
): Promise<{ user: TestUser; workspace: TestWorkspace }> {
  const user = await createTestUser();
  const workspace = await createTestWorkspace({
    ownerId: user.userId,
    credits: opts?.credits ?? 100,
  });
  await loginViaUI(page, user);
  // Se o login terminou em /onboarding (race ou cache), force-navegamos.
  if (page.url().includes('/onboarding')) {
    await page.goto('/search');
  }
  return { user, workspace };
}

/**
 * Cria utilizador SEM workspace — para testes que validam o fluxo completo
 * signup → onboarding → search.
 */
export async function loginWithoutWorkspace(
  page: Page
): Promise<{ user: TestUser }> {
  const user = await createTestUser();
  await loginViaUI(page, user);
  return { user };
}
