# magihub-mock — MagiHub **SIMULADO**

> ⚠️ Este servicio **no es MagiHub**. Implementa el contrato que MagiCode necesita de MagiHub
> (`packages/contracts/src/magihub.ts`) para desarrollo local y demo. Todo lo que devuelve está
> etiquetado: header `x-magihub-simulated: true` en **todas** las respuestas, `simulated: true` en
> completions y usage. La API de MagiCode, con `MAGIHUB_MODE=mock`, marca todas las cifras de tokens
> como `provenance: "simulated"` / `source: "magihub-mock"`.

## Qué simula

| Ruta | Comportamiento |
|------|----------------|
| `POST /v1/chat/completions` | OpenAI-compatible. Acepta `model: "smart-auto"` (governance de la key). "Smart Auto" elige `mock-haiku` (< 600 chars de prompt) o `mock-sonnet`. Devuelve código **determinista** (mismo prompt ⇒ misma salida ⇒ mismo `output_hash`): función + test en TS, componente React, SQL, Python, tsconfig o una función genérica. `id` = header `x-request-id` = `mhreq_…`; `usage` ≈ `ceil(chars/4)`. Soporta `stream: true` (SSE con chunk final de `usage`). |
| `GET /v1/keys/self` | Keys que empiezan con `mh_demo_` ⇒ `tenant_id: "demo-tenant"`, `key_id: "key_" + sha256(key)[:8]`, `governance.allowed_models: ["smart-auto"]`. Otras ⇒ 401. |
| `GET /v1/usage?from&to&granularity=request\|hour\|day` | `UsageResponse` construido con las completions guardadas de **esa** key. `cost_usd` con precios simulados. |

Almacenamiento: en memoria por defecto; con `MOCK_TABLE_NAME` guarda en DynamoDB
(`PK = MOCK#K#{key_id}`, `SK = REQ#{ts}#{request_id}` — puede ser la misma single-table).

Variables opcionales: `PORT` (4010), `MOCK_TABLE_NAME`, `DYNAMO_ENDPOINT` (dynamodb-local),
`MOCK_USAGE_GRANULARITIES=hour,day` (simula un MagiHub sin granularidad por petición → la API cae a
atribución `estimated`), `MOCK_INGESTION_DELAY_MINUTES` (simula retraso de ingesta).

## Correr

```bash
npm run dev -w @magicode/magihub-mock          # tsx watch, puerto 4010
# o: npm run build -w @magicode/magihub-mock && node services/magihub-mock/dist/main.js
```

## curl

```bash
KEY=mh_demo_walter

curl -s localhost:4010/v1/keys/self -H "Authorization: Bearer $KEY" | jq

curl -si localhost:4010/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model":"smart-auto","messages":[{"role":"user","content":"Escribe la function sumPositive with unit test"}]}'
# → x-request-id: mhreq_…  x-magihub-routed-model: mock-haiku  x-magihub-simulated: true

curl -sN localhost:4010/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model":"smart-auto","stream":true,"messages":[{"role":"user","content":"componente React Counter"}]}'

curl -s "localhost:4010/v1/usage?from=$(date -u -v-1H +%FT%TZ)&to=$(date -u +%FT%TZ)&granularity=request" \
  -H "Authorization: Bearer $KEY" | jq
# (Linux: date -u -d '-1 hour' +%FT%TZ)
```

Lambda: `src/index.ts` exporta `handler` (hono/aws-lambda). Local: `src/main.ts` (@hono/node-server).
