# LinkedIn Scraper — AngoConnect

Apify Actor **orquestrador** que descobre empresas angolanas e os respectivos **decisores** (CEO, Director Comercial, CFO, Director de Compras, etc.) no LinkedIn, e exporta tudo para o catálogo AngoConnect via webhook. Cada item segue rigorosamente o contrato canónico `DatasetItem` (shape flat, mesmo formato do `irgc-scraper` — só muda `source: 'linkedin'`).

---

## Estratégia: orchestrator (não scraper directo)

O LinkedIn é hostil a scrapers. Tentar Playwright + cookie session leva a ban da conta em poucas horas. Por isso este Actor **NÃO navega o LinkedIn directamente**. Em vez disso:

1. Invoca um **Actor público da Apify Store** para pesquisa/scrape de empresas — via `Apify.call(actorId, input)`.
2. Para cada empresa devolvida, invoca um **Actor público da Apify Store** para perfis de pessoas (filtrado por títulos).
3. Agrega tudo e normaliza para o shape canónico flat.
4. Empurra para o dataset; o backend Next.js consome via webhook como faz com o `irgc-scraper`.

Vantagens: scraping é responsabilidade do dono do Actor da Store (problema deles se o LinkedIn os bane), o nosso Actor mantém-se simples e estável.

Custos: cada Actor da Store cobra créditos Apify por run/item. Ler a página do Actor escolhido na Store para a tabela de preços.

---

## O que falta antes de correr (importante)

### 1. Escolher os 2 Actors da Apify Store

Vai à [Apify Store](https://apify.com/store) e procura por:

- **LinkedIn Company Scraper** — para pesquisa por filtros (location=Angola, headcount) e scrape de páginas de empresa.
- **LinkedIn Profile Scraper** — para procurar pessoas dentro de uma empresa filtradas por título.

Candidatos recomendados como defaults (validar custo + estado antes do primeiro run):

| Função | Actor sugerido | Notas |
|---|---|---|
| Empresas | `dev_fusion/linkedin-company-scraper` | Aceita `companyUrls` e `searchTerms`; output inclui industry, location, employeeCount. |
| Pessoas | `apimaestro/linkedin-profile-scraper` | Aceita `companyUrl` + `titles`; output inclui fullName, title, profileUrl. |
| Alternativa empresas | `harvestapi/linkedin-company-employees` | Tudo num só (empresa + employees), mas mais caro. |
| Alternativa pessoas | `curious_coder/linkedin-people-search` | Quando o Actor primário falha. |

> **Importante**: os IDs acima são placeholders sugeridos com base em Actors populares à data de escrita. Antes de correr, ABRE cada um na Apify Store, confirma que ainda está activo, lê o INPUT_SCHEMA real e ajusta o mapeamento em `src/orchestrator.ts` (funções `callCompanyActor` / `callPeopleActor`) se o shape de input deles não bater com o que enviamos.

### 2. Configurar os Actor IDs

Há dois caminhos:

**a) Via variáveis de ambiente** (recomendado para deploy):
```bash
LINKEDIN_COMPANY_ACTOR_ID=dev_fusion/linkedin-company-scraper
LINKEDIN_PEOPLE_ACTOR_ID=apimaestro/linkedin-profile-scraper
```

No Apify Console → este Actor → **Settings** → **Environment variables**.

**b) Via input do Actor** (override pontual por run):
```json
{
  "linkedinCompanyActorId": "dev_fusion/linkedin-company-scraper",
  "linkedinPeopleActorId": "apimaestro/linkedin-profile-scraper"
}
```

Se nenhum dos dois for fornecido, o Actor falha cedo com mensagem clara.

### 3. Validar mapeamento input/output dos Actors escolhidos

Os Actors da Store usam nomes de campos diferentes. Em `src/orchestrator.ts`:

- `mapToRawCompany()` — lê `name`, `companyName` ou `title`; `location`, `headquarter` ou `locationName`; etc.
- `mapToRawContact()` — lê `fullName` ou `name`; `title` ou `jobTitle`; `profileUrl` ou `linkedinUrl`; etc.

Se o teu Actor escolhido usar um nome que não está na lista, adiciona-o ao argumento variádico dos helpers `getString` / `getNumber` / `getArray`.

### 4. Credenciais Apify

O Actor corre dentro da Apify Platform — o token Apify é injectado automaticamente e usado pelo `Apify.call()` para invocar os outros Actors. Não precisas de credenciais LinkedIn nem cookies.

Em **local** (`npm start`), define `APIFY_TOKEN` no `.env.local` para que o `Apify.call()` funcione.

---

## Como correr localmente

```bash
cd apify-actors/linkedin-scraper
npm install
LINKEDIN_COMPANY_ACTOR_ID=dev_fusion/linkedin-company-scraper \
LINKEDIN_PEOPLE_ACTOR_ID=apimaestro/linkedin-profile-scraper \
APIFY_TOKEN=apify_api_... \
npm start
```

O input vai para `storage/key_value_stores/default/INPUT.json` (criado pelo Apify SDK).

