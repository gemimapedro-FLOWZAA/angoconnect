import { resolveMx } from 'dns/promises';
import { Socket, isIP } from 'net';
import { randomBytes } from 'crypto';
import { logger } from './utils/logger.js';

// ============================================================================
// SMTP VERIFY — handshake parcial até RCPT TO. Sem DATA, sem envio de mensagem.
// ============================================================================

export type SmtpResultCode =
    | 'ok'              // 250 OK no RCPT TO
    | 'invalid'         // 550 / 551 / 553 / 554 → email não existe
    | 'greylist'        // 4xx → retry uma vez
    | 'catch_all'       // domínio aceita tudo (detectado com xyz random)
    | 'timeout'         // não respondeu dentro do timeout
    | 'connect_error'   // falha TCP ou MX
    | 'rejected_helo'   // servidor recusou HELO/MAIL FROM
    | 'unknown';        // resposta indeterminada

export interface SmtpResult {
    code: SmtpResultCode;
    response: string;       // resposta SMTP crua (ou erro)
    mxHost?: string;
}

export interface SmtpVerifyOptions {
    mxHost: string;
    email: string;
    fromAddress: string;
    helloHostname: string;
    timeoutMs: number;
}

const SMTP_PORT = 25;
const CRLF = '\r\n';

/**
 * Lê linhas SMTP do socket até a próxima resposta multilinha terminar.
 * Resposta SMTP multilinha: "250-foo\r\n250-bar\r\n250 done\r\n"
 *
 * Resolve com a string completa (todas as linhas concatenadas).
 * Rejeita se o socket fechar antes ou se timeout disparar.
 */
function readReply(socket: Socket, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        let buffer = '';
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error('TIMEOUT'));
        }, timeoutMs);

        const onData = (chunk: Buffer): void => {
            buffer += chunk.toString('utf8');
            // Última linha de resposta SMTP é "DDD " (espaço, não traço).
            // Procuramos por nova linha que comece com 3 dígitos + espaço.
            if (/(^|\r\n)\d{3} [^\r\n]*\r?\n?$/.test(buffer)) {
                cleanup();
                resolve(buffer.trim());
            }
        };
        const onError = (err: Error): void => {
            cleanup();
            reject(err);
        };
        const onClose = (): void => {
            cleanup();
            if (buffer.length > 0) resolve(buffer.trim());
            else reject(new Error('SOCKET_CLOSED'));
        };

        function cleanup(): void {
            clearTimeout(timer);
            socket.off('data', onData);
            socket.off('error', onError);
            socket.off('close', onClose);
        }

        socket.on('data', onData);
        socket.on('error', onError);
        socket.on('close', onClose);
    });
}

function writeLine(socket: Socket, line: string): void {
    socket.write(`${line}${CRLF}`);
}

/**
 * Faz o handshake SMTP mínimo: conecta → 220 → EHLO → MAIL FROM → RCPT TO → QUIT.
 * Devolve a categoria da resposta ao RCPT TO.
 */
async function smtpHandshake(opts: SmtpVerifyOptions): Promise<SmtpResult> {
    const { mxHost, email, fromAddress, helloHostname, timeoutMs } = opts;

    return new Promise<SmtpResult>((resolve) => {
        const socket = new Socket();
        let settled = false;
        let overallTimer: NodeJS.Timeout | undefined;

        const finish = (result: SmtpResult): void => {
            if (settled) return;
            settled = true;
            if (overallTimer) clearTimeout(overallTimer);
            try { socket.destroy(); } catch { /* noop */ }
            resolve({ ...result, mxHost });
        };

        overallTimer = setTimeout(() => {
            finish({ code: 'timeout', response: 'TIMEOUT' });
        }, timeoutMs * 3); // budget total = 3x por step

        socket.setTimeout(timeoutMs);
        socket.once('timeout', () => {
            finish({ code: 'timeout', response: 'SOCKET_TIMEOUT' });
        });
        socket.once('error', (err) => {
            finish({ code: 'connect_error', response: err.message });
        });

        socket.connect(SMTP_PORT, mxHost, async () => {
            try {
                // 220 banner
                const banner = await readReply(socket, timeoutMs);
                if (!banner.startsWith('220')) {
                    finish({ code: 'connect_error', response: banner });
                    return;
                }

                writeLine(socket, `EHLO ${helloHostname}`);
                const ehlo = await readReply(socket, timeoutMs);
                if (!ehlo.startsWith('250')) {
                    // Fallback HELO
                    writeLine(socket, `HELO ${helloHostname}`);
                    const helo = await readReply(socket, timeoutMs);
                    if (!helo.startsWith('250')) {
                        finish({ code: 'rejected_helo', response: helo });
                        return;
                    }
                }

                writeLine(socket, `MAIL FROM:<${fromAddress}>`);
                const mailFrom = await readReply(socket, timeoutMs);
                if (!mailFrom.startsWith('250')) {
                    finish({ code: 'rejected_helo', response: mailFrom });
                    return;
                }

                writeLine(socket, `RCPT TO:<${email}>`);
                const rcpt = await readReply(socket, timeoutMs);

                writeLine(socket, 'QUIT');

                if (rcpt.startsWith('250') || rcpt.startsWith('251')) {
                    finish({ code: 'ok', response: rcpt });
                    return;
                }
                if (/^(550|551|553|554)/.test(rcpt)) {
                    finish({ code: 'invalid', response: rcpt });
                    return;
                }
                if (/^4\d{2}/.test(rcpt)) {
                    finish({ code: 'greylist', response: rcpt });
                    return;
                }
                finish({ code: 'unknown', response: rcpt });
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (message === 'TIMEOUT' || message === 'SOCKET_TIMEOUT') {
                    finish({ code: 'timeout', response: message });
                } else {
                    finish({ code: 'connect_error', response: message });
                }
            }
        });
    });
}

