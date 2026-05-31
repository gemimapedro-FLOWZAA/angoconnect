/**
 * AngoConnect — Vitest configuration (M4.1)
 * ===========================================================================
 * Suite de testes unitários + integração de API routes. Não toca em produção,
 * não levanta servidor Next — chama os handlers directamente como funções.
 *
 * Excluímos `apify-actors/**` (têm o seu próprio runtime e dependências) e
 * `e2e/**` (Playwright, gerido pelo agente paralelo).
 *
 * Aliases: `@/...` igual ao tsconfig.
 */

import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['**/*.test.ts', '**/*.test.tsx'],
    exclude: [
      'node_modules/**',
      'apify-actors/**',
      'e2e/**',
      '.next/**',
      'dist/**',
    ],
    setupFiles: ['./test-utils/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['lib/**/*.ts', 'app/api/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/types.ts',
        'lib/queue/workers/**',
        'lib/supabase/types.ts',
      ],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
    },
  },
});
