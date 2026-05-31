/**
 * AngoConnect — Tipos da base de dados (placeholder)
 *
 * Este ficheiro será regenerado automaticamente pelo Supabase CLI a partir
 * do schema actual (migrations + alterações remotas). NÃO editar à mão
 * a longo prazo — qualquer adição manual é provisória.
 *
 * Gerar localmente (com `supabase start` em execução):
 *   supabase gen types typescript --local > lib/supabase/types.ts
 *
 * Gerar a partir do projecto remoto (após `supabase link --project-ref ...`):
 *   supabase gen types typescript --linked > lib/supabase/types.ts
 *
 * Opcionalmente filtrar schemas:
 *   supabase gen types typescript --local --schema public > lib/supabase/types.ts
 *
 * --------------------------------------------------------------------------
 * Stubs manuais provisórios
 * --------------------------------------------------------------------------
 * Estes stubs cobrem as tabelas que os endpoints usam com o cliente tipado
 * `SupabaseClient<Database>` (apify_runs hoje). Outras tabelas usam clientes
 * untyped (ver `lib/ingest/companies.ts`). Remove tudo dentro de `Tables`
 * quando regenerares os tipos.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type ApifyRunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'aborted'
  | 'timed_out';

export type WorkspaceRole = 'owner' | 'admin' | 'member';
export type WorkspacePlan = 'starter' | 'growth' | 'pro';

export type SubscriptionStatus =
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'trialing'
  | 'incomplete'
  | 'unpaid';

export type SequenceStatus = 'draft' | 'active' | 'paused' | 'archived';

export type EnrollmentStatus =
  | 'active'
  | 'paused'
  | 'completed'
  | 'replied'
  | 'bounced'
  | 'unsubscribed';

export type EmailEventType =
  | 'sent'
  | 'delivered'
  | 'opened'
  | 'clicked'
  | 'replied'
  | 'bounced'
  | 'complained'
  | 'unsubscribed'
  // WhatsApp eventos (M3.4 — migration 0011)
  | 'wa_sent'
  | 'wa_delivered'
  | 'wa_read'
  | 'wa_replied'
  | 'wa_failed';

// ---------------------------------------------------------------------------
// CRM — deals + deal_stages (M3.3 — migration 0010)
// ---------------------------------------------------------------------------

export type DealStatus = 'open' | 'won' | 'lost';

export type DealSource =
  | 'manual'
  | 'email_reply'
  | 'sequence_reply'
  | 'import'
  | 'whatsapp';

// ---------------------------------------------------------------------------
// Email templates (M3.2 — Outreach Builder)
// ---------------------------------------------------------------------------

export type EmailTemplateCategory =
  | 'intro'
  | 'follow_up'
  | 'break_up'
  | 'check_in'
  | 'custom';

export type EmailTemplateLanguage = 'pt-PT' | 'pt-AO' | 'en';

// ---------------------------------------------------------------------------
// Domínio companies / contacts (M3.1 — Search & Discovery)
// ---------------------------------------------------------------------------

export type CompanySector =
  | 'oil_gas'
  | 'banking'
  | 'telecom'
  | 'construction'
  | 'retail'
  | 'agro'
  | 'healthcare'
  | 'education'
  | 'logistics'
  | 'tech'
  | 'government'
  | 'other';

export type CompanySize = 'micro' | 'small' | 'medium' | 'large' | 'enterprise';

export type CompanySource =
  | 'irgc'
  | 'linkedin'
  | 'bue'
  | 'news'
  | 'manual'
  | 'email_enricher';

export const ANGOLA_PROVINCIAS = [
  'Bengo',
  'Benguela',
  'Bié',
  'Cabinda',
  'Cuando Cubango',
  'Cuanza Norte',
  'Cuanza Sul',
  'Cunene',
  'Huambo',
  'Huíla',
  'Luanda',
  'Lunda Norte',
  'Lunda Sul',
  'Malanje',
  'Moxico',
  'Namibe',
  'Uíge',
  'Zaire',
] as const;

export type AngolaProvincia = (typeof ANGOLA_PROVINCIAS)[number];

/**
 * Shape canónico de um step dentro de `sequences.steps[]`.
 * `subject` é obrigatório para channel='email' (validado em Zod) mas opcional
 * no shape SQL para permitir `whatsapp` no futuro (M3.4).
 *
 * Para channel='whatsapp', `template_id` pode apontar para `whatsapp_templates`
 * — nesse caso `template_variables` são os valores ordenados {{1}}, {{2}}, ...
 * a injectar no template. Cada valor é uma string que pode conter placeholders
 * nomeados (ex: `{{first_name}}`) que são resolvidos no worker antes do envio.
 */
