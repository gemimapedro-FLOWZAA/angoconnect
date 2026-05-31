# Email Enricher — AngoConnect

Apify Actor que descobre **emails corporativos** de contactos angolanos a partir de:

1. **Padrões corporativos PT/AO** aplicados ao domínio do website da empresa.
2. **Verificação SMTP** (handshake `MX` + `MAIL FROM` + `RCPT TO`) — sem enviar mensagem.

Cada item de output é uma **empresa enriquecida** com `raw.contacts[]` actualizado. Shape **FLAT** segundo o contrato `IRGCDatasetItem` do `CLAUDE.md`.

---

## O que faz

Para cada empresa do input:

1. Normaliza o `website` e extrai o `domain` (`https://www.sonangol.co.ao/foo` → `sonangol.co.ao`).
2. Resolve MX records do domínio (uma lookup por run/domínio, cached).
3. Faz uma **detecção de catch-all** enviando `RCPT TO` para um endereço aleatório. Resultado cacheado por domínio.
4. Para cada contacto, gera até **8 candidatos** com os padrões corporativos mais comuns (ordem fixa).
5. Verifica cada candidato via SMTP até obter `250 OK` (primeiro ganha) ou todos esgotarem.
6. Devolve **um melhor candidato por contacto** com `email_confidence` e `email_verified`.

> **Não envia emails.** A verificação pára em `RCPT TO` — sem `DATA`, sem corpo de mensagem.

---

## Padrões usados (PT/AO)

Para `João Manuel da Silva @ sonangol.co.ao`:

| ID | Local | Email |
|---|---|---|
| `first.last` | `joao.silva` | `joao.silva@sonangol.co.ao` |
| `firstlast` | `joaosilva` | `joaosilva@sonangol.co.ao` |
| `f.last` | `j.silva` | `j.silva@sonangol.co.ao` |
| `flast` | `jsilva` | `jsilva@sonangol.co.ao` |
| `first_last` | `joao_silva` | `joao_silva@sonangol.co.ao` |
| `first` | `joao` | `joao@sonangol.co.ao` |
| `first.l` | `joao.s` | `joao.s@sonangol.co.ao` |
| `last` | `silva` | `silva@sonangol.co.ao` |

Para nomes com 3+ partes, adicionamos 2 extras (especifico PT/AO):

| ID | Local |
|---|---|
| `first.middle.last` | `joao.manuel.silva` |
| `first.last.middle` | `joao.silva.manuel` |

**Normalização de nomes**: NFD + strip de combining marks → lowercase → remove conectores (`de`, `da`, `do`, `dos`, `das`, `e`).

---

## Verificação SMTP

- Resolve MX records do domínio com Node `dns/promises.resolveMx`.
- Para cada candidato, abre TCP socket no porto 25 do MX com prioridade mais baixa.
- Sequência: `220` banner → `EHLO`/`HELO` → `MAIL FROM` → `RCPT TO` → `QUIT`.
- **Códigos relevantes**:
  - `250` / `251` → email aceite → `code: 'ok'`, confidence **0.9**, verified **true**
  - `550` / `551` / `553` / `554` → email rejeitado → `code: 'invalid'`, confidence **0.0**
  - `4xx` → greylist, retry uma vez após 30s → `code: 'greylist'` → confidence **0.5** se persistir
  - timeout → `code: 'timeout'` → confidence **0.5**
- **Rate limit por domínio**: máximo `requestsPerSecondPerDomain` (default 3) conexões/seg. Janela deslizante simples.
- **Catch-all detection**: 1ª conexão por domínio é com um endereço aleatório `verify-xxxx@dominio.ao`. Se `250 OK`, todos os candidatos desse domínio ficam com `email_verified: false` e `email_confidence: 0.6`.

> **Saída TCP 25**: Alguns runners Apify (especialmente plano Free) bloqueiam saída para porto 25. Nesses casos:
> - Desliga via `smtpVerify: false` — só padrões, confidence baixa (`0.4`).
> - Ou corre o Actor noutro runtime com saída SMTP livre.

---

## Aviso GDPR / Privacidade

A verificação SMTP **deixa rasto** nos logs dos servidores de email destino:

- O `MAIL FROM` (default `noreply@angoconnect.ao`) fica registado.
- O `RCPT TO` revela quem está a tentar adivinhar emails do domínio.
- Algumas plataformas (Microsoft 365, Google Workspace) detectam estes scans e podem **bloquear** o IP de origem.