### Exemplo de input — modo search

```json
{
  "mode": "search",
  "searchFilters": {
    "provincia": ["Luanda", "Benguela"],
    "sector": ["oil_gas", "banking"],
    "minHeadcount": 50,
    "titlesIncluded": ["CEO", "Director Comercial", "CFO"]
  },
  "maxContactsPerCompany": 5,
  "maxCompanies": 100
}
```

### Exemplo de input — modo from_companies

Útil para enriquecer empresas já no Supabase (vindas do `irgc-scraper`):

```json
{
  "mode": "from_companies",
  "companyTargets": [
    { "name": "Sonangol", "nif": "5417000001" },
    { "name": "BAI", "linkedinUrl": "https://www.linkedin.com/company/bai-angola/" }
  ],
  "searchFilters": {
    "titlesIncluded": ["Director Comercial", "Director de Compras"]
  },
  "maxContactsPerCompany": 3,
  "maxCompanies": 50
}
```

---

## Como fazer deploy

```bash
# Login com o token Apify (mesmo do irgc-scraper)
apify login --token apify_api_XXXXXXXXXXXXXXXXXXXXXXXXXXX

# Push do Actor
apify push
```

Depois do push:
1. Apify Console → este Actor → **Settings** → **Environment variables** → adicionar `LINKEDIN_COMPANY_ACTOR_ID` e `LINKEDIN_PEOPLE_ACTOR_ID`.
2. Configurar webhook (secção seguinte).

---

## Configuração de webhook no Apify Console

Mesma configuração que o `irgc-scraper`. Na página deste Actor → **Integrations** → **Webhooks** → **Add webhook**:

- **Event types**: `ACTOR.RUN.SUCCEEDED`
- **Request URL**:
  - Produção: `https://APP_URL/api/apify/webhook`
  - Dev: `https://NGROK_URL/api/apify/webhook`
- **Headers**:
  ```
  X-Apify-Secret: <APIFY_WEBHOOK_SECRET>
  Content-Type: application/json
  ```
- **Payload template**: usa o default (inclui `resource.defaultDatasetId`).

O backend valida o header com `timingSafeEqual` e consome o dataset usando `defaultDatasetId` + token Apify. Distingue items deste Actor pelo campo `source: 'linkedin'`.

---

## Contrato de dataset (`DatasetItem`)

Shape **FLAT** — o backend não tem que ler campos aninhados além de `raw.contacts`.

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

type DatasetItem = {
  name: string;                       // obrigatório
  nif: string | null;                 // 9-10 dígitos AO (se o input trouxer; LinkedIn não tem)
  sector: Sector | null;              // null quando industry não mapeia para enum
  provincia: Provincia;               // OBRIGATÓRIO — item descartado se inválido
  website: string | null;
  source: 'linkedin';
  scraped_at: string;                 // ISO 8601
  raw: {
    linkedin_company_url?: string;
    headcount?: string;               // "51-200 employees"
    industry_raw?: string;            // texto bruto do LinkedIn
    description?: string;
    location_raw?: string;
    contacts?: Array<{
      full_name: string;              // obrigatório
      title: string;                  // obrigatório
      linkedin_url: string;           // obrigatório (é a chave para enrichment posterior)
      headline?: string;
      location?: string;
      role?: 'gerente' | 'socio' | 'administrador'
           | 'representante' | 'decisor' | 'other';
    }>;
  };
};
```

> **Adição face ao irgc-scraper**: o role `'decisor'` é novo. Representa C-suite (excepto CEO, que continua `administrador`) e Directores. **Coordenar com Backend Engineer** para aceitar este valor no insert da tabela `contacts`.

`raw.contacts` é a colecção que o Backend vai processar para popular a tabela `contacts` do Supabase. A chave de dedupe natural é `linkedin_url` (sempre presente, sempre normalizado).

### Regras de descarte

- `name` ausente → item descartado silenciosamente (`logger.debug`).
- `provincia` ausente ou não mapeável para o enum → item descartado com `logger.warn`.
- `sector` ausente → item enviado com `sector: null` (NÃO descartado).
- Contacto sem `full_name` OU sem `linkedin_url` OU sem `title` → contacto descartado individualmente; empresa preservada com `contacts: []`.

---

## Mapeamento de campos

### Empresa

| Campo cru (LinkedIn) | Função | Output |
|---|---|---|
| `industry` (ex: "Oil & Gas") | `mapSectorFromIndustry` | `'oil_gas'` ou `null` |
| `location` / `headquarter` (ex: "Luanda, Angola") | `normalizeProvinciaFromLocation` | `'Luanda'` ou `undefined` (descarta item) |
| `website` | `normalizeWebsite` | URL completa com `https://` |
| `linkedinUrl` | `normalizeLinkedinUrl` | URL canonicalizada, lowercase host |
| `employeeCountRange` ou `employeeCount` | passthrough | string `"51-200 employees"` |
| `nif` (vindo do input em `mode=from_companies`) | `normalizeNIF` | 9-10 dígitos ou `null` |

