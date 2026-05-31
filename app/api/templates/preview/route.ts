/**
 * AngoConnect — POST /api/templates/preview
 * ===========================================================================
 * Helper sem-DB para o Outreach Builder renderizar um preview de template
 * substituindo `{{vars}}` por valores dummy (ou pelo `sampleData` que o
 * cliente passe).
 *
 * Body:
 *   {
 *     subject: string,            // obrigatório
 *     body: string,               // obrigatório
 *     sampleData?: Record<string, string>  // merged sobre DEFAULT
 *   }
 *
 * Resposta:
 *   {
 *     data: {
 *       subject: { rendered, missingVars },
 *       body:    { rendered, missingVars },
 *       allVariables: string[],   // união de subject.missingVars + body.missingVars
 *       isValid: boolean          // true se nenhuma variável ficou por preencher
 *     },
 *     error: null
 *   }
 *
 * Erros:
 *   INVALID_JSON   400
 *   INVALID_BODY   400
 *
 * Notas:
 *   - Sem auth — preview é puramente client-side friendly e não toca em DB.
 *   - Sem rate limit explícito por agora (descrito como overkill no brief).
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiError, apiOk } from '@/lib/api-response';
import {
  DEFAULT_PREVIEW_SAMPLE_DATA,
  renderTemplate,
} from '@/lib/templates/render';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Zod
// ---------------------------------------------------------------------------

const previewSchema = z.object({
  subject: z.string().min(1).max(2_000),
  body: z.string().min(1).max(20_000),
  sampleData: z.record(z.string(), z.string()).optional(),
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return apiError('Body não é JSON válido', 400, 'INVALID_JSON');
  }

  const parsed = previewSchema.safeParse(rawBody);
  if (!parsed.success) {
    return apiError('Body inválido — ver issues', 400, 'INVALID_BODY', {
      issues: parsed.error.issues,
    });
  }
  const { subject, body, sampleData } = parsed.data;

  // Merge defaults com o que o cliente passou (overrides win).
  const data: Record<string, string> = {
    ...DEFAULT_PREVIEW_SAMPLE_DATA,
    ...(sampleData ?? {}),
  };

  const subjectResult = renderTemplate(subject, data);
  const bodyResult = renderTemplate(body, data);

  const allVariables = Array.from(
    new Set<string>([...subjectResult.missingVars, ...bodyResult.missingVars])
  );

  const isValid = allVariables.length === 0;

  return apiOk({
    subject: subjectResult,
    body: bodyResult,
    allVariables,
    isValid,
  });
}
