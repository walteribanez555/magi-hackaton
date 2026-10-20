# magihub-mock — adaptador MagiHub (Bedrock **real** o **SIMULADO**)

Implementa el contrato que MagiCode necesita de MagiHub (`packages/contracts/src/magihub.ts`):
Smart Auto (`/v1/chat/completions`), consumo (`/v1/usage`) e identidad de key (`/v1/keys/self`).
Tiene dos proveedores, elegidos con `MAGIHUB_PROVIDER`:

| `MAGIHUB_PROVIDER` | Qué hace | Etiquetas |
|---|---|---|
| `mock` (default local) | Código **determinista** canned, tokens ≈ `ceil(chars/4)`, precios simulados. | `x-magihub-simulated: true` en **todas** las respuestas, `simulated: true` en completions y usage. La API (`MAGIHUB_MODE=mock`) marca todo como `provenance: "simulated"`. |
| `bedrock` (default en el stack CDK) | Inferencia **real** con Amazon Bedrock (Converse API). Tokens medidos por Bedrock. | `x-magihub-provider: bedrock`, sin flag ni header de simulado; `GET /v1/usage` ⇒ `simulated: false`. La API (`MAGIHUB_MODE=bedrock`) los marca reales con origen `bedrock`. |

## Rutas

| Ruta | Comportamiento |
|------|----------------|
| `POST /v1/chat/completions` | OpenAI-compatible. Acepta `model: "smart-auto"` (governance de la key; otro modelo ⇒ 403). Ver modos abajo. Soporta `stream: true` (SSE con chunk final de `usage`). |
| `GET /v1/keys/self` | Auth del gateway (ambos modos): keys `mh_demo_*` ⇒ `tenant_id: "demo-tenant"`, `key_id: "key_" + sha256(key)[:8]`, `governance.allowed_models: ["smart-auto"]`. Otras ⇒ 401. |
| `GET /v1/usage?from&to&granularity=request\|hour\|day` | `UsageResponse` con las completions guardadas de **esa** key. En `bedrock` solo devuelve registros reales; en `mock` solo los simulados (nunca se mezclan). |

### Modo `bedrock`

- **Smart Auto routing** (`src/bedrock.ts`):
  - prompt total (system + mensajes) < 1500 chars **y** sin señales de tarea grande
    (`refactor…`, `arquitectura`/`architecture`, `varios archivos`/`multiple files`, `multi-file`,
    `rediseño`, …) ⇒ `SMART_AUTO_FAST_MODEL`;
  - en otro caso ⇒ `SMART_AUTO_STRONG_MODEL`.
  - Headers informativos: `x-magihub-routed-model`, `x-magihub-route: fast:short_prompt | strong:long_prompt | strong:strong_signal`.
- **Mapeo OpenAI → Converse**: `system`/`developer` ⇒ `system`; `user`/`assistant` (`tool` ⇒ user)
  ⇒ `messages`, uniendo turnos consecutivos del mismo rol y descartando textos vacíos (Converse
  exige alternancia y empezar en `user`). `max_tokens`/`max_completion_tokens` (tope
  `SMART_AUTO_MAX_TOKENS`), `temperature`, `top_p` (solo sin `temperature`), `stop` (≤ 4).
- **Respuesta**: `id` = header `x-request-id` = `req_<requestId de Bedrock>`; `model` = inference
  profile enrutado; `usage` = `inputTokens`/`outputTokens`/`totalTokens` de Bedrock
  (+ `cacheReadInputTokens` como `cached_tokens`); `finish_reason` mapeado desde `stopReason`.
- **Streaming**: la Function URL responde en modo BUFFERED, así que `stream: true` invoca Converse
  completo y emite el resultado en chunks SSE (formato OpenAI). Mismos ids y usage.
- **Errores** (formato OpenAI `{ error: { message, type, code } }`): `ValidationException` ⇒ 400,
  `AccessDeniedException` ⇒ 403, `ThrottlingException`/`ServiceQuotaExceededException` ⇒ 429,
  timeout ⇒ 504, resto ⇒ 502. El SDK reintenta throttling/5xx (`BEDROCK_MAX_ATTEMPTS`, 3); cada
  llamada se aborta a los `BEDROCK_TIMEOUT_MS` (110 s, bajo el timeout de 120 s de la Lambda).
  Una completion fallida no se registra en el consumo.
- **Consumo**: cada completion se guarda con el usage real, `provider: "bedrock"`, modelo,
  latencia y `cost_usd`.

### Costos (`cost_usd`)

