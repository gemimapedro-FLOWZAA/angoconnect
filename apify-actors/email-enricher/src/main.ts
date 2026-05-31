import { Actor } from 'apify';
import {
    VALID_PROVINCIAS,
    VALID_SECTORS,
    VALID_ROLES,
    extractDomain,
    normalizeWebsite,
    isValidEmailFormat,
    type EnrichedContact,
    type EnrichedDatasetItem,
    type Provincia,
    type Sector,
    type ContactRole,
} from './normalize.js';
import { generateCandidates, type PatternId } from './patterns.js';
import {
    resolveMxRecords,
    verifyEmail,
    isCatchAllDomain,
    type SmtpResult,
} from './smtp.js';
import { logger } from './utils/logger.js';

// ============================================================================
// INPUT TYPES
// ============================================================================

interface InputContact {
    full_name?: string;
    title?: string;
    phone?: string;
    linkedin_url?: string;
    role?: string;
}

interface InputCompany {
    name?: string;
    nif?: string | null;
    provincia?: string;
    sector?: string | null;
    website?: string | null;
    contacts?: InputContact[];
}

interface ActorInput {
    companies?: InputCompany[];
    smtpVerify?: boolean;
    maxPatternsPerContact?: number;
    timeoutMsPerSmtp?: number;
    smtpFromAddress?: string;
    smtpHelloHostname?: string;
    requestsPerSecondPerDomain?: number;
}

interface ParsedInput {
    companies: InputCompany[];
    smtpVerify: boolean;
    maxPatternsPerContact: number;
    timeoutMsPerSmtp: number;
    smtpFromAddress: string;
    smtpHelloHostname: string;
    requestsPerSecondPerDomain: number;
}

// ============================================================================
// PARSE INPUT
// ============================================================================

function parseInput(input: ActorInput | null): ParsedInput {
    const companies = Array.isArray(input?.companies) ? input!.companies : [];
    if (companies.length === 0) {
        throw new Error('Input inválido: forneça pelo menos uma empresa em "companies".');
    }
    const smtpVerify = input?.smtpVerify ?? true;
    const maxPatternsPerContact = Math.max(1, Math.min(input?.maxPatternsPerContact ?? 8, 12));
    const timeoutMsPerSmtp = Math.max(1000, Math.min(input?.timeoutMsPerSmtp ?? 5000, 30_000));
    const smtpFromAddress = input?.smtpFromAddress?.trim() || 'noreply@angoconnect.ao';
    const smtpHelloHostname = input?.smtpHelloHostname?.trim() || 'angoconnect.ao';
    const requestsPerSecondPerDomain = Math.max(
        1,
        Math.min(input?.requestsPerSecondPerDomain ?? 3, 5),
    );
    return {
        companies,
        smtpVerify,
        maxPatternsPerContact,
        timeoutMsPerSmtp,
        smtpFromAddress,
        smtpHelloHostname,
        requestsPerSecondPerDomain,
    };
}

function asSector(raw: string | null | undefined): Sector | null {
    if (!raw) return null;
    return VALID_SECTORS.has(raw as Sector) ? (raw as Sector) : null;
}

function asProvincia(raw: string | undefined): Provincia | null {
    if (!raw) return null;
    return VALID_PROVINCIAS.has(raw as Provincia) ? (raw as Provincia) : null;
}

function asRole(raw: string | undefined): ContactRole | undefined {
    if (!raw) return undefined;
    return VALID_ROLES.has(raw as ContactRole) ? (raw as ContactRole) : undefined;
}

// ============================================================================
// SCORING
// ============================================================================

/**
 * Pontuação de confiança baseada no resultado SMTP + posição do padrão.
 *
 * - 250 OK              → 0.9 verified
 * - catch-all detected  → 0.6 unverified (padrão match mas inconclusivo)
 * - timeout / 4xx       → 0.5 unverified
 * - 5xx em todos        → null email, 0.0
 *
 * Quando SMTP está desligado, devolvemos apenas o primeiro padrão
 * com confidence 0.4 (signal weak — só padrão, sem validação).
 */
function confidenceFromSmtp(result: SmtpResult): number {
    switch (result.code) {
        case 'ok': return 0.9;
        case 'catch_all': return 0.6;
        case 'greylist':
        case 'timeout':
        case 'unknown':
            return 0.5;
        case 'rejected_helo':
        case 'connect_error':
            return 0.3;
        case 'invalid':
            return 0.0;
    }
}

// ============================================================================
// ENRICHMENT LOOP — uma empresa
// ============================================================================

interface CompanyEnrichResult {
    item: EnrichedDatasetItem | null;
    skipped: boolean;
    skipReason?: string;
}

