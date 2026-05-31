/**
 * AngoConnect — Wrapper Meta WhatsApp Cloud API (Graph API v20)
 * ===========================================================================
 * Cliente HTTP minimalista para a Meta Cloud API. Mantém-se intencionalmente
 * fino: três operações que cobrem a totalidade do M3.4 (sendTemplate,
 * sendText, submitTemplate).
 *
 * Não dependemos do SDK oficial do Meta — `fetch` cobre tudo e mantém
 * o bundle leve no Vercel.
 *
 * Documentação:
 *   - Mensagens: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
 *   - Templates: https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates
 *
 * Erros: lança `WhatsAppApiError` em qualquer resposta não-2xx. O caller
 * (job processor / endpoint) decide se faz retry ou marca como falha
 * permanente.
 *
 * Janela de 24h: a Meta só permite mensagens freeform (`sendText`) dentro
 * de 24h após a última mensagem do utilizador. Templates são sempre
 * permitidos. A verificação da janela é responsabilidade do caller
 * (ver `lib/queue/jobs/send-whatsapp.ts`).
 */

export const META_API_BASE = 'https://graph.facebook.com/v20.0';

// ---------------------------------------------------------------------------
// Erros tipados
// ---------------------------------------------------------------------------

export class WhatsAppApiError extends Error {
  public readonly status: number;
  public readonly meta: unknown;

  constructor(message: string, status: number, meta: unknown) {
    super(message);
    this.name = 'WhatsAppApiError';
    this.status = status;
    this.meta = meta;
  }
}

// ---------------------------------------------------------------------------
// Tipos públicos
// ---------------------------------------------------------------------------

/**
 * Componente de um envio de template. Cada `parameters` array é específico
 * do tipo do componente — não tipamos o conteúdo aqui (Meta tem dezenas de
 * variantes). O caller é responsável por seguir a doc oficial.
 */
export interface WhatsAppTemplateComponent {
  type: 'header' | 'body' | 'button';
  /**
   * Para `button` é obrigatório indicar `sub_type` e `index`.
   */
  sub_type?: 'quick_reply' | 'url' | 'call';
  index?: number;
  parameters: Array<Record<string, unknown>>;
}

export interface SendTemplateOptions {
  /** Número em formato E.164, ex: '+244912345678' ou '244912345678'. */
  to: string;
  templateName: string;
  /** Ex: 'pt_PT', 'en_US'. */
  languageCode: string;
  components?: WhatsAppTemplateComponent[];
}

export interface SendTextOptions {
  to: string;
  body: string;
}

export interface SubmitTemplateOptions {
  wabaId: string;
  name: string;
  language: string;
  category: 'AUTHENTICATION' | 'MARKETING' | 'UTILITY';
  /**
   * Components definidos pela Meta: HEADER, BODY, FOOTER, BUTTONS.
   * Mantemos como array de objectos plain para não enrijecer a API — a
   * validação é feita pela Meta.
   */
  components: Array<Record<string, unknown>>;
}

export interface MetaSendResponse {
  messaging_product?: 'whatsapp';
  contacts?: Array<{ input: string; wa_id: string }>;
  messages?: Array<{ id: string; message_status?: string }>;
}

export interface MetaSubmitTemplateResponse {
  id: string;
  status: string;
  category?: string;
}

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

/**
 * Normaliza um E.164 para o formato que a Meta aceita em `to` — sem `+`,
 * apenas dígitos. A Meta documenta ambos os formatos como aceites, mas
 * sem `+` é o que retorna nos webhooks de receção, por isso uniformizamos.
 */
function normalisePhoneE164(to: string): string {
  return to.replace(/[^\d]/g, '');
}

async function metaRequest<T>(
  path: string,
  accessToken: string,
  init: { method: 'POST' | 'GET'; body?: unknown }
): Promise<T> {
  const url = `${META_API_BASE}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      // Vercel runtime: garante que não cacha.
      cache: 'no-store',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new WhatsAppApiError(
      `Falha de rede ao chamar Meta: ${message}`,
      0,
      { url, cause: message }
    );
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }

  if (!response.ok) {
    const errMessage =
      (parsed as { error?: { message?: string } } | null)?.error?.message ??
      `Meta API ${response.status}`;
    throw new WhatsAppApiError(errMessage, response.status, parsed);
  }

  return parsed as T;
}

// ---------------------------------------------------------------------------
// WhatsAppClient
// ---------------------------------------------------------------------------

export class WhatsAppClient {
  constructor(
    private readonly accessToken: string,
    private readonly phoneNumberId: string
  ) {
    if (!accessToken) {
      throw new Error('WhatsAppClient: accessToken vazio');
    }
    if (!phoneNumberId) {
      throw new Error('WhatsAppClient: phoneNumberId vazio');
    }
  }

  /**
   * Envia uma mensagem baseada em template aprovado.
   * Retorna `{ messageId }` (wamid retornado pela Meta).
   */
  async sendTemplate(
    opts: SendTemplateOptions
  ): Promise<{ messageId: string }> {
    const to = normalisePhoneE164(opts.to);
    const body: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name: opts.templateName,
        language: { code: opts.languageCode },
        ...(opts.components && opts.components.length > 0
          ? { components: opts.components }
          : {}),
      },
    };

    const response = await metaRequest<MetaSendResponse>(
      `/${this.phoneNumberId}/messages`,
      this.accessToken,
      { method: 'POST', body }
    );

    const messageId = response.messages?.[0]?.id;
    if (!messageId) {
      throw new WhatsAppApiError(
        'Meta respondeu sem messages[0].id',
        200,
        response
      );
    }
    return { messageId };
  }

  /**
   * Envia mensagem de texto livre. Só é permitido dentro da janela de 24h
   * após a última mensagem RECEBIDA do contacto. O caller é responsável
   * pela verificação dessa janela.
   */
  async sendText(opts: SendTextOptions): Promise<{ messageId: string }> {
    const to = normalisePhoneE164(opts.to);
    const body: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: opts.body, preview_url: false },
    };

    const response = await metaRequest<MetaSendResponse>(
      `/${this.phoneNumberId}/messages`,
      this.accessToken,
      { method: 'POST', body }
    );

    const messageId = response.messages?.[0]?.id;
    if (!messageId) {
      throw new WhatsAppApiError(
        'Meta respondeu sem messages[0].id',
        200,
        response
      );
    }
    return { messageId };
  }

  /**
   * Submete um template para revisão na Meta. Retorna `{ id, status }` —
   * `id` é o template_id da Meta (`meta_template_id` na nossa tabela).
   * `status` começa quase sempre como 'PENDING'.
   */
  async submitTemplate(
    opts: SubmitTemplateOptions
  ): Promise<{ id: string; status: string }> {
    const body: Record<string, unknown> = {
      name: opts.name,
      language: opts.language,
      category: opts.category,
      components: opts.components,
    };

    const response = await metaRequest<MetaSubmitTemplateResponse>(
      `/${opts.wabaId}/message_templates`,
      this.accessToken,
      { method: 'POST', body }
    );

    return { id: response.id, status: response.status ?? 'PENDING' };
  }
}