**O utilizador assume responsabilidade pelo uso**. Recomendações:

- Não correr contra domínios sensíveis (banca, militares, hospitais).
- Usar SMTP verify apenas para enriquecer leads que já consentiram com contacto comercial (ex: existentes no CRM).
- Documentar a base legal (interesse legítimo) no Registo de Actividades de Tratamento.
- Respeitar `requestsPerSecondPerDomain ≤ 3` para evitar ban e queixas.

---

## Input

```json
{
  "companies": [
    {
      "name": "Sonangol",
      "nif": "5417000001",
      "provincia": "Luanda",
      "sector": "oil_gas",
      "website": "https://sonangol.co.ao",
      "contacts": [
        { "full_name": "João Manuel", "title": "Director Comercial" },
        { "full_name": "Maria Pinto", "title": "CFO" }
      ]
    }
  ],
  "smtpVerify": true,
  "maxPatternsPerContact": 8,
  "timeoutMsPerSmtp": 5000,
  "smtpFromAddress": "noreply@angoconnect.ao",
  "smtpHelloHostname": "angoconnect.ao",
  "requestsPerSecondPerDomain": 3
}
```

### Regras de descarte

- `name` ausente → empresa descartada com `skipReason: 'missing_name'`.
- `provincia` não pertence ao enum → descartada com `skipReason: 'invalid_provincia'`.
- `website` ausente (sem domínio possível) → descartada com `skipReason: 'missing_website'`.
- Contacto sem `full_name` → ignorado (mas empresa fica no output).

---

## Output (contrato `EnrichedDatasetItem`)

Shape **FLAT** + `raw.contacts`.

```ts
type Sector =
  | 'oil_gas' | 'construction' | 'telecom' | 'banking'
  | 'insurance' | 'retail' | 'agro' | 'health'
  | 'education' | 'logistics' | 'tech' | 'government';

type Provincia =
  | 'Bengo' | 'Benguela' | 'Bié' | 'Cabinda' | 'Cuando Cubango'
  | 'Cuanza Norte' | 'Cuanza Sul' | 'Cunene' | 'Huambo' | 'Huíla'
  | 'Luanda' | 'Lunda Norte' | 'Lunda Sul' | 'Malanje' | 'Moxico'
  | 'Namibe' | 'Uíge' | 'Zaire';

type EnrichedDatasetItem = {
  name: string;
  nif: string | null;
  sector: Sector | null;
  provincia: Provincia;
  website: string | null;
  source: 'manual';                  // meta-fonte — Actor combina inputs
  scraped_at: string;                // ISO 8601
  raw: {
    enriched_at: string;
    domain?: string;                 // ex: 'sonangol.co.ao'
    patterns_tried?: string[];       // ex: ['first.last', 'flast', ...]
    catch_all?: boolean;
    contacts: Array<{
      full_name: string;
      title?: string;
      email: string | null;
      email_confidence: number;      // 0..1
      email_verified: boolean;
      smtp_response?: string;        // ex: '250 OK', 'CATCH_ALL', 'TIMEOUT'
      phone?: string;
      linkedin_url?: string;
      role?: 'gerente' | 'socio' | 'administrador'
           | 'representante' | 'decisor' | 'other';
    }>;
  };
};
```

### Decisão importante: `source: 'manual'`

O enum oficial de `source` (CLAUDE.md) é `'irgc' | 'linkedin' | 'bue' | 'news' | 'manual'`. O `email-enricher` **não tem fonte primária própria** — recebe empresas+contactos de outros Actors (irgc-scraper, linkedin-scraper) ou do CRM. Por isso, emite `source: 'manual'` como meta-fonte. O backend deduplica por `nif` (ou `lower(name)+provincia`) e faz merge dos campos enriquecidos.

> Alternativa rejeitada: adicionar `'email_enricher'` ao enum. Isso quebraria o contrato canónico e exigiria migration. `'manual'` é semanticamente correcto — o Actor agrega dados de várias fontes e o backend já trata `manual` como "actualização ou inserção lateral".

---

## Como correr localmente

```bash
cd apify-actors/email-enricher
npm install
npm start
```

O input pode ser configurado em `storage/key_value_stores/default/INPUT.json` (Apify cria) ou via flag `--input='{...}'`.

Os resultados aparecem em `storage/datasets/default/`.

### Quando testes, verifica:

1. **`raw.domain` foi extraído correctamente** do website (sem `www.`, sem porto, sem path).
2. **`raw.patterns_tried`** lista os padrões avaliados.
3. **`raw.contacts[].email_verified: true`** apenas quando SMTP devolveu 250.
4. **Catch-all detectado**: corre contra `gmail.com` ou outro provider grande — `raw.catch_all: true`, todos os contactos com `email_verified: false`.
5. **Sem MX**: corre com `website: "https://dominio-fake-sem-mx-12345.ao"` — todos os contactos com `smtp_response: 'NO_MX'`.

---

## Como fazer deploy

```bash
# 1. Login com o token já existente em .env.local da raiz
apify login --token apify_api_XXXXXXXXXXXXXXXXXXXXXXXXXXX

# 2. Push do Actor
apify push
```

---

## Webhook

Como em `irgc-scraper`, o Apify dispara `ACTOR.RUN.SUCCEEDED` para o backend:

- **Event types**: `ACTOR.RUN.SUCCEEDED`
- **Request URL**: `https://APP_URL/api/apify/webhook`
- **Headers**:
  ```
  X-Apify-Secret: <APIFY_WEBHOOK_SECRET>
  Content-Type: application/json
  ```

O backend valida com `timingSafeEqual` e consome o dataset via `defaultDatasetId`.

---

## Invocação por outro Actor

Tipicamente o orquestrador encadeia: `linkedin-scraper` → `email-enricher`. O backend (`/api/apify/trigger`) injecta o output do scraper como input deste Actor.

```ts
// pseudo-código backend
const linkedinItems = await apifyClient
  .dataset(linkedinRunResult.defaultDatasetId)
  .listItems();

// mapeia para o shape de input
const enricherInput = {
  companies: groupBy(linkedinItems, 'company_name').map((group) => ({
    name: group.company_name,
    nif: group.company_nif ?? null,
    provincia: group.company_provincia,
    sector: group.company_sector,
    website: group.company_website,
    contacts: group.items.map((i) => ({
      full_name: i.contact_name,
      title: i.contact_title,
      linkedin_url: i.contact_url,
    })),
  })),
  smtpVerify: true,
};

await apifyClient.actor('email-enricher').call(enricherInput);
```

---

## Estrutura

```
apify-actors/email-enricher/
├── .actor/
│   ├── actor.json         # Manifest Apify
│   └── INPUT_SCHEMA.json  # Schema do input
├── src/
│   ├── main.ts            # Entry point — Actor.main(), loop por empresa
│   ├── patterns.ts        # Gerador dos 8 (+2) padrões PT/AO
│   ├── smtp.ts            # MX lookup, handshake SMTP, catch-all, rate limit
│   ├── normalize.ts       # Tipos canónicos, strip diacritics, extract domain
│   └── utils/
│       └── logger.ts      # Wrapper Apify log
├── package.json
├── tsconfig.json
├── Dockerfile             # apify/actor-node:20 (sem browser)
├── .dockerignore
├── .gitignore
└── README.md
```

Sem Playwright, sem Cheerio. Só Node + `dns/promises` + `net`.

---

## Troubleshooting

### "No MX records" para todos os domínios
Apify runner pode estar a bloquear DNS UDP. Confirma que `dig MX sonangol.co.ao` funciona da máquina onde o Actor corre.

### Todos os emails retornam `code: 'connect_error'`
A saída TCP 25 está bloqueada (típico em runners cloud, ISPs residenciais).
**Solução**: corre com `smtpVerify: false` ou usa um runner com saída SMTP livre.

### Servidor `.gov.ao` responde 421 / 451 (greylist persistente)
Aumenta `timeoutMsPerSmtp` para 15000+ e reduz `requestsPerSecondPerDomain` para 1. Servidores governamentais angolanos são lentos.

### Muitos `catch_all: true`
Provider corporativo (Outlook 365, Google Workspace) está configurado para aceitar tudo. O confidence cai para 0.6 — usa o email com cautela, valida via outro canal (ex: enviar uma mensagem de validação).

### `tsc --noEmit` reporta erros
Verifica que `noUncheckedIndexedAccess: true` no `tsconfig.json` está bem suportado — toda a indexação de arrays usa `!` ou guards explícitos.

---

## Comandos úteis

```bash
npm run lint     # tsc --noEmit (validação de tipos)
npm run build    # Compila para dist/
npm run start    # Corre localmente com tsx
npm run deploy   # apify push (faz upload do Actor)
```
