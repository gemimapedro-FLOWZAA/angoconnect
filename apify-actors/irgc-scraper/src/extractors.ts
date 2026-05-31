import type { Page } from 'playwright';
import type { RawCompany, RawContact, RawScrape } from './normalize.js';

// ============================================================================
// SELECTORS — ALTERAR QUANDO O PORTAL REAL FOR CONFIRMADO
// ============================================================================
// Estes selectors são uma proposta baseada em portais governamentais angolanos
// típicos (GUE / BUE / SIAC). É necessário inspeccionar o HTML real e ajustar.
//
// Convenção: usamos múltiplos selectors fallback (separados por vírgula).
// O extractor pega no primeiro que retornar texto.
// ============================================================================

export const LISTING_SELECTORS = {
    /** Container de cada empresa na lista */
    companyRow: '.empresa-item, .company-row, tr.empresa, [data-empresa]',
    /** Link para a página de detalhe da empresa */
    detailLink: 'a.empresa-link, a[href*="/empresa/"], a[href*="/detalhe"]',
    /** Botão / link de próxima página */
    nextPage: 'a.next-page, a[rel="next"], .pagination .next a, button.proxima',
};

export const DETAIL_SELECTORS = {
    name: 'h1.empresa-nome, h1[itemprop="name"], .empresa-titulo, .company-name',
    nif: '[data-field="nif"], .nif-value, .empresa-nif, dd.nif',
    cae: '[data-field="cae"], .cae-value, .empresa-cae, dd.cae',
    provincia: '[data-field="provincia"], .provincia-value, .empresa-provincia, dd.provincia',
    address: '[data-field="endereco"], .endereco-value, .empresa-endereco, dd.endereco',
    phone: '[data-field="telefone"], .telefone-value, a[href^="tel:"], dd.telefone',
    email: '[data-field="email"], a[href^="mailto:"], dd.email',
    website: '[data-field="website"], .website-value, a.empresa-site, dd.website',
    description: '.empresa-descricao, [data-field="descricao"], .objecto-social',
    registrationDate: '[data-field="data-registo"], .data-registo, dd.data-registo',
    capitalSocial: '[data-field="capital"], .capital-social, dd.capital',
    /** Container de cada sócio/gerente/administrador */
    contactRow: '.socio-item, .contacto-item, .empresa-membro, tr.socio',
    contactName: '.nome, [itemprop="name"], td.nome',
    contactTitle: '.cargo, .funcao, td.cargo',
    contactEmail: 'a[href^="mailto:"]',
    contactPhone: 'a[href^="tel:"]',
};

// ============================================================================
// HELPERS DE EXTRACÇÃO
// ============================================================================

/**
 * Devolve o textContent (trimmed) do primeiro selector que matcha, ou undefined.
 */
async function textOf(page: Page, selectorList: string): Promise<string | undefined> {
    const selectors = selectorList.split(',').map((s) => s.trim());
    for (const sel of selectors) {
        try {
            const handle = await page.$(sel);
            if (!handle) continue;
            const text = await handle.textContent();
            const trimmed = text?.trim();
            if (trimmed) return trimmed;
        } catch {
            // Selector inválido ou elemento removido; tenta próximo
        }
    }
    return undefined;
}

/**
 * Devolve o atributo `attr` do primeiro selector que matcha, ou undefined.
 */
async function attrOf(
    page: Page,
    selectorList: string,
    attr: string,
): Promise<string | undefined> {
    const selectors = selectorList.split(',').map((s) => s.trim());
    for (const sel of selectors) {
        try {
            const handle = await page.$(sel);
            if (!handle) continue;
            const value = await handle.getAttribute(attr);
            if (value?.trim()) return value.trim();
        } catch {
            // continua
        }
    }
    return undefined;
}

/**
 * Extrai email de href="mailto:..." ou de texto puro.
 */
async function extractEmail(page: Page): Promise<string | undefined> {
    const mailtoHref = await attrOf(page, DETAIL_SELECTORS.email, 'href');
    if (mailtoHref?.startsWith('mailto:')) return mailtoHref.slice(7);
    return textOf(page, DETAIL_SELECTORS.email);
}

