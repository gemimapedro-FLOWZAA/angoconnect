/**
 * AngoConnect — Cliente HTTP Apify (camada de transporte)
 * ---------------------------------------------------------------------------
 * Wrapper mínimo sobre a Apify REST API v2. Usa `fetch` nativo (Next.js
 * runtime) com suporte a:
 *   - Bearer token autenticado via `APIFY_TOKEN`
 *   - Timeout configurável via `AbortController`
 *   - AbortSignal externo (compõe-se com o timeout interno)
 *   - Erros tipados (`ApifyClientError`, `ApifyTimeoutError`)
 *
 * Reference: https://docs.apify.com/api/v2
 */

const APIFY_BASE_URL = 'https://api.apify.com/v2';

/** Erro tipado lançado quando a Apify API responde com !ok. */
export class ApifyClientError extends Error {
  public readonly status: number;
  public readonly responseBody: string | undefined;

  constructor(message: string, status: number, responseBody?: string) {
    super(message);
    this.name = 'ApifyClientError';
    this.status = status;
    this.responseBody = responseBody;
  }
}

/** Erro tipado para timeout do fetch (AbortController). */
export class ApifyTimeoutError extends Error {
  constructor(message = 'Apify request timed out') {
    super(message);
    this.name = 'ApifyTimeoutError';
  }
}

export interface ApifyRequestOptions {
  /** Timeout em ms para a chamada. Default 30s. */
  timeoutMs?: number;
  /** AbortSignal externo (combina-se com o timeout interno). */
  externalSignal?: AbortSignal;
  /** Query params adicionais (passados via URLSearchParams). */
  query?: Record<string, string>;
}

/**
 * Executa um GET autenticado contra a Apify API e devolve o corpo JSON.
 * Quem chama tipa o retorno (`<T>`) ou valida com Zod.
 */
export async function apifyGet<T = unknown>(
  path: string,
  options: ApifyRequestOptions = {}
): Promise<T> {
  return apifyRequest<T>('GET', path, undefined, options);
}

/**
 * Executa um POST autenticado contra a Apify API.
 * Usado para disparar Actor runs (`/v2/acts/{actorId}/runs`).
 *
 * Quem chama tipa o retorno (`<T>`) ou valida com Zod.
 */
export async function apifyPost<T = unknown>(
  path: string,
  body: unknown,
  options: ApifyRequestOptions = {}
): Promise<T> {
  return apifyRequest<T>('POST', path, body, options);
}

/**
 * Implementação partilhada entre GET/POST. Centraliza autenticação, timeout,
 * propagação de AbortSignal externo e tratamento uniforme de erros.
 */
async function apifyRequest<T = unknown>(
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  options: ApifyRequestOptions
): Promise<T> {
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    throw new ApifyClientError('APIFY_TOKEN env var não definida', 500);
  }

  const { timeoutMs = 30_000, externalSignal, query } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  // Propaga aborts do signal externo para o nosso controller.
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const queryString = query ? `?${new URLSearchParams(query).toString()}` : '';
  const url = `${APIFY_BASE_URL}${normalizedPath}${queryString}`;

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(url, {
      method,
      headers,
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      signal: controller.signal,
      // Evita cache do Next em runtimes que envelopam fetch.
      cache: 'no-store',
    });

    if (!response.ok) {
      const responseBody = await response.text().catch(() => undefined);
      throw new ApifyClientError(
        `Apify request falhou (${response.status}) em ${normalizedPath}`,
        response.status,
        responseBody
      );
    }

    return (await response.json()) as T;
  } catch (err) {
    if (err instanceof ApifyClientError) throw err;
    if (
      (err as { name?: string } | null)?.name === 'AbortError' ||
      controller.signal.aborted
    ) {
      throw new ApifyTimeoutError(
        `Apify request excedeu ${timeoutMs}ms em ${normalizedPath}`
      );
    }
    throw new ApifyClientError(
      `Erro inesperado no Apify request: ${(err as Error).message}`,
      500
    );
  } finally {
    clearTimeout(timeoutId);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}
