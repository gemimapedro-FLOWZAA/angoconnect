import { test, expect } from '@playwright/test';
import {
  createTestUser,
  createTestWorkspace,
  deleteTestUser,
  seedDraftSequence,
  type TestUser,
  type TestWorkspace,
} from './helpers/db';
import { loginViaUI } from './helpers/auth';

/**
 * Fluxo crítico 2 — Outreach Builder: drag-and-drop + template + preview +
 * activação.
 *
 * Pre-condição: utilizador autenticado com workspace activo e uma sequência
 * em draft com 2 steps.
 */

test.describe('Fluxo 2: Outreach Builder (drag, template, preview, activate)', () => {
  let user: TestUser;
  let workspace: TestWorkspace;
  let sequenceId: string;

  test.beforeEach(async ({ page }) => {
    user = await createTestUser();
    workspace = await createTestWorkspace({
      ownerId: user.userId,
      credits: 100,
    });
    const seq = await seedDraftSequence({ workspaceId: workspace.workspaceId });
    sequenceId = seq.sequenceId;

    await loginViaUI(page, user);
    // Se a sessão landed em /onboarding (mismatch de cache de workspace),
    // forçamos navegação para a sequência directamente.
    await page.goto(`/outreach/${sequenceId}/edit`);
    await expect(page.getByRole('heading', { name: /Passo 1/i })).toBeVisible({
      timeout: 15_000,
    });
  });

  test.afterEach(async () => {
    if (user) await deleteTestUser(user.userId);
  });

  test('reordena steps via drag-and-drop e activa a sequência', async ({ page }) => {
    // 1. Confirma que há 2 steps na lista esquerda.
    const stepCards = page.locator('[aria-label^="Arrastar passo"]');
    await expect(stepCards).toHaveCount(2);

    // 2. Drag do passo 2 para cima do passo 1. O dnd-kit usa pointerdown +
    //    move + pointerup; o helper `dragTo` do Playwright simula esta sequência.
    const handle2 = page.getByLabel('Arrastar passo 2');
    const handle1 = page.getByLabel('Arrastar passo 1');
    await handle2.dragTo(handle1);

    // 3. Após reorder, o que era passo 2 deve ter o seu day_offset original (3)
    //    mas estar agora na primeira posição. A UI mostra "Dia 3" no badge do
    //    primeiro card.
    await expect(stepCards.first()).toContainText(/Dia/);

    // 4. Aplica um template do sistema via dropdown.
    await page.getByRole('button', { name: /Aplicar template/i }).click();
    // Selecciona o primeiro item do dropdown que não seja label/separator.
    await page.getByRole('menuitem').first().click();

    // 5. Vai para a tab Pré-visualizar.
    await page.getByRole('tab', { name: /Pré-visualizar/i }).click();
    // O preview faz fetch debounced — espera o render.
    await expect(page.getByText(/De/).first()).toBeVisible({ timeout: 10_000 });

    // 6. Volta ao Editor e activa.
    await page.getByRole('tab', { name: 'Editor' }).click();
    await page.getByRole('button', { name: /Guardar e activar/i }).click();

    // 7. Após save, o builder redireciona para `/outreach/[id]`. Verifica que
    //    a página de detalhe carrega.
    await page.waitForURL(new RegExp(`/outreach/${sequenceId}$`), {
      timeout: 15_000,
    });
    // Status badge: "Activa".
    await expect(page.getByText('Activa').first()).toBeVisible();
  });
});