### Contacto (title → role)

Implementado em `src/titleRoleMapper.ts`. Regras (PT + EN), pelo primeiro match:

| Pattern | Role |
|---|---|
| `CEO`, `Founder`, `Owner`, `Administrador`, `Presidente`, `Chairman` | `administrador` |
| `CFO`, `COO`, `CTO`, `Chief * Officer` (excepto CEO), `Director`, `Diretor`, `VP`, `Head of` | `decisor` |
| `Sócio`, `Partner`, `Managing Partner` | `socio` |
| `Sócio-Gerente` | `gerente` (caso especial — operacional do dia-a-dia) |
| `Gerente`, `Manager`, `Supervisor`, `Team Lead` | `gerente` |
| `Representante`, `Procurador`, `Account Executive`, `Sales Representative` | `representante` |
| Outros | `other` |

**Regra de ouro**: se não conseguires mapear, **omite o campo** (ou marca `other`). Nunca inventes.

---

## Estrutura

```
apify-actors/linkedin-scraper/
├── .actor/
│   ├── actor.json              # Manifest Apify
│   └── INPUT_SCHEMA.json       # Schema do input
├── src/
│   ├── main.ts                 # Entry — Actor.main(), parse input, push items
│   ├── orchestrator.ts         # Invoca Actors da Store via Apify.call
│   ├── normalize.ts            # RawLinkedinCompany -> DatasetItem (contrato FLAT)
│   ├── titleRoleMapper.ts      # PT/EN titles -> ContactRole
│   └── utils/
│       ├── logger.ts           # Wrapper Apify log
│       └── mapping.ts          # industry, provincia, NIF, website, linkedin URL
├── package.json
├── tsconfig.json
├── Dockerfile                  # apify/actor-node:20 (sem browser)
├── .dockerignore
├── .gitignore
└── README.md
```

---

## Limitações conhecidas

### LinkedIn ban risk
Mesmo orquestrando Actors da Store, runs frequentes na mesma janela podem fazer o LinkedIn detectar padrões. Recomendações:
- Espaça runs em pelo menos 1-2 horas.
- Limita `maxCompanies` a algumas centenas por run.
- Não corras em loop infinito.

### Custo
Cada Actor da Store cobra créditos Apify. Estimativa grosseira:
- Pesquisa de empresas: ~$0.005-0.02 por empresa.
- Scrape de perfis: ~$0.01-0.05 por perfil.

Para 100 empresas com 5 contactos cada → ~$3-30 por run. Monitora em Apify Console → **Billing**.

### Latência
Cada Actor da Store tem o seu próprio scheduler. Esperas típicas:
- Pesquisa de empresas: 1-5 minutos.
- People scraper: 30s-2min por empresa (sequencial).

Para 100 empresas, conta com 30-120 minutos de run total. O timeout do `Apify.call` está configurado para 30 minutos por chamada — ajusta em `orchestrator.ts` se precisares.

### Qualidade dos dados
- `industry` no LinkedIn é texto livre e impreciso. Esperar ~20-30% de items com `sector: null`.
- `location` muitas vezes é a cidade da sede da casa-mãe (ex: "Lisbon, Portugal" para uma filial em Luanda). Esses items são descartados silenciosamente.
- `nif` NUNCA vem do LinkedIn — só está presente em `mode=from_companies` se o input o trouxer.

### Dependência de terceiros
Se o Actor da Store escolhido for descontinuado ou banido:
1. Vai à Apify Store, escolhe outro.
2. Actualiza os IDs em env / input.
3. Possível ajuste em `mapToRawCompany` / `mapToRawContact` se o output shape mudar.

---

## Troubleshooting

### "Configuração inválida: defina LINKEDIN_COMPANY_ACTOR_ID..."
Falta o ID do Actor da Store. Ver secção "O que falta antes de correr" acima.

### "Company Actor returned no run"
O `Apify.call()` devolveu null — provavelmente token Apify sem permissão para invocar Actors pagos ou créditos esgotados. Verifica Apify Console → **Billing**.

### "Item descartado: provincia inválida"
A `location` devolvida pelo LinkedIn não bate em nenhuma das províncias canónicas. Inspecciona o item bruto na KV Store (`failed-*`) e considera adicionar aliases em `src/utils/mapping.ts` → `PROVINCIA_MAP`.

### Apify dispara webhook mas backend recebe 0 items
Verifica `defaultDatasetId` no payload e se o backend está a usar o token Apify correcto para ler o dataset. Confirma também o header `X-Apify-Secret`.

### Actor da Store mudou o output shape
Ajusta os `getString(...)` em `src/orchestrator.ts` adicionando o novo nome de campo à lista variádica. Não é preciso mexer no `normalize.ts`.

---

## Comandos úteis

```bash
npm run lint     # tsc --noEmit (validação de tipos)
npm run build    # Compila para dist/
npm run start    # Corre localmente com tsx
npm run deploy   # apify push (faz upload do Actor)
```
