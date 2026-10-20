# @magicode/api — backend de productividad MagiCode

Hono sobre AWS Lambda (HTTP API Gateway v2), DynamoDB single-table (`packages/contracts/src/keys.ts`)
y réplica analítica en PostgreSQL (RDS) alimentada por DynamoDB Streams. Relaciona el consumo **real**
de MagiHub (por API key + intervalo) con el código IA que se acepta → commitea → llega a una
versión de referencia (`docs/metrics-model.md`).

Reglas que el código hace cumplir:

- **Tenant y key salen de la API key** (MagiHub `GET /v1/keys/self`). Cualquier `tenant_id` del cuerpo se descarta.
- La API key cruda vive solo en el contexto de la petición (para consultar el usage de *esa* key). Se guarda/loguea únicamente `key_id` y la huella `sha256(key)[:12]`. Los logs JSON redactan `Authorization` y valores con forma de key.
- Nunca se guardan prompts ni código: los eventos solo traen IDs, rutas, conteos y hashes.
- **Toda cifra es `Measured`** (`value` + `provenance` real/estimated/simulated + `source`). `MAGIHUB_MODE=mock` ⇒ todo token es `simulated`/`magihub-mock`; eventos `source: demo-seed` ⇒ `simulated`.

## Estructura

```
src/
  index.ts            handler Lambda de la API (hono/aws-lambda)        ← CDK entry
  projector.ts        handler DynamoDB Streams → PostgreSQL               ← CDK entry
  migrator.ts         handler de migraciones (CDK Trigger)                ← CDK entry
  main.ts             servidor local (@hono/node-server, :3000)
  app.ts / app.types.ts   app Hono, rutas, AppEnv (identity, tenant_id, key_id, key_fingerprint, apiKey, requestId, logger)
  config/             config (singleton perezoso + reload), secrets (APP_SECRET_ARN), logger JSON, dynamo, database (pg)
  common/             exceptions + handleException, middlewares (auth, request-logger), utils (hash, time, dynamo-expr)
  modules/
    magihub/          MagiHubClient + HttpMagiHubClient (fetch + timeout + validación con contracts)
    productivity/     eventos → proyecciones (projection.ts), métricas puras (metrics.ts), lecturas
    usage/            snapshots del usage de MagiHub (sync + caché de 5 min)
    (integrations, webhooks, tasks, branches, pull-requests, scoring, task-sync: otros módulos)
  orm/                migration-runner, migrations.ts (GENERADO), migrate.ts (CLI)
  projector/          mapper item Dynamo → fila SQL + UPSERT
migrations/001_init.sql   esquema de la réplica (fuente de verdad del SQL)
```

## Correr en local

```bash
# 0) dependencias (desde la raíz del monorepo)
docker compose up -d dynamodb-local postgres
npm run build -w @magicode/contracts

# 1) tabla single-table en dynamodb-local (PK/SK, GSI1 ALL, stream, TTL expires_at)
npm run create-table -w @magicode/api            # --recreate para empezar de cero

# 2) MagiHub SIMULADO en :4010
npm run dev -w @magicode/magihub-mock

# 3) API en :3000 (cp apps/api/.env.example apps/api/.env)
npm run dev -w @magicode/api

# 4) caso de ejemplo: 2 sesiones de demo + resumen impreso
npm run seed:demo

# 5) (opcional) réplica analítica
npm run migrate -w @magicode/api                  # up | migrate:down | migrate:status
```

## Variables de entorno

| Variable | Default | Uso |
|---|---|---|
| `TABLE_NAME` | `magicode-dev-productivity` | single-table DynamoDB |
| `DYNAMO_ENDPOINT` | — | solo local (`http://localhost:8000`) |
| `APP_ENV` | `development` | development \| staging \| production |
| `CORS_ORIGINS` | `*` | lista separada por comas |
| `LOG_LEVEL` | debug (prod: info) | debug \| info \| warn \| error |
| `MAGIHUB_BASE_URL` | `http://localhost:4010` | base de MagiHub (o del mock) |
| `MAGIHUB_MODE` | `mock` | `real` \| `mock` (mock ⇒ tokens `simulated`) |
| `MAGIHUB_USAGE_PATH` / `MAGIHUB_KEYS_SELF_PATH` | `/v1/usage` / `/v1/keys/self` | paths reales configurables |
| `MAGIHUB_TIMEOUT_MS` | `5000` | timeout de cada llamada |
| `AUTH_CACHE_TTL_SECONDS` | `300` | caché en memoria de whoami |
| `USAGE_STALE_SECONDS` | `300` | frescura de snapshots de usage |
| `USAGE_MAX_WINDOW_DAYS` | `90` | ventana máxima de consulta |
| `APP_SECRET_ARN` | — | JSON plano mezclado en `process.env` al cold start |
| `DB_SECRET_ARN` | — | secreto RDS `{host,port,username,password,dbname}` (projector/migrator) |
| `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_NAME`/`DB_SSL` | localhost… | Postgres local (`DB_SSL=false`) |

## Endpoints (`/api/v1`, `Authorization: Bearer <MagiHub API key>` salvo indicación)

