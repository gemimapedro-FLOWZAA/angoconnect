/**
 * AngoConnect — Testes unitários do job processor send-email (M4.1)
 *
 * Validamos os dois invariantes mais importantes:
 *   1. Render de placeholders {{first_name}} no subject/body antes do envio.
 *   2. Idempotência: skip se current_step !== stepIndex.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';

// ---------------------------------------------------------------------------
// Mock controlável do Supabase admin client
// ---------------------------------------------------------------------------

interface FetchSpec {
  // Cada tabela tem uma queue de respostas para `.maybeSingle()`.
  enrolments: Array<{ data: unknown; error: { message: string } | null }>;
  sequences: Array<{ data: unknown; error: { message: string } | null }>;
  contacts: Array<{ data: unknown; error: { message: string } | null }>;
  companies: Array<{ data: unknown; error: { message: string } | null }>;
  workspaces: Array<{ data: unknown; error: { message: string } | null }>;
}

const updateCalls = {
  sequence_enrollments: vi.fn(),
};
const insertCalls = {
  email_events: vi.fn((_payload: unknown) => ({ error: null })),
};

const fetchSpec: FetchSpec = {
  enrolments: [],
  sequences: [],
  contacts: [],
  companies: [],
  workspaces: [],
};

function buildSelectChain(table: string) {
  const tableKey =
    table === 'sequence_enrollments'
      ? 'enrolments'
      : (table as keyof FetchSpec);
  const next = () => {
    const queue = (fetchSpec[tableKey as keyof FetchSpec] ?? []) as Array<{
      data: unknown;
      error: { message: string } | null;
    }>;
    return queue.shift() ?? { data: null, error: null };
  };
  return {
    eq() {
      return this;
    },
    async maybeSingle() {
      return next();
    },
  };
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from(table: string) {
      return {
        select() {
          return buildSelectChain(table);
        },
        update(payload: unknown) {
          if (table === 'sequence_enrollments') {
            updateCalls.sequence_enrollments(payload);
          }
          return {
            eq() {
              return Promise.resolve({ error: null });
            },
          };
        },
        insert(payload: unknown) {
          if (table === 'email_events') {
            insertCalls.email_events(payload);
            return Promise.resolve({ error: null });
          }
          return Promise.resolve({ error: null });
        },
      };
    },
  }),
}));

// ---------------------------------------------------------------------------
// Mock do Resend wrapper
// ---------------------------------------------------------------------------

const sendOutreachEmailMock = vi.fn();
vi.mock('@/lib/email/resend', () => ({
  sendOutreachEmail: (input: unknown) => sendOutreachEmailMock(input),
}));

// ---------------------------------------------------------------------------
// Import depois dos mocks
// ---------------------------------------------------------------------------

import { processSendEmail } from './send-email';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(stepIndex = 0): Job<{ enrolmentId: string; stepIndex: number }> {
  return {
    id: 'job_1',
    data: { enrolmentId: 'enr_1', stepIndex },
  } as unknown as Job<{ enrolmentId: string; stepIndex: number }>;
}

function resetSpec(): void {
  fetchSpec.enrolments = [];
  fetchSpec.sequences = [];
  fetchSpec.contacts = [];
  fetchSpec.companies = [];
  fetchSpec.workspaces = [];
  updateCalls.sequence_enrollments.mockClear();
  insertCalls.email_events.mockClear();
  sendOutreachEmailMock.mockReset();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetSpec();
});

describe('processSendEmail', () => {
  it('substitui placeholders {{first_name}} e {{company_name}} no subject/body antes de enviar', async () => {
    fetchSpec.enrolments.push({
      data: {
        id: 'enr_1',
        sequence_id: 'seq_1',
        contact_id: 'ct_1',
        workspace_id: 'ws_1',
        current_step: 0,
        status: 'active',
      },
      error: null,
    });
    fetchSpec.sequences.push({
      data: {
        id: 'seq_1',
        steps: [
          {
            day_offset: 0,
            channel: 'email',
            subject: 'Olá {{first_name}}',
            body: 'Da {{company_name}}, com gosto.',
          },
          {
            day_offset: 3,
            channel: 'email',
            subject: 'Segundo {{first_name}}',
            body: 'follow-up',
          },
        ],
      },
      error: null,
    });
    fetchSpec.contacts.push({
      data: {
        id: 'ct_1',
        name: 'João Silva',
        title: 'Director',
        email: 'joao@sonangol.ao',
        company_id: 'co_1',
      },
      error: null,
    });
    fetchSpec.companies.push({
      data: { id: 'co_1', name: 'Sonangol' },
      error: null,
    });
    fetchSpec.workspaces.push({
      data: { id: 'ws_1', name: 'AngoConnect Demo' },
      error: null,
    });

    sendOutreachEmailMock.mockResolvedValueOnce({
      ok: true,
      resendId: 're_abc',
    });

    const result = await processSendEmail(makeJob(0));

    expect(result.status).toBe('sent');
    expect(sendOutreachEmailMock).toHaveBeenCalledTimes(1);
    const callArg = sendOutreachEmailMock.mock.calls[0]?.[0] as {
      to: string;
      subject: string;
      html: string;
    };
    expect(callArg.to).toBe('joao@sonangol.ao');
    expect(callArg.subject).toBe('Olá João');
    expect(callArg.html).toBe('Da Sonangol, com gosto.');
  });

  it('skipa idempotentemente quando current_step !== stepIndex', async () => {
    fetchSpec.enrolments.push({
      data: {
        id: 'enr_1',
        sequence_id: 'seq_1',
        contact_id: 'ct_1',
        workspace_id: 'ws_1',
        current_step: 2, // já avançou
        status: 'active',
      },
      error: null,
    });

    const result = await processSendEmail(makeJob(0));

    expect(result.status).toBe('skipped');
    if (result.status === 'skipped') {
      expect(result.reason).toBe('step_mismatch');
    }
    expect(sendOutreachEmailMock).not.toHaveBeenCalled();
  });
});
