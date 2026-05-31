// AngoConnect — Schemas Zod partilhados de sequences (M2.3 + M3.2)
// ===========================================================================
// Vivem fora dos `route.ts` porque o Next.js só permite exportar HTTP
// handlers + options conhecidas — qualquer outro export falha o build.

import { z } from 'zod';

export const sequenceStepSchema = z
  .object({
    day_offset: z.number().int().min(0).max(90),
    channel: z.enum(['email', 'whatsapp']),
    subject: z.string().min(1).max(300).optional(),
    body: z.string().min(1).max(10_000),
    template_id: z.string().uuid().optional(),
  })
  .superRefine((step, ctx) => {
    if (step.channel === 'email' && !step.subject) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['subject'],
        message: 'subject é obrigatório para channel="email"',
      });
    }
  });

export type SequenceStepInput = z.infer<typeof sequenceStepSchema>;