/**
 * Extrai telefone de href="tel:..." ou de texto puro.
 */
async function extractPhone(page: Page): Promise<string | undefined> {
    const telHref = await attrOf(page, DETAIL_SELECTORS.phone, 'href');
    if (telHref?.startsWith('tel:')) return telHref.slice(4);
    return textOf(page, DETAIL_SELECTORS.phone);
}

// ============================================================================
// EXTRACTORS PRINCIPAIS
// ============================================================================

/**
 * Página de listagem: devolve as URLs absolutas das páginas de detalhe.
 */
export async function extractDetailUrls(page: Page): Promise<string[]> {
    const links = await page.$$eval(
        LISTING_SELECTORS.detailLink,
        (anchors) =>
            (anchors as HTMLAnchorElement[])
                .map((a) => a.href)
                .filter((href) => Boolean(href)),
    );
    // Dedupe mantendo ordem
    return Array.from(new Set(links));
}

/**
 * Página de listagem: devolve URL da próxima página ou undefined.
 */
export async function extractNextPageUrl(page: Page): Promise<string | undefined> {
    return attrOf(page, LISTING_SELECTORS.nextPage, 'href');
}

/**
 * Página de detalhe: extrai todos os dados crus da empresa.
 */
export async function extractCompany(page: Page): Promise<RawCompany> {
    return {
        name: await textOf(page, DETAIL_SELECTORS.name),
        nif: await textOf(page, DETAIL_SELECTORS.nif),
        cae: await textOf(page, DETAIL_SELECTORS.cae),
        provinciaRaw: await textOf(page, DETAIL_SELECTORS.provincia),
        website: await attrOf(page, DETAIL_SELECTORS.website, 'href')
            ?? await textOf(page, DETAIL_SELECTORS.website),
        description: await textOf(page, DETAIL_SELECTORS.description),
        address: await textOf(page, DETAIL_SELECTORS.address),
        phone: await extractPhone(page),
        email: await extractEmail(page),
        registrationDateRaw: await textOf(page, DETAIL_SELECTORS.registrationDate),
        capitalSocialRaw: await textOf(page, DETAIL_SELECTORS.capitalSocial),
    };
}

/**
 * Página de detalhe: extrai lista de contactos (sócios, gerentes, etc).
 */
export async function extractContacts(page: Page): Promise<RawContact[]> {
    const rows = await page.$$(DETAIL_SELECTORS.contactRow);
    const contacts: RawContact[] = [];
    for (const row of rows) {
        try {
            const nameEl = await row.$(DETAIL_SELECTORS.contactName);
            const fullName = (await nameEl?.textContent())?.trim();
            if (!fullName) continue;
            const titleEl = await row.$(DETAIL_SELECTORS.contactTitle);
            const title = (await titleEl?.textContent())?.trim();
            const emailEl = await row.$(DETAIL_SELECTORS.contactEmail);
            const emailHref = await emailEl?.getAttribute('href');
            const email = emailHref?.startsWith('mailto:') ? emailHref.slice(7) : undefined;
            const phoneEl = await row.$(DETAIL_SELECTORS.contactPhone);
            const phoneHref = await phoneEl?.getAttribute('href');
            const phone = phoneHref?.startsWith('tel:') ? phoneHref.slice(4) : undefined;
            const contact: RawContact = { fullName };
            if (title) contact.title = title;
            if (email) contact.email = email;
            if (phone) contact.phone = phone;
            if (title) contact.roleHint = title;
            contacts.push(contact);
        } catch {
            // Linha mal-formada; ignora
        }
    }
    return contacts;
}

/**
 * Combina extracção de empresa + contactos numa única chamada.
 */
export async function extractRawScrape(page: Page, sourceUrl: string): Promise<RawScrape> {
    const [company, contacts] = await Promise.all([
        extractCompany(page),
        extractContacts(page),
    ]);
    return { sourceUrl, company, contacts };
}