export interface SequenceStep {
  day_offset: number;
  channel: 'email' | 'whatsapp';
  subject?: string;
  body: string;
  template_id?: string;
  template_variables?: string[];
}

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          email: string;
          full_name: string | null;
          avatar_url: string | null;
          created_at: string;
        };
        Insert: {
          id: string;
          email: string;
          full_name?: string | null;
          avatar_url?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          email?: string;
          full_name?: string | null;
          avatar_url?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      workspaces: {
        // NOTA: stripe_customer_id, stripe_subscription_id e subscription_status
        // foram movidos para a tabela `subscriptions` na migration 0003.
        Row: {
          id: string;
          name: string;
          slug: string;
          plan: WorkspacePlan;
          credits_remaining: number;
          owner_id: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          slug: string;
          plan?: WorkspacePlan;
          credits_remaining?: number;
          owner_id: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          slug?: string;
          plan?: WorkspacePlan;
          credits_remaining?: number;
          owner_id?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      workspace_members: {
        Row: {
          workspace_id: string;
          user_id: string;
          role: WorkspaceRole;
          joined_at: string;
        };
        Insert: {
          workspace_id: string;
          user_id: string;
          role?: WorkspaceRole;
          joined_at?: string;
        };
        Update: {
          workspace_id?: string;
          user_id?: string;
          role?: WorkspaceRole;
          joined_at?: string;
        };
        Relationships: [];
      };
      apify_runs: {
        Row: {
          id: string;
          workspace_id: string;
          actor_id: string;
          apify_run_id: string | null;
          dataset_id: string | null;
          status: ApifyRunStatus;
          input: Json;
          started_at: string | null;
          finished_at: string | null;
          ingested_items: number;
          error_message: string | null;
          triggered_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          actor_id: string;
          apify_run_id?: string | null;
          dataset_id?: string | null;
          status?: ApifyRunStatus;
          input?: Json;
          started_at?: string | null;
          finished_at?: string | null;
          ingested_items?: number;
          error_message?: string | null;
          triggered_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          actor_id?: string;
          apify_run_id?: string | null;
          dataset_id?: string | null;
          status?: ApifyRunStatus;
          input?: Json;
          started_at?: string | null;
          finished_at?: string | null;
          ingested_items?: number;
          error_message?: string | null;
          triggered_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      subscriptions: {
        // Espelho de subscriptions Stripe por workspace. Criada na migration
        // 0003 e estendida na 0006 (cancel_at_period_end + stripe_price_id).
        // `workspaces.plan` é a fonte de verdade aplicacional — esta tabela
        // reflecte o estado actual no Stripe e dispara o trigger SQL que
        // sincroniza `workspaces.plan` quando status='active'.
        Row: {
          id: string;
          workspace_id: string;
          stripe_customer_id: string | null;
          stripe_subscription_id: string;
          stripe_price_id: string | null;
          plan: WorkspacePlan;
          status: SubscriptionStatus;
          cancel_at_period_end: boolean;
          current_period_end: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          stripe_customer_id?: string | null;
          stripe_subscription_id: string;
          stripe_price_id?: string | null;
          plan: WorkspacePlan;
          status: SubscriptionStatus;
          cancel_at_period_end?: boolean;
          current_period_end?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          stripe_customer_id?: string | null;
          stripe_subscription_id?: string;
          stripe_price_id?: string | null;
          plan?: WorkspacePlan;
          status?: SubscriptionStatus;
          cancel_at_period_end?: boolean;
          current_period_end?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      credits_log: {
        // Histórico de movimentos de créditos. INSERTs são apenas via RPC
        // `add_credits` (SECURITY DEFINER, GRANT execute a service_role).
        Row: {
          id: string;
          workspace_id: string;
          amount: number;
          balance_after: number | null;
          reason: string;
          performed_by: string | null;
          related_entity_type: string | null;
          related_entity_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          amount: number;
          balance_after?: number | null;
          reason: string;
          performed_by?: string | null;
          related_entity_type?: string | null;
          related_entity_id?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          amount?: number;
          balance_after?: number | null;
          reason?: string;
          performed_by?: string | null;
          related_entity_type?: string | null;
          related_entity_id?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      sequences: {
        // Cadências de outreach. `steps` é jsonb array (SequenceStep[]).
        Row: {
          id: string;
          workspace_id: string;
          name: string;
          status: SequenceStatus;
          steps: Json;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          name: string;
          status?: SequenceStatus;
          steps?: Json;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          name?: string;
          status?: SequenceStatus;
          steps?: Json;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      sequence_enrollments: {
        // Cada par (sequence, contact). Worker BullMQ poll next_action_at.
        // Coluna canónica é `enrollment` (US spelling) — não tocar.
        Row: {
          id: string;
          sequence_id: string;
          contact_id: string;
          workspace_id: string;
          current_step: number;
          status: EnrollmentStatus;
          enrolled_at: string;
          next_action_at: string | null;
          completed_at: string | null;
        };
        Insert: {
          id?: string;
          sequence_id: string;
          contact_id: string;
          workspace_id: string;
          current_step?: number;
          status?: EnrollmentStatus;
          enrolled_at?: string;
          next_action_at?: string | null;
          completed_at?: string | null;
        };
        Update: {
          id?: string;
          sequence_id?: string;
          contact_id?: string;
          workspace_id?: string;
          current_step?: number;
          status?: EnrollmentStatus;
          enrolled_at?: string;
          next_action_at?: string | null;
          completed_at?: string | null;
        };
        Relationships: [];
      };
      companies: {
        // Catálogo de empresas (público se workspace_id IS NULL, privado caso
        // contrário). Stub manual — regenerar via `supabase gen types`.
        Row: {
          id: string;
          workspace_id: string | null;
          name: string;
          nif: string | null;
          sector: CompanySector | null;
          provincia: AngolaProvincia | null;
          size: CompanySize | null;
          website: string | null;
          description: string | null;
          logo_url: string | null;
          source: CompanySource | null;
          source_url: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id?: string | null;
          name: string;
          nif?: string | null;
          sector?: CompanySector | null;
          provincia?: AngolaProvincia | null;
          size?: CompanySize | null;
          website?: string | null;
          description?: string | null;
          logo_url?: string | null;
          source?: CompanySource | null;
          source_url?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string | null;
          name?: string;
          nif?: string | null;
          sector?: CompanySector | null;
          provincia?: AngolaProvincia | null;
          size?: CompanySize | null;
          website?: string | null;
          description?: string | null;
          logo_url?: string | null;
          source?: CompanySource | null;
          source_url?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      contacts: {
        // Pessoas dentro das empresas. Mesma regra de visibilidade que
        // companies (workspace_id NULL = público).
        Row: {
          id: string;
          company_id: string;
          workspace_id: string | null;
          full_name: string;
          title: string | null;
          email: string | null;
          phone: string | null;
          linkedin_url: string | null;
          confidence_score: number | null;
          email_verified: boolean;
          source: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          company_id: string;
          workspace_id?: string | null;
          full_name: string;
          title?: string | null;
          email?: string | null;
          phone?: string | null;
          linkedin_url?: string | null;
          confidence_score?: number | null;
          email_verified?: boolean;
          source?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          company_id?: string;
          workspace_id?: string | null;
          full_name?: string;
          title?: string | null;
          email?: string | null;
          phone?: string | null;
          linkedin_url?: string | null;
          confidence_score?: number | null;
          email_verified?: boolean;
          source?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      revealed_contacts: {
        // Append-only — regista quando o workspace pagou para revelar um
        // contacto público. UNIQUE(workspace_id, contact_id) garante
        // idempotência.
        Row: {
          id: string;
          workspace_id: string;
          contact_id: string;
          revealed_at: string;
          performed_by: string | null;
          credits_log_id: string | null;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          contact_id: string;
          revealed_at?: string;
          performed_by?: string | null;
          credits_log_id?: string | null;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          contact_id?: string;
          revealed_at?: string;
          performed_by?: string | null;
          credits_log_id?: string | null;
        };
        Relationships: [];
      };
      email_events: {
        // Append-only. Coluna canónica é `enrollment_id` (US spelling).
        Row: {
          id: string;
          enrollment_id: string;
          workspace_id: string;
          event_type: EmailEventType;
          metadata: Json;
          occurred_at: string;
        };
        Insert: {
          id?: string;
          enrollment_id: string;
          workspace_id: string;
          event_type: EmailEventType;
          metadata?: Json;
          occurred_at?: string;
        };
        Update: {
          id?: string;
          enrollment_id?: string;
          workspace_id?: string;
          event_type?: EmailEventType;
          metadata?: Json;
          occurred_at?: string;
        };
        Relationships: [];
      };
      deal_stages: {
        // Stages do pipeline CRM (M3.3 — migration 0010). `workspace_id` NULL
        // = stage de sistema (visível a todos os workspaces; não editável via
        // API). 7 seeds: Novo, Contactado, Qualificado, Proposta, Negociação,
        // Fechado-ganho (is_won), Fechado-perdido (is_lost).
        Row: {
          id: string;
          workspace_id: string | null;
          name: string;
          position: number;
          color: string;
          is_won: boolean;
          is_lost: boolean;
          is_system: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          workspace_id?: string | null;
          name: string;
          position: number;
          color?: string;
          is_won?: boolean;
          is_lost?: boolean;
          is_system?: boolean;
          created_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string | null;
          name?: string;
          position?: number;
          color?: string;
          is_won?: boolean;
          is_lost?: boolean;
          is_system?: boolean;
          created_at?: string;
        };
        Relationships: [];
      };
      deals: {
        // CRM deals (M3.3 — migration 0010). UNIQUE(workspace_id, contact_id)
        // — um contacto só pode ter um deal aberto por workspace.
        // Trigger `handle_email_reply_create_deal` cria deal automático em
        // "Contactado" quando email_event 'replied' chega.
        Row: {
          id: string;
          workspace_id: string;
          stage_id: string;
          contact_id: string;
          company_id: string | null;
          owner_id: string | null;
          value_akz: number | null;
          expected_close_date: string | null;
          status: DealStatus;
          source: DealSource;
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          stage_id: string;
          contact_id: string;
          company_id?: string | null;
          owner_id?: string | null;
          value_akz?: number | null;
          expected_close_date?: string | null;
          status?: DealStatus;
          source?: DealSource;
          notes?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          stage_id?: string;
          contact_id?: string;
          company_id?: string | null;
          owner_id?: string | null;
          value_akz?: number | null;
          expected_close_date?: string | null;
          status?: DealStatus;
          source?: DealSource;
          notes?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      email_templates: {
        // Templates de email (M3.2 — migration 0009). `workspace_id` NULL =
        // template de sistema (visível a todos os workspaces). `variables`
        // é populado por trigger SQL (extrai `{{var}}` de subject+body).
        // `is_system` é apenas editável via service_role.
        Row: {
          id: string;
          workspace_id: string | null;
          name: string;
          category: EmailTemplateCategory;
          subject: string;
          body: string;
          language: EmailTemplateLanguage;
          is_system: boolean;
          variables: Json;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id?: string | null;
          name: string;
          category: EmailTemplateCategory;
          subject: string;
          body: string;
          language?: EmailTemplateLanguage;
          is_system?: boolean;
          variables?: Json;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string | null;
          name?: string;
          category?: EmailTemplateCategory;
          subject?: string;
          body?: string;
          language?: EmailTemplateLanguage;
          is_system?: boolean;
          variables?: Json;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      create_workspace_with_owner: {
        Args: { p_name: string; p_slug: string };
        Returns: {
          id: string;
          name: string;
          slug: string;
          plan: WorkspacePlan;
          credits_remaining: number;
          owner_id: string;
          created_at: string;
          updated_at: string;
        }[];
      };
      add_credits: {
        // Atómica — actualiza workspaces.credits_remaining e devolve
        // balance_after. Insere row em credits_log para auditoria.
        // GRANT execute apenas a service_role.
        Args: {
          workspace_id: string;
          amount: number;
          reason: string;
          performed_by?: string | null;
          related_entity_type?: string | null;
          related_entity_id?: string | null;
        };
        Returns: number;
      };
      credits_for_plan: {
        // Devolve quantos créditos um plano atribui por ciclo.
        // starter=500, growth=2000, pro=999999.
        Args: { p_plan: string };
        Returns: number;
      };
      enrol_contacts_into_sequence: {
        // RPC do M2.3 — enrol em batch (máx 500), debita créditos upfront.
        // SQLSTATE P0001 = insufficient_credits, 22023 = validação, 42501 = auth.
        Args: { p_sequence_id: string; p_contact_ids: string[] };
        Returns: {
          enrolled_count: number;
          skipped_count: number;
          credits_debited: number;
          new_balance: number;
        }[];
      };
      pause_enrolments: {
        // Pausa enrolments (active → paused). Devolve nº de rows afectadas.
        Args: { p_enrolment_ids: string[] };
        Returns: number;
      };
      unenrol: {
        // Marca enrolments como completed (mantém histórico para analytics).
        // Não devolve créditos. Devolve nº de rows afectadas.
        Args: { p_enrolment_ids: string[] };
        Returns: number;
      };
      reveal_contacts: {
        // RPC do M3.1 — revela contactos públicos para o workspace.
        // Idempotente (UNIQUE(workspace_id, contact_id)). Limite 200/call.
        // SQLSTATE P0001 = insufficient_credits, 22023 = validação, 42501 = auth.
        Args: { p_workspace_id: string; p_contact_ids: string[] };
        Returns: {
          revealed_count: number;
          already_revealed_count: number;
          credits_debited: number;
          new_balance: number;
        }[];
      };
      is_contact_revealed: {
        // Helper estável: TRUE se o contacto já foi revelado pelo workspace.
        Args: { p_workspace_id: string; p_contact_id: string };
        Returns: boolean;
      };
      move_deal_to_stage: {
        // RPC do M3.3 — actualiza stage_id de um deal + ajusta status
        // (open/won/lost) conforme is_won/is_lost do stage de destino.
        // SECURITY DEFINER + verifica membership.
        Args: { p_deal_id: string; p_stage_id: string };
        Returns: {
          id: string;
          stage_id: string;
          status: DealStatus;
          updated_at: string;
        }[];
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
