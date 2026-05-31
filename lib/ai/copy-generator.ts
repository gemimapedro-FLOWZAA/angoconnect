/**
 * AngoConnect — Claude API copy generator (M3.4)
 * ===========================================================================
 * Gera 1-5 variantes de copy de outreach em PT-AO usando Claude Opus 4.7.
 * O system prompt é estático e usa prompt-caching (`cache_control: ephemeral`)
 * para reduzir custos quando o mesmo workspace gera várias copies seguidas.
 *
 * Output: array de `{ subject?, body }`. Para canal=whatsapp, `subject`
 * fica omitido. Body limitado a ~80 palavras para email e 1024 chars para
 * whatsapp (limite Meta).
 */

import Anthropic from '@anthropic-ai/sdk';

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new AiConfigError('ANTHROPIC_API_KEY não configurada');
    }
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

export class AiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiConfigError';
  }
}

export class AiParseError extends Error {
  constructor(message: string, public raw: string) {
    super(message);
    this.name = 'AiParseError';
  }
}

export interface CopyContext {
  companyName: string;
  sector?: string;
  provincia?: string;
  recipientName?: string;
  recipientTitle?: string;
  senderName?: string;
  senderCompany?: string;
  sequenceGoal: string;
  tone?: 'profissional' | 'amistoso' | 'urgente';
  previousMessage?: string;
}

export interface CopyVariant {
  subject?: string;
  body: string;
}

const SYSTEM_PROMPT = `És um especialista em copy B2B angolano com 10 anos de experiência em vendas corporativas.

Escreves emails e mensagens de prospecção em **português europeu/angolano** (PT-AO), nunca em PT-BR.

Regras OBRIGATÓRIAS:
- Tom: corporativo, respeitoso, directo. NUNCA agressivo nem americano ("crush your goals", "game-changer", etc).
- Body: máximo 80 palavras para email, 1024 caracteres para whatsapp.
- Subject de email: máximo 60 caracteres. Curiosity-driven, sem CLICKBAIT.
- Personaliza com o contexto fornecido (companyName, sector, recipientName).
- Para WhatsApp: sem subject, body conciso. Pensa em mensagem que pareça humana e não bulk.
- Termina sempre com pergunta clara OU CTA leve (não pressão).
- NUNCA prometas resultados específicos sem dados (ex: "aumentamos vendas em 300%").
- Adapta ao sector angolano (oil_gas, banking, telecom, construction, etc).

Output: **APENAS JSON válido**, sem texto antes ou depois, no formato:
\`\`\`json
{ "variants": [{ "subject": "...", "body": "..." }] }
\`\`\`

Para canal whatsapp, omite o campo "subject" em cada variant.`;

export async function generateOutreachCopy(opts: {
  channel: 'email' | 'whatsapp';
  context: CopyContext;
  variantCount?: number;
}): Promise<CopyVariant[]> {
  const client = getClient();
  const variantCount = Math.min(5, Math.max(1, opts.variantCount ?? 3));

  const userMessage = JSON.stringify({
    channel: opts.channel,
    variantCount,
    context: opts.context,
  });

  // NOTE: prompt-caching via `cache_control` requer a versão beta do SDK
  // (anthropic-beta header). Mantemos o system simples por agora — adicionar
  // caching quando upgradearmos o SDK.
  const response = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  // Extrai texto do conteúdo da resposta
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new AiParseError('Resposta Claude sem bloco de texto', JSON.stringify(response.content));
  }
  const raw = textBlock.text.trim();

  // Tolerância a fences ```json ... ```
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new AiParseError(
      `JSON inválido na resposta Claude: ${err instanceof Error ? err.message : 'unknown'}`,
      cleaned
    );
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('variants' in parsed) ||
    !Array.isArray((parsed as { variants: unknown }).variants)
  ) {
    throw new AiParseError('Shape inesperado: falta `variants[]`', cleaned);
  }

  const variants = (parsed as { variants: unknown[] }).variants
    .map((v): CopyVariant | null => {
      if (!v || typeof v !== 'object') return null;
      const obj = v as Record<string, unknown>;
      const body = typeof obj.body === 'string' ? obj.body.trim() : '';
      if (!body) return null;
      const subject = typeof obj.subject === 'string' ? obj.subject.trim() : undefined;
      return opts.channel === 'whatsapp' ? { body } : { subject, body };
    })
    .filter((v): v is CopyVariant => v !== null);

  if (variants.length === 0) {
    throw new AiParseError('Nenhuma variante válida na resposta', cleaned);
  }

  return variants;
}
