# IRGC Scraper — AngoConnect

Apify Actor que recolhe empresas registadas no portal público do **Guichê Único da Empresa (GUE)** angolano e exporta para o catálogo do AngoConnect via webhook. Cada item segue rigorosamente o contrato `IRGCDatasetItem` (shape flat) partilhado com o backend Next.js.

---

## O que faz

1. Recebe URLs de páginas de listagem do portal IRGC/GUE.
2. Navega com Playwright (Chromium headless), respeitando rate limit de **1 req/s** em domínios `.gov.ao` / `.co.ao`.
3. Extrai dados de empresa (NIF, CAE, província, capital social, contactos de sócios/gerentes).
4. Normaliza CAE → sector canónico, província → enum, capital social → AKZ inteiro.
5. Persiste cada empresa no dataset Apify através de `Actor.pushData()` no shape FLAT.
6. No fim, o **Apify dispara webhook** (`ACTOR.RUN.SUCCEEDED`) para o backend, que lê o dataset e sincroniza com Supabase.

---

## URL do portal (confirmada)

URL canónica: **`https://guicheunico.gov.ao/empresas`** — já fica como prefill no `INPUT_SCHEMA.json`.

> **Selectors em `src/extractors.ts` ainda pendentes de validação contra o HTML real** do GUE. Os actuais (`LISTING_SELECTORS`, `DETAIL_SELECTORS`) são uma proposta baseada em portais governamentais angolanos típicos. Antes do primeiro run em produção, inspecciona uma página de detalhe e ajusta.

---

## Como correr localmente

```bash
cd apify-actors/irgc-scraper
npm install
npm start
```

O input pode ser configurado em `storage/key_value_stores/default/INPUT.json` (o Apify cria automaticamente) ou via flag `--input='{...}'`.

Exemplo de input:
```json
{
  "startUrls": [{ "url": "https://guicheunico.gov.ao/empresas" }],
  "maxCompanies": 100,
  "sectorFilter": ["banking", "tech"],
  "provinciaFilter": ["Luanda"],
  "requestsPerSecond": 1
}
```

Os resultados aparecem em `storage/datasets/default/`.

---

## Como fazer deploy

```bash
# 1. Login com o token já existente em .env.local da raiz
apify login --token apify_api_XXXXXXXXXXXXXXXXXXXXXXXXXXX

# 2. Push do Actor
apify push
```

Depois do push, configura o webhook (ver secção seguinte).

---

## Configuração de webhook no Apify Console

Na página do Actor → **Integrations** → **Webhooks** → **Add webhook**:

- **Event types**: `ACTOR.RUN.SUCCEEDED`
- **Request URL**:
  - Produção: `https://APP_URL/api/apify/webhook`
  - Dev: `https://NGROK_URL/api/apify/webhook`
- **Headers**:
  ```
  X-Apify-Secret: <APIFY_WEBHOOK_SECRET>
  Content-Type: application/json
  ```
- **Payload template**: usa o default (que inclui `resource.defaultDatasetId`).

O backend Next.js valida o header com `timingSafeEqual` e consome o dataset usando `defaultDatasetId` + token Apify.

---

## Contrato de dataset (`IRGCDatasetItem`)

Shape **FLAT** — o backend não tem que ler campos aninhados.

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