Tabla `PRICES_PER_MTOK` en `src/bedrock.ts` (USD por millón de tokens, por model ID).
**Fuente/supuesto:** precios on-demand públicos de Amazon Bedrock
(<https://aws.amazon.com/bedrock/pricing/>, revisados 2026-10, contexto ≤ 200K); los inference
profiles geográficos (`us.`) se asumen +10% sobre el global (`global.`). Fórmula:
`input·p_in + output·p_out + cached·p_cache_read`. Un modelo sin precio en la tabla
(p. ej. un override de env) ⇒ `cost_usd` se omite: nunca se inventa. Es una estimación de
lista; la factura de AWS es la fuente de verdad.

## Variables

| Variable | Default | Uso |
|---|---|---|
| `MAGIHUB_PROVIDER` | `mock` | `bedrock` \| `mock` |
| `SMART_AUTO_FAST_MODEL` | inference profile rápido (`DEFAULT_FAST_MODEL` en `src/bedrock.ts`) | modelo para prompts cortos/simples |
| `SMART_AUTO_STRONG_MODEL` | inference profile fuerte (`DEFAULT_STRONG_MODEL`) | modelo para prompts largos/complejos |
| `SMART_AUTO_MAX_TOKENS` | `4096` | `maxTokens` por defecto y tope |
| `SMART_AUTO_SHORT_PROMPT_CHARS` | `1500` | umbral de "prompt corto" |
| `BEDROCK_TIMEOUT_MS` / `BEDROCK_MAX_ATTEMPTS` / `BEDROCK_REGION` | `110000` / `3` / `AWS_REGION` | cliente Bedrock |
| `MOCK_TABLE_NAME` | — | DynamoDB para el consumo (`PK = MOCK#K#{key_id}`, `SK = REQ#{ts}#{request_id}`; puede ser la single-table). Sin ella: memoria. |
| `PORT`, `DYNAMO_ENDPOINT` | `4010`, — | local / dynamodb-local |
| `MOCK_USAGE_GRANULARITIES`, `MOCK_INGESTION_DELAY_MINUTES` | — | solo para simular un MagiHub sin granularidad por petición o con retraso de ingesta |

## Despliegue (infra/lib/magicode-stack.ts)

- Lambda `magicode-<env>-magihub-mock` (Node 22 ARM64, **120 s, 1024 MB**) expuesta por **Function
  URL** (`authType NONE`: el adaptador valida la key `mh_*` en `/v1/*`). Output `MagiHubUrl`:
  base URL única para la API (`MAGIHUB_BASE_URL`) y la extensión (`magicode.magihubBaseUrl`).
  El HTTP API previo (`MagiHubMockUrl`) sigue existiendo, pero corta a 30 s.
- `-c magihubProvider=bedrock|mock` (default `bedrock`). En bedrock el rol tiene
  `bedrock:InvokeModel` y `bedrock:InvokeModelWithResponseStream` (Converse/ConverseStream se
  autorizan con esas acciones) sobre los inference profiles de la cuenta **y** los foundation
  models subyacentes en `arn:aws:bedrock:*::foundation-model/…` (los profiles cross-region
  enrutan a varias regiones).

## Correr

```bash
npm run dev -w @magicode/magihub-mock                              # mock, puerto 4010
MAGIHUB_PROVIDER=bedrock AWS_REGION=us-east-1 npm run dev -w @magicode/magihub-mock   # Bedrock real (credenciales AWS locales)
# o: npm run build -w @magicode/magihub-mock && node services/magihub-mock/dist/main.js
```

## curl

```bash
MH=localhost:4010      # o el output MagiHubUrl
KEY=mh_demo_walter

curl -s $MH/v1/keys/self -H "Authorization: Bearer $KEY" | jq

curl -si $MH/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model":"smart-auto","messages":[{"role":"user","content":"Escribe la function sumPositive with unit test"}]}'
# bedrock → x-request-id: req_…  x-magihub-provider: bedrock  x-magihub-route: fast:short_prompt
# mock    → x-request-id: mhreq_…  x-magihub-simulated: true

curl -s "$MH/v1/usage?from=$(date -u -v-1H +%FT%TZ)&to=$(date -u +%FT%TZ)&granularity=request" \
  -H "Authorization: Bearer $KEY" | jq
# (Linux: date -u -d '-1 hour' +%FT%TZ)
```

Lambda: `src/index.ts` exporta `handler` (hono/aws-lambda; sirve Function URL y HTTP API v2).
Local: `src/main.ts` (@hono/node-server). Tests: `src/*.test.ts` (cliente Bedrock falso).