// ============================================================================
// MX lookup com cache por domínio (uma única lookup por run/domínio).
// ============================================================================

const mxCache = new Map<string, string[] | null>();

/**
 * Resolve registos MX e devolve hostnames ordenados por prioridade.
 * Cache local — uma lookup por domínio por run.
 */
export async function resolveMxRecords(domain: string): Promise<string[] | null> {
    if (mxCache.has(domain)) return mxCache.get(domain) ?? null;
    try {
        const records = await resolveMx(domain);
        if (!records || records.length === 0) {
            mxCache.set(domain, null);
            return null;
        }
        const sorted = records
            .slice()
            .sort((a, b) => a.priority - b.priority)
            .map((r) => r.exchange)
            .filter((host): host is string => typeof host === 'string' && host.length > 0);
        mxCache.set(domain, sorted);
        return sorted;
    } catch (err) {
        logger.warn('SMTP', 'MX lookup failed', {
            domain,
            error: err instanceof Error ? err.message : String(err),
        });
        mxCache.set(domain, null);
        return null;
    }
}

// ============================================================================
// Rate limiter por domínio (max N conexões SMTP / segundo)
// Implementação simples por janela deslizante.
// ============================================================================

const domainTimestamps = new Map<string, number[]>();

async function waitForSlot(domain: string, maxPerSecond: number): Promise<void> {
    if (maxPerSecond <= 0) return;
    const now = Date.now();
    const list = domainTimestamps.get(domain) ?? [];
    // Limpa entries com mais de 1s
    const recent = list.filter((t) => now - t < 1000);
    if (recent.length >= maxPerSecond) {
        const oldest = recent[0];
        if (oldest !== undefined) {
            const waitMs = 1000 - (now - oldest) + 50;
            if (waitMs > 0) {
                await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
            }
        }
    }
    const updated = recent.filter((t) => Date.now() - t < 1000);
    updated.push(Date.now());
    domainTimestamps.set(domain, updated);
}

// ============================================================================
// API pública
// ============================================================================

export interface VerifyEmailParams {
    email: string;
    domain: string;
    mxHosts: string[];
    fromAddress: string;
    helloHostname: string;
    timeoutMs: number;
    requestsPerSecondPerDomain: number;
}

/**
 * Verifica um único email contra a lista de MX hosts (primeiro com sucesso ganha).
 * Aplica rate limit por domínio. Em greylist (4xx) retry UMA vez após 30s.
 */
export async function verifyEmail(params: VerifyEmailParams): Promise<SmtpResult> {
    const {
        email, domain, mxHosts, fromAddress, helloHostname,
        timeoutMs, requestsPerSecondPerDomain,
    } = params;

    if (mxHosts.length === 0) {
        return { code: 'connect_error', response: 'NO_MX_RECORDS' };
    }

    let lastResult: SmtpResult = { code: 'connect_error', response: 'NO_ATTEMPT' };

    for (const mxHost of mxHosts) {
        // Skip mx hosts inválidos (alguns DNS devolvem "." ou IPs malformados)
        if (!mxHost || mxHost === '.' || (isIP(mxHost) === 0 && !mxHost.includes('.'))) {
            continue;
        }
        await waitForSlot(domain, requestsPerSecondPerDomain);
        const result = await smtpHandshake({
            mxHost, email, fromAddress, helloHostname, timeoutMs,
        });
        lastResult = result;
        if (result.code === 'ok' || result.code === 'invalid') {
            return result;
        }
        if (result.code === 'greylist') {
            logger.debug('SMTP', 'Greylist — retrying after 30s', { mxHost, email });
            await new Promise<void>((resolve) => setTimeout(resolve, 30_000));
            await waitForSlot(domain, requestsPerSecondPerDomain);
            const retry = await smtpHandshake({
                mxHost, email, fromAddress, helloHostname, timeoutMs,
            });
            if (retry.code === 'ok' || retry.code === 'invalid') return retry;
            lastResult = retry;
        }
        // Senão tenta o próximo MX
    }
    return lastResult;
}

// ============================================================================
// Catch-all detection (cache por domínio)
// ============================================================================

const catchAllCache = new Map<string, boolean>();

/**
 * Detecta domínios catch-all: envia RCPT TO para um endereço random.
 * Se aceitar (250), marca o domínio como catch-all.
 *
 * O resultado é cacheado — uma única verificação por domínio por run.
 */
export async function isCatchAllDomain(params: {
    domain: string;
    mxHosts: string[];
    fromAddress: string;
    helloHostname: string;
    timeoutMs: number;
    requestsPerSecondPerDomain: number;
}): Promise<boolean> {
    const { domain } = params;
    const cached = catchAllCache.get(domain);
    if (cached !== undefined) return cached;

    const random = `verify-${randomBytes(8).toString('hex')}@${domain}`;
    const result = await verifyEmail({
        ...params,
        email: random,
    });
    const isCatchAll = result.code === 'ok';
    catchAllCache.set(domain, isCatchAll);
    if (isCatchAll) {
        logger.warn('SMTP', 'Catch-all domain detected', { domain });
    }
    return isCatchAll;
}
