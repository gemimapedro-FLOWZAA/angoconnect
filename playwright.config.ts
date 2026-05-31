import { defineConfig, devices } from '@playwright/test';

/**
 * Configuração Playwright para os testes E2E do AngoConnect.
 *
 * Decisões importantes:
 * - `fullyParallel: false` + `workers: 1` — os testes E2E partilham estado da
 *   base de dados (workspaces, deals, sequences). Correr em paralelo causaria
 *   flakiness e violações de constraints únicos. Aceitamos o trade-off de
 *   tempo total mais alto pela determinismo.
 * - `webServer.command: npm run dev` — assumimos que o utilizador tem Supabase
 *   local + Redis a correr separadamente (ver `e2e/README.md`).
 * - `locale: pt-PT` + `timezoneId: Africa/Luanda` — assertions sobre datas e
 *   moeda (AKZ) dependem desta configuração para ser consistentes localmente
 *   e em CI.
 * - `retries: 2 em CI` — apenas para absorver flakiness de network/queue, não
 *   para mascarar bugs reais.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html']] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    locale: 'pt-PT',
    timezoneId: 'Africa/Luanda',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
