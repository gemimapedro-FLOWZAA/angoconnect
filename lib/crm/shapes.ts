// AngoConnect — Shapes partilhados de CRM (M3.3)
// ===========================================================================
// Constantes e tipos partilhados entre os route handlers de `deals` e
// `deal-stages`. Vivem fora dos `route.ts` porque o Next.js só permite
// exportar os HTTP method handlers + options conhecidas (`runtime`,
// `dynamic`, etc.); qualquer outro export falha o build de produção.

export interface DealStageRow {
  id: string;
  workspace_id: string | null;
  name: string;
  position: number;
  color: string;
  is_won: boolean;
  is_lost: boolean;
  is_system: boolean;
  created_at: string;
}

export const STAGE_SELECT =
  'id, workspace_id, name, position, color, is_won, is_lost, is_system, created_at';

export interface DealNested {
  id: string;
  workspace_id: string;
  stage_id: string;
  contact_id: string;
  company_id: string | null;
  owner_id: string | null;
  value_akz: number | null;
  expected_close_date: string | null;
  status: 'open' | 'won' | 'lost';
  source: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
  contact: {
    id: string;
    full_name: string | null;
    title: string | null;
    email: string | null;
    phone: string | null;
  } | null;
  company: {
    id: string;
    name: string;
    sector: string | null;
    provincia: string | null;
  } | null;
  owner: {
    id: string;
    full_name: string | null;
    email: string;
  } | null;
}

export const DEAL_SELECT = `
  id, workspace_id, stage_id, contact_id, company_id, owner_id,
  value_akz, expected_close_date, status, source, notes,
  created_at, updated_at,
  contact:contacts!contact_id(id, full_name, title, email, phone),
  company:companies!company_id(id, name, sector, provincia),
  owner:profiles!owner_id(id, full_name, email)
`;
