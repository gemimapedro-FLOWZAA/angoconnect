import { test, expect } from '@playwright/test';
import { createTestUser, deleteTestUser, seedCompanyWithContact, type TestUser } from './helpers/db';
import { loginViaUI } from './helpers/auth';

/**
 * Fluxo crítico 1 — Login → Onboarding → Search → Reveal → Export.
 *
 * Não testamos o signup público completo (exige email confirmation, que em
 * Supabase local fica em Inbucket — fora do scope deste teste). Criamos o
 * utilizador via admin API com `email_confirm: true` e arrancamos no /login.
 */

test.describe('Fluxo 1: Login → Onboarding → Search → Reveal → Export', () => {
  let user: TestUser;

  test.beforeEach(async () => {
    user = await createTestUser();
  });

  test.afterEach(async () => {
    if (user) await deleteTestUser(user.userId);
  });

  test('faz login, cria workspace e revela um contacto', async ({ page }) => {
    // 1. Login via UI
    await loginViaUI(page, user);

    // 2. Onboarding — utilizador novo, sem workspace → redirect /onboarding.
    await expect(page).toHaveURL(/\/onboarding/);
    const wsName = `Acme E2E ${Date.now()}`;
    await page.getByLabel('Nome do workspace').fill(wsName);
    // O slug é auto-gerado a partir do nome. Confirmamos que está pre-preenchido.
    const slugInput = page.getByLabel('Slug');
    await expect(slugInput).not.toHaveValue('');
    await page.getByRole('button', { name: 'Criar workspace' }).click();

    // 3. Redirect para /search
    await page.waitForURL(/\/search/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Pesquisar empresas' })).toBeVisible();

    // 4. Para verificar o reveal, precisamos de uma company com contacto no
    //    workspace acabado de criar. Buscamos o workspace_id do banner de créditos
    //    e fazemos seed via admin client.
    //    O DOM não expõe o workspace_id directamente. Usamos a API /api/me que
    //    devolve o workspace activo da sessão.
    const meResponse = await page.request.get('/api/me');
    expect(meResponse.ok()).toBeTruthy();
    const me = (await meResponse.json()) as {
      data?: { workspaces?: Array<{ id: string }> };
    };
    const workspaceId = me.data?.workspaces?.[0]?.id;
    expect(workspaceId, '/api/me devolveu workspaces[].id').toBeTruthy();

    const seeded = await seedCompanyWithContact({
      workspaceId: workspaceId!,
      companyName: `E2E Banco ${Date.now()}`,
      sector: 'banking',
      provincia: 'Luanda',
    });

    // 5. Re-render: refresca a página para apanhar a company seeded.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Pesquisar empresas' })).toBeVisible();

    // 6. Aplicar filtros (sector banking + provincia Luanda). Usamos URL
    //    directa porque os MultiSelects são complexos de simular; o componente
    //    aceita query params nativos.
    await page.goto('/search?sector=banking&provincia=Luanda');
    await expect(page.getByText(/empresa/i).first()).toBeVisible({ timeout: 10_000 });

    // 7. Clica na company para abrir o sheet de detalhes.
    // Mais fiável: procurar pelo nome.
    const companyRow = page.getByRole('row').filter({ hasText: 'E2E Banco' }).first();
    await companyRow.click();

    // 8. Drawer abre — clica "Revelar".
    const revealButton = page.getByRole('button', { name: /Revelar/i }).first();
    await expect(revealButton).toBeVisible({ timeout: 10_000 });
    await revealButton.click();

    // 9. Email aparece desmascarado (já não tem ***).
    await expect(page.getByText(/@example\.test/)).toBeVisible({ timeout: 10_000 });
  });

  test('selecciona múltiplas empresas e abre export dialog', async ({ page }) => {
    await loginViaUI(page, user);
    await expect(page).toHaveURL(/\/onboarding/);
    await page.getByLabel('Nome do workspace').fill(`Acme Export ${Date.now()}`);
    await page.getByRole('button', { name: 'Criar workspace' }).click();
    await page.waitForURL(/\/search/);

    // Buscar workspace_id e seedar 3 companies.
    const me = (await page.request.get('/api/me').then((r) => r.json())) as {
      data?: { workspaces?: Array<{ id: string }> };
    };
    const workspaceId = me.data?.workspaces?.[0]?.id as string;

    for (let i = 0; i < 3; i++) {
      await seedCompanyWithContact({
        workspaceId,
        companyName: `Export Co ${i} ${Date.now()}`,
      });
    }

    await page.reload();

    // Selecciona 3 rows via checkbox da tabela.
    const checkboxes = page.getByRole('checkbox');
    const count = await checkboxes.count();
    // Pula o "select all" (index 0) e marca 3 individuais.
    for (let i = 1; i <= 3 && i < count; i++) {
      await checkboxes.nth(i).check({ force: true });
    }

    await expect(page.getByText(/seleccionada/i)).toBeVisible();

    // Botão de export fica activo.
    const exportBtn = page.getByRole('button', { name: 'Exportar para sequência' });
    await expect(exportBtn).toBeEnabled();
    await exportBtn.click();

    // Dialog mostra preview de créditos (esperamos ver "créditos" no texto).
    await expect(page.getByText(/créditos/i).first()).toBeVisible({ timeout: 10_000 });
  });
});
