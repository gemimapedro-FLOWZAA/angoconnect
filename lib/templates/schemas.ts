// AngoConnect — Schemas + shapes partilhados de email_templates (M3.2)
// ===========================================================================
// Vivem fora dos `route.ts` por restrição do Next.js (só HTTP handlers).

import { z } from 'zod';
import type { Json } from '@/lib/supabase/types';

export const templateCategorySchema = z.enum([
  'intro',
  'follow_up',
  'break_up',
  'check_in',
  'custom',
]);

export type EmailTemplateCategory = z.infer<typeof templateCategorySchema>;

export const templateLanguageSchema = z.enum(['pt-PT', 'pt-AO', 'en']);

export type EmailTemplateLanguage = z.infer<typeof templateLanguageSchema>;

export interface EmailTemplateRow {
  id: string;
  workspace_id: string | null;
  name: string;
  category: EmailTemplateCategory;
  subject: string;
  body: string;
  language: EmailTemplateLanguage;
  is_system: boolean;
  variables: Json;
  created_at: string;
}

export const TEMPLATE_SELECT =
  'id, workspace_id, name, category, subject, body, language, is_system, variables, created_at';
