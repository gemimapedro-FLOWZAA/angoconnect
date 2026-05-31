import type { Provincia, Sector, CompanySize } from '../normalize.js';

/**
 * Mapa de prefixos CAE/CNAE angolano (2 dígitos) -> sector canónico.
 * Baseado na Classificação das Actividades Económicas (CAE Rev.2 / INE Angola).
 * Se a CAE não fizer match, devolve null (o enum não tem 'other').
 *
 * Nota CAE 65 (seguros): a divisão CAE Rev.2 dedica o 65 a seguros,
 * resseguros e fundos de pensões (vida + não-vida). Mapeia para `insurance`.
 * O 64 (intermediação financeira / banca) e 66 (auxiliares financeiros)
 * continuam em `banking`.
 */
const CAE_SECTOR_MAP: Record<string, Sector> = {
    // Agricultura, pecuária, pesca
    '01': 'agro', '02': 'agro', '03': 'agro',
    // Indústrias extractivas (petróleo / gás / minas)
    '05': 'oil_gas', '06': 'oil_gas', '07': 'oil_gas', '08': 'oil_gas', '09': 'oil_gas',
    // Construção
    '41': 'construction', '42': 'construction', '43': 'construction',
    // Comércio (retalho/grosso)
    '45': 'retail', '46': 'retail', '47': 'retail',
    // Transportes e logística
    '49': 'logistics', '50': 'logistics', '51': 'logistics', '52': 'logistics', '53': 'logistics',
    // Telecomunicações + tech
    '61': 'telecom', '62': 'tech', '63': 'tech',
    // Banca + auxiliares financeiros
    '64': 'banking', '66': 'banking',
    // Seguros, resseguros, fundos de pensões
    '65': 'insurance',
    // Educação
    '85': 'education',
    // Saúde humana e acção social
    '86': 'health', '87': 'health', '88': 'health',
    // Administração pública
    '84': 'government',
};

/**
 * Mapeia um código CAE (string) para o enum Sector canónico.
 * Aceita códigos com/sem ponto: "62.01" ou "6201" -> usa primeiros 2 dígitos.
 * Devolve null quando não há match — NUNCA inventa 'other'.
 */
export function mapSectorFromCAE(cae: string | undefined | null): Sector | null {
    if (!cae) return null;
    const digits = cae.replace(/\D/g, '');
    if (digits.length < 2) return null;
    const prefix = digits.slice(0, 2);
    return CAE_SECTOR_MAP[prefix] ?? null;
}

/**
 * Mapa de variantes de província (sem acento, lowercase) -> nome canónico.
 * O parsing remove acentos e normaliza espaços antes de fazer lookup.
 */
const PROVINCIA_MAP: Record<string, Provincia> = {
    'bengo': 'Bengo',
    'benguela': 'Benguela',
    'bie': 'Bié',
    'cabinda': 'Cabinda',
    'cuando cubango': 'Cuando Cubango',
    'kuando kubango': 'Cuando Cubango',
    'cuanza norte': 'Cuanza Norte',
    'kwanza norte': 'Cuanza Norte',
    'cuanza sul': 'Cuanza Sul',
    'kwanza sul': 'Cuanza Sul',
    'cunene': 'Cunene',
    'huambo': 'Huambo',
    'huila': 'Huíla',
    'luanda': 'Luanda',
    'lunda norte': 'Lunda Norte',
    'lunda sul': 'Lunda Sul',
    'malanje': 'Malanje',
    'moxico': 'Moxico',
    'namibe': 'Namibe',
    'uige': 'Uíge',
    'zaire': 'Zaire',
};

/**
 * Normaliza string de província: remove acentos, lowercase, colapsa espaços.
 * Devolve o nome canónico OU undefined se não houver match (NUNCA inventa).
 */
export function normalizeProvincia(raw: string | undefined | null): Provincia | undefined {
    if (!raw) return undefined;
    const cleaned = raw
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
    return PROVINCIA_MAP[cleaned];
}

/**
 * Converte uma string com formato AKZ ("50.000,00 Kz", "1 250 000", "AOA 75000")
 * para número inteiro em AKZ. Devolve undefined se não conseguir parse.
 */
export function parseCapitalSocial(raw: string | undefined | null): number | undefined {
    if (!raw) return undefined;
    // Remove tudo que não seja dígito, vírgula, ponto
    const stripped = raw.replace(/[^\d.,]/g, '');
    if (!stripped) return undefined;
    // Formato PT: "50.000,00" -> remove pontos (milhares), troca vírgula por ponto
    const normalized = stripped.replace(/\./g, '').replace(',', '.');
    const value = Number.parseFloat(normalized);
    if (!Number.isFinite(value) || value < 0) return undefined;
    return Math.round(value);
}

/**
 * Deduz tamanho da empresa a partir do capital social ou nº trabalhadores.
 * Tabela aproximada baseada em critérios PME angolanos (BNA/INE).
 */
export function deduceSize(args: {
    capitalSocial?: number;
    employees?: number;
}): CompanySize | undefined {
    const { capitalSocial, employees } = args;
    if (employees !== undefined) {
        if (employees < 10) return 'micro';
        if (employees < 50) return 'small';
        if (employees < 250) return 'medium';
        if (employees < 1000) return 'large';
        return 'enterprise';
    }
    if (capitalSocial !== undefined) {
        if (capitalSocial < 3_000_000) return 'micro';
        if (capitalSocial < 25_000_000) return 'small';
        if (capitalSocial < 100_000_000) return 'medium';
        if (capitalSocial < 500_000_000) return 'large';
        return 'enterprise';
    }
    return undefined;
}

/**
 * Valida formato do NIF angolano: 9 ou 10 dígitos.
 * Aceita NIF com letras (formato empresarial) -> mantém apenas alfanuméricos.
 */
export function normalizeNIF(raw: string | undefined | null): string | undefined {
    if (!raw) return undefined;
    const cleaned = raw.replace(/[^0-9A-Z]/gi, '').toUpperCase();
    if (cleaned.length < 9 || cleaned.length > 10) return undefined;
    return cleaned;
}

/**
 * Normaliza telefone angolano para formato +244XXXXXXXXX.
 * Devolve undefined se inválido.
 */
export function normalizePhone(raw: string | undefined | null): string | undefined {
    if (!raw) return undefined;
    const digits = raw.replace(/\D/g, '');
    if (!digits) return undefined;
    // Já tem código do país
    if (digits.startsWith('244') && digits.length === 12) return `+${digits}`;
    // Número local 9 dígitos
    if (digits.length === 9) return `+244${digits}`;
    return undefined;
}

/**
 * Converte data PT ("12/03/2020" ou "12-03-2020") para ISO YYYY-MM-DD.
 */
export function parseRegistrationDate(raw: string | undefined | null): string | undefined {
    if (!raw) return undefined;
    const match = raw.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (!match) return undefined;
    const [, dayStr, monthStr, yearStr] = match;
    if (!dayStr || !monthStr || !yearStr) return undefined;
    const day = dayStr.padStart(2, '0');
    const month = monthStr.padStart(2, '0');
    return `${yearStr}-${month}-${day}`;
}
