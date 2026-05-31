/**
 * AngoConnect — Vitest setup global
 * ===========================================================================
 * Corre uma única vez antes da suite.
 *
 * Responsabilidades:
 *   1. Carregar `.env.test` (placeholders inócuos para os módulos que
 *      importam env no top-level — ex: `lib/billing/plans.ts`,
 *      `lib/email/resend.ts`, `lib/supabase/admin.ts`).
 *   2. Definir um valor mínimo para NODE_ENV (`test`).
 *   3. Hooks globais (`afterEach`) — reset de mocks por defeito.
 *
 * Não fazemos start do MSW server aqui — fica para os testes que precisem
 * explicitamente. A maioria dos integration tests usa `vi.mock` directo
 * dos módulos Supabase/Resend/Anthropic, que é mais simples e rápido.
 */

import { afterEach, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Loader simples de .env.test (evita dependência extra de dotenv)
// ---------------------------------------------------------------------------

function loadEnvFile(filePath: string): void {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, 'utf-8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // strip surrounding quotes (simples)
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(path.resolve(__dirname, '..', '.env.test'));

// Garante NODE_ENV='test' (alguns módulos ramificam por isto).
if (process.env.NODE_ENV !== 'test') {
  // @ts-expect-error NODE_ENV é readonly no @types/node mas temos de sobrepor.
  process.env.NODE_ENV = 'test';
}

// ---------------------------------------------------------------------------
// Hooks globais
// ---------------------------------------------------------------------------

afterEach(() => {
  // Reset state de mocks entre testes para evitar leakage acidental. Os
  // factories individuais (`vi.mock(...)`) continuam activos — só os call
  // counts / implementations dinâmicas são limpos.
  vi.clearAllMocks();
});