Respuestas `{ data, meta? }` (`ApiResponse`); errores `{ statusCode, message, code?, details? }` (`ApiError`).

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | **sin auth**; ok + modo MagiHub (no toca Dynamo) |
| GET | `/whoami` | `KeyIdentity` + `key_fingerprint` (nunca la key) |
| POST | `/productivity/events` | `EventsRequest` (1 evento o `{events:[≤25]}`) → **202** `EventsResponse`. Idempotente por `event_id` (duplicados se cuentan, no fallan) |
| GET | `/productivity/summary` | `?project_id&repository&session_id&task_key&branch&from&to&refresh=true` → `ProductivitySummary` |
| GET | `/productivity/timeline` | mismos filtros + `bucket=hour\|day` → `TimelinePoint[]` |
| GET | `/productivity/projects` | `{ project_id, repositories[], last_activity_at }[]` |
| GET | `/productivity/sessions` | `?project_id&from&to…` → `SessionListItem[]` |
| GET | `/productivity/sessions/:id` | `SessionListItem & { changes: ChangeListItem[] }` |
| GET | `/productivity/changes` | `?session_id` \| `?project_id` → `ChangeListItem[]` |
| GET | `/productivity/commits` | `?repository&from&to` → commits con `automation`, `reference_tags`, `task_keys` |
| GET | `/usage` | `?from&to&granularity` → `UsageResponse` desde snapshots (auto-sync si faltan o > 5 min) |
| POST | `/usage/sync` | `?from&to` → fuerza lectura a MagiHub y guarda snapshots |
| * | `/integrations`, `/tasks`, `/branches`, `/pull-requests` | módulos de multitenancy enlazado (auth Bearer) |
| POST | `/webhooks/:provider/:integrationId` | **sin Bearer**: firma HMAC de la integración |

Defaults: `to = now`, `from = now − 7 d` (usage: 1 d).

## Cómo se calcula (resumen)

- **Ingesta** (`productivity.projection.ts`): por evento, una `TransactWrite` con `EventDedupe`
  (`attribute_not_exists`, TTL `expires_at` 30 d) + `RawEvent` + upsert de `Session`/`Project`
  (+ `Branch` y `TaskLink` si hay rama/tarea) + la entidad (`AiRequest`, `Change`, `Commit`, `Reference`).
  Los cambios siguen una máquina de estados **monótona** (`proposed → accepted|rejected → committed → in_reference`):
  se lee el estado previo (BatchGet o caché del lote) y nunca retrocede aunque los eventos lleguen desordenados.
  Un commit crea/actualiza sus `change_ids`; una referencia marca `in_reference` los cambios de los commits
  incluidos (y `deployed_at` si `kind=deployment`). Si la transacción supera 100 ítems, las actualizaciones
  derivadas (idempotentes) van primero en lotes y el núcleo con el dedupe al final.
- **Tokens** (`usage`): `sync` pide `granularity=request` (si MagiHub no la soporta → `hour`) para
  `[from, min(to, now)]` con la key del usuario y guarda `UsageSnapshot` (`U#{g}#{ts}#{request_id|model}`) +
  marcador de cobertura (`U#sync#latest`).
- **Métricas** (`productivity.metrics.ts`, puro y testeado): `docs/metrics-model.md §3`. `total` = API de consumo
  (alcance de toda la key: suma; con filtros: por `request_id` si hay granularidad request, si no prorrateo de
  cada ventana por el usage reportado ⇒ `estimated`). Sin datos de consumo ⇒ fallback Σ usage reportado
  (`estimated`). `tokens/100 líneas` y `/100 efectivas` por etapa (`null` si el denominador es 0),
  `attribution = exact` solo si todos los request_id del alcance aparecen en el usage por petición.
  *Desplegado* solo cuenta `reference.marked{kind=deployment}` (con `evidence_url`) o commits con un
  `Deployment` en estado `success` (webhook).
- **Projector** (`projector.ts`): Streams `NEW_AND_OLD_IMAGES` → UPSERT por PK guardado por `updated_at`
  (reintentos/desorden no corrompen). Omite `EventDedupe`, `RawEvent`, marcador de sync y entidades sin tabla.
  Corta en el primer fallo y lo reporta en `batchItemFailures` (requiere `reportBatchItemFailures`).
- **Migraciones**: `migrations/*.sql` es la fuente; `npm run migrations:gen` las embebe en
  `src/orm/migrations.ts` (un test falla si no están sincronizadas). Así el SQL viaja en el bundle de
  CDK `NodejsFunction` sin loaders. `migrator.ts` aplica pendientes con `pg_advisory_lock` y lanza si falla.

## Build y tests

```bash
npm run build -w @magicode/api        # dist/index.js, projector.js, migrator.js, main.js (@aws-sdk externo en Lambda)
npm run check-types -w @magicode/api
npm test -w @magicode/api
```

## Limitaciones

- El resumen se calcula leyendo las particiones de sesión (máx. 200 sesiones por consulta, retrospectiva de 7 días
  sobre `started_at`); para analítica pesada usar la réplica PostgreSQL.
- Las sesiones/resúmenes se filtran por la **key que consulta** (los tokens son de esa key): usar una API key dedicada por demo/equipo.
- Las transiciones de estado son "leer y escribir": dos peticiones simultáneas sobre el mismo cambio pueden dejar
  un `status` menos avanzado durante una carrera (los timestamps por etapa sí quedan).
- `last_activity_at` de la sesión se toma del último evento procesado (no del más reciente si llegan desordenados entre lotes).
- La referencia se cuenta por sesión (última referencia de cada sesión); las líneas supervivientes y la
  coincidencia por hash son aproximadas (`estimated`).
- Los cambios de un commit se asumen de la misma sesión del evento `git.committed`.
- La caché de identidad es por contenedor Lambda (5 min); revocar una key en MagiHub tarda hasta 5 min en reflejarse.
