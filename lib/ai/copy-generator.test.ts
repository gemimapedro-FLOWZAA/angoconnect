/**
 * AngoConnect — Testes unitários do gerador de copy via Claude (M4.1)
 *
 * Mock total do SDK Anthropic. Nenhuma chamada à API real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock controlável do SDK Anthropic
// ---------------------------------------------------------------------------

const messagesCreateMock = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  // O default export é a classe Anthropic. O construtor devolve um objecto
  // com `.messages.create`.
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: { create: messagesCreateMock },
    })),
  };
});

// Import depois do mock para usar a versão mockada.
import {
  AiParseError,
  generateOutreachCopy,
} from './copy-generator';

beforeEach(() => {
  // Garante que existe a API key para que `getClient()` não rebente.
  process.env.ANTHROPIC_API_KEY = 'sk-ant-dummy';
  messagesCreateMock.mockReset();
});

afterEach(() => {
  messagesCreateMock.mockReset();
});

describe('generateOutreachCopy', () => {
  it('faz parse de JSON simples e devolve variantes', async () => {
    messagesCreateMock.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            variants: [
              { subject: 'Olá', body: 'Bom dia, gostaríamos de apresentar.' },
            ],
          }),
        },
      ],
    });

    const variants = await generateOutreachCopy({
      channel: 'email',
      context: { companyName: 'Sonangol', sequenceGoal: 'agendar reunião' },
    });

    expect(variants).toHaveLength(1);
    expect(variants[0]).toEqual({
      subject: 'Olá',
      body: 'Bom dia, gostaríamos de apresentar.',
    });
  });

  it('limpa fences ```json ... ``` antes do parse', async () => {
    messagesCreateMock.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text:
            '```json\n' +
            JSON.stringify({
              variants: [{ subject: 'Sub', body: 'Body' }],
            }) +
            '\n```',
        },
      ],
    });

    const variants = await generateOutreachCopy({
      channel: 'email',
      context: { companyName: 'X', sequenceGoal: 'goal' },
    });

    expect(variants).toEqual([{ subject: 'Sub', body: 'Body' }]);
  });

  it('lança AiParseError quando o JSON é inválido', async () => {
    messagesCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'not-json-at-all {{{' }],
    });

    await expect(
      generateOutreachCopy({
        channel: 'email',
        context: { companyName: 'X', sequenceGoal: 'goal' },
      })
    ).rejects.toBeInstanceOf(AiParseError);
  });

  it('omite subject quando o canal é whatsapp, mesmo se o Claude devolver', async () => {
    messagesCreateMock.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            variants: [
              {
                subject: 'NÃO DEVIA APARECER',
                body: 'Olá, mensagem WhatsApp curta.',
              },
            ],
          }),
        },
      ],
    });

    const variants = await generateOutreachCopy({
      channel: 'whatsapp',
      context: { companyName: 'X', sequenceGoal: 'follow up' },
    });

    expect(variants).toHaveLength(1);
    const v = variants[0];
    expect(v).toBeDefined();
    expect(v?.body).toContain('WhatsApp');
    expect(v).not.toHaveProperty('subject');
  });
});