async function enrichCompany(
    company: InputCompany,
    config: ParsedInput,
): Promise<CompanyEnrichResult> {
    const name = company.name?.trim();
    if (!name) {
        return { item: null, skipped: true, skipReason: 'missing_name' };
    }
    const provincia = asProvincia(company.provincia);
    if (!provincia) {
        return { item: null, skipped: true, skipReason: 'invalid_provincia' };
    }
    const websiteNormalized = normalizeWebsite(company.website);
    const domain = extractDomain(company.website);
    if (!domain) {
        return { item: null, skipped: true, skipReason: 'missing_website' };
    }

    const sector = asSector(company.sector);
    const nif = company.nif?.trim() || null;
    const contactsInput = Array.isArray(company.contacts) ? company.contacts : [];

    // Resolver MX uma vez por empresa
    let mxHosts: string[] | null = null;
    let catchAll = false;
    if (config.smtpVerify) {
        mxHosts = await resolveMxRecords(domain);
        if (!mxHosts || mxHosts.length === 0) {
            logger.warn('ENRICH', 'No MX records — skipping SMTP for this domain', {
                domain, company: name,
            });
        } else {
            try {
                catchAll = await isCatchAllDomain({
                    domain,
                    mxHosts,
                    fromAddress: config.smtpFromAddress,
                    helloHostname: config.smtpHelloHostname,
                    timeoutMs: config.timeoutMsPerSmtp,
                    requestsPerSecondPerDomain: config.requestsPerSecondPerDomain,
                });
            } catch (err) {
                logger.warn('ENRICH', 'Catch-all detection failed', {
                    domain,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
    }

    const enrichedContacts: EnrichedContact[] = [];
    const patternsTriedSet = new Set<PatternId>();

    for (const c of contactsInput) {
        const fullName = c.full_name?.trim();
        if (!fullName) continue;

        const candidates = generateCandidates(fullName, domain, config.maxPatternsPerContact);
        if (candidates.length === 0) {
            enrichedContacts.push(buildContactBase(c, fullName, null, 0, false));
            continue;
        }
        candidates.forEach((cand) => patternsTriedSet.add(cand.pattern));

        // Caso 1 — SMTP desligado: só padrão (primeiro), baixa confidence
        if (!config.smtpVerify) {
            const first = candidates[0]!;
            enrichedContacts.push(buildContactBase(c, fullName, first.email, 0.4, false, 'SMTP_DISABLED'));
            continue;
        }

        // Caso 2 — Sem MX: também só padrão, baixa confidence
        if (!mxHosts || mxHosts.length === 0) {
            const first = candidates[0]!;
            enrichedContacts.push(buildContactBase(c, fullName, first.email, 0.3, false, 'NO_MX'));
            continue;
        }

        // Caso 3 — Catch-all: devolve padrão mais comum, sem verified
        if (catchAll) {
            const first = candidates[0]!;
            enrichedContacts.push(
                buildContactBase(c, fullName, first.email, 0.6, false, 'CATCH_ALL'),
            );
            continue;
        }

        // Caso 4 — Verifica candidato por candidato
        let bestResult: { email: string; result: SmtpResult } | null = null;
        let allInvalid = true;

        for (const cand of candidates) {
            if (!isValidEmailFormat(cand.email)) continue;
            const result = await verifyEmail({
                email: cand.email,
                domain,
                mxHosts,
                fromAddress: config.smtpFromAddress,
                helloHostname: config.smtpHelloHostname,
                timeoutMs: config.timeoutMsPerSmtp,
                requestsPerSecondPerDomain: config.requestsPerSecondPerDomain,
            });

            if (result.code !== 'invalid') allInvalid = false;

            if (result.code === 'ok') {
                bestResult = { email: cand.email, result };
                break; // pára no primeiro 250 OK
            }
            // guarda o melhor "não-invalid" para fallback
            if (!bestResult && result.code !== 'invalid') {
                bestResult = { email: cand.email, result };
            }
        }

        if (!bestResult) {
            // Todos invalid → email = null
            enrichedContacts.push(
                buildContactBase(c, fullName, null, 0, false, allInvalid ? '550 ALL_INVALID' : 'UNKNOWN'),
            );
            continue;
        }

        const confidence = confidenceFromSmtp(bestResult.result);
        const verified = bestResult.result.code === 'ok';
        enrichedContacts.push(
            buildContactBase(c, fullName, bestResult.email, confidence, verified, bestResult.result.response),
        );
    }

    const item: EnrichedDatasetItem = {
        name,
        nif,
        sector,
        provincia,
        website: websiteNormalized,
        source: 'manual',
        scraped_at: new Date().toISOString(),
        raw: {
            enriched_at: new Date().toISOString(),
            domain,
            patterns_tried: Array.from(patternsTriedSet),
            contacts: enrichedContacts,
        },
    };
    if (catchAll) item.raw.catch_all = true;

    return { item, skipped: false };
}

function buildContactBase(
    input: InputContact,
    fullName: string,
    email: string | null,
    confidence: number,
    verified: boolean,
    smtpResponse?: string,
): EnrichedContact {
    const out: EnrichedContact = {
        full_name: fullName,
        email,
        email_confidence: confidence,
        email_verified: verified,
    };
    if (input.title?.trim()) out.title = input.title.trim();
    if (input.phone?.trim()) out.phone = input.phone.trim();
    if (input.linkedin_url?.trim()) out.linkedin_url = input.linkedin_url.trim();
    const role = asRole(input.role);
    if (role) out.role = role;
    if (smtpResponse) out.smtp_response = smtpResponse;
    return out;
}

// ============================================================================
// ENTRY
// ============================================================================

await Actor.main(async () => {
    const input = await Actor.getInput<ActorInput>();
    const config = parseInput(input);

    logger.info('MAIN', 'Starting email-enricher', {
        companies: config.companies.length,
        smtpVerify: config.smtpVerify,
        maxPatternsPerContact: config.maxPatternsPerContact,
        timeoutMsPerSmtp: config.timeoutMsPerSmtp,
        requestsPerSecondPerDomain: config.requestsPerSecondPerDomain,
    });

    let pushed = 0;
    let skipped = 0;

    for (const company of config.companies) {
        try {
            const result = await enrichCompany(company, config);
            if (result.skipped || !result.item) {
                skipped++;
                logger.warn('MAIN', 'Company skipped', {
                    name: company.name,
                    reason: result.skipReason,
                });
                continue;
            }
            await Actor.pushData(result.item);
            pushed++;
        } catch (err) {
            skipped++;
            logger.error('MAIN', 'Failed to enrich company', {
                name: company.name,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    logger.info('MAIN', 'Enricher finished', { pushed, skipped });
});