type IRGCDatasetItem = {
  name: string;                       // obrigatório
  nif: string | null;                 // 9 ou 10 dígitos AO
  sector: Sector | null;              // null quando CAE não mapeia
  provincia: Provincia;               // OBRIGATÓRIO — item descartado se inválido
  website: string | null;             // URL completa com protocolo
  source: 'irgc';
  scraped_at: string;                 // ISO 8601
  raw: {                              // tudo o que não cabe nos campos flat
    source_url: string;               // URL da página de detalhe
    cae?: string;
    size?: 'micro' | 'small' | 'medium' | 'large' | 'enterprise';
    description?: string;
    address?: string;
    phone?: string;                   // +244XXXXXXXXX
    email?: string;
    registration_date?: string;       // YYYY-MM-DD
    capital_social?: number;          // AKZ inteiro
    contacts: Array<{                 // sócios / gerentes / administradores
      full_name: string;
      title?: string;
      email?: string;
      phone?: string;
      role?: 'gerente' | 'socio' | 'administrador' | 'representante' | 'other';
    }>;
  };
};
```

Este contrato vive em `src/normalize.ts` e **NÃO deve ser alterado sem coordenar com o backend** (`app/api/apify/webhook/route.ts`).

> **Contactos (gerentes/sócios) vão para `raw.contacts`.** O backend **NÃO** os processa em M1.0 — ficam preservados até M1.3 (linkedin-scraper) cruzar decisores reais. Isto evita poluir a tabela `contacts` do Supabase com dados públicos de baixa qualidade.

### Regras de descarte

- `name` ausente → item descartado silenciosamente.
- `provincia` ausente ou não mapeável para o enum → item descartado com `logger.warn`.
- `sector` ausente → item enviado com `sector: null` (NÃO descartado).
- Filtros do input (`sectorFilter`, `provinciaFilter`) → item descartado com `logger.debug`.

---

## Mapeamento de campos

| Campo cru | Função | Output |
|---|---|---|
| `cae` (ex: "62.01") | `mapSectorFromCAE` | `'tech'` ou `null` (sem fallback) |
| `provinciaRaw` (ex: "huíla") | `normalizeProvincia` | `'Huíla'` ou `undefined` (descarta item) |
| `capitalSocialRaw` (ex: "50.000,00 Kz") | `parseCapitalSocial` | `50000` (number) |
| `phone` (ex: "923 456 789") | `normalizePhone` | `'+244923456789'` |
| `registrationDateRaw` (ex: "12/03/2020") | `parseRegistrationDate` | `'2020-03-12'` |
| capital social + nº trabalhadores | `deduceSize` | `'micro' \| 'small' \| ...` (vai para `raw.size`) |

**Regra de ouro**: se não conseguires mapear, **omite o campo** (ou põe `null` se ele for required no shape flat). Nunca inventes.

### Mapa CAE → Sector (resumido)

| CAE | Sector |
|---|---|
| 01-03 | `agro` |
| 05-09 | `oil_gas` |
| 41-43 | `construction` |
| 45-47 | `retail` |
| 49-53 | `logistics` |
| 61 | `telecom` |
| 62-63 | `tech` |
| 64, 66 | `banking` |
| 65 | `insurance` |
| 84 | `government` |
| 85 | `education` |
| 86-88 | `health` |

---

## Estrutura

```
apify-actors/irgc-scraper/
├── .actor/
│   ├── actor.json         # Manifest Apify
│   └── INPUT_SCHEMA.json  # Schema do input
├── src/
│   ├── main.ts            # Entry point — Actor.main()
│   ├── crawler.ts         # PlaywrightCrawler config (rate limit, retries)
│   ├── handlers.ts        # LISTING + DETAIL route handlers
│   ├── extractors.ts      # HTML -> RawScrape (selectors centralizados aqui)
│   ├── normalize.ts       # RawScrape -> IRGCDatasetItem (contrato FLAT canónico)
│   └── utils/
│       ├── mapping.ts     # CAE, província, capital, NIF, telefone, data
│       └── logger.ts      # Wrapper do Apify log
├── package.json
├── tsconfig.json
├── Dockerfile             # apify/actor-node-playwright-chrome:20
├── .dockerignore
├── .gitignore
└── README.md
```

---

## Troubleshooting

### "Item descartado: name ou provincia inválida"
Ou o selector do nome (`DETAIL_SELECTORS.name`) não matcha, ou a string de província não está no `PROVINCIA_MAP` de `src/utils/mapping.ts`. Inspecciona o HTML real e ajusta selectors ou aliases.

### "Failed to process listing"
A página de listagem retornou 0 detail URLs. Causas comuns:
- Selector `LISTING_SELECTORS.detailLink` desactualizado.
- A listagem é renderizada via JS depois de um clique/scroll — pode ser preciso adicionar `page.waitForSelector(...)` antes da extracção.

### "Max companies reached"
Comportamento esperado. Aumenta `maxCompanies` no input.

### Apify dispara webhook mas backend recebe 0 items
Verifica `defaultDatasetId` no payload e se o backend está a usar o token Apify correcto para ler o dataset. Confirma também o header `X-Apify-Secret`.

### Selectors a actualizar quando portal mudar
- `src/extractors.ts` → `LISTING_SELECTORS` (lista + paginação)
- `src/extractors.ts` → `DETAIL_SELECTORS` (campos da empresa + contactos)

Tudo o resto (handlers, normalização, contrato) **não deve precisar de mudanças**.

---

## Comandos úteis

```bash
npm run lint     # tsc --noEmit (validação de tipos)
npm run build    # Compila para dist/
npm run start    # Corre localmente com tsx
npm run deploy   # apify push (faz upload do Actor)
```
