# MagiCode — infraestructura (AWS CDK)

Proyecto CDK independiente (**no** es workspace del monorepo: tiene su propio
`package.json` y `package-lock.json`). Región `us-east-1`; la cuenta sale del perfil AWS activo.
Un stack por entorno: `MagicodeStack-<env>` (`-c environment=dev|staging|prod`, default `dev`).

## Arquitectura

```
                       ┌──────────────────────────── CloudFront (OAC) ──────────┐
  Navegador ─────────► │ dashboard Angular (S3 privado)  + /config.json {apiUrl}│
      │                └────────────────────────────────────────────────────────┘
      │ fetch(apiUrl)
      ▼
  HTTP API magicode-<env>-api ──► ApiFn (Lambda, fuera de VPC) ──► MagiHub
  (CORS, throttling 50/25,            │   │                         (real, o mock SIMULADO:
   access logs)                       │   │                          HTTP API + Lambda
  Extensión IDE ─────────────────────►┘   │                          magicode-<env>-magihub-mock)
  Webhooks POST /api/v1/webhooks/…        │  sagemaker:InvokeEndpoint (opcional, MagicodeMlStack)
                                          ▼
                     DynamoDB magicode-<env>-productivity  (single-table, PK/SK + GSI1, TTL expires_at)
                                          │ stream NEW_AND_OLD_IMAGES
  ┌───────────── VPC (2 AZ, sin NAT) ─────┼──────────────────────────────────────────────┐
  │  subredes PUBLIC: vacías (bastion futuro)                                            │
  │  subredes PRIVATE_ISOLATED:           ▼                                              │
  │     ProjectorFn (Lambda) ── batch 100, bisect, 3 reintentos ──► DLQ SQS              │
  │          │                                                                           │
  │     MigratorFn (Lambda, trigger en cada deploy) ──┐                                  │
  │          │ 5432 (TLS, SG→SG)                      │                                  │
  │          ▼                                        ▼                                  │
  │     RDS PostgreSQL 16.15 db.t4g.micro      VPC endpoint Secrets Manager (1 AZ)       │
  │     (privada, cifrada, rds.force_ssl=1)    VPC endpoint gateway DynamoDB (gratis)    │
  └──────────────────────────────────────────────────────────────────────────────────────┘
        credenciales: Secrets Manager `magicode/<env>/db` (usuario magicode_admin)
```

- **DynamoDB** es el store operativo primario del MVP (momentáneo).
- **RDS PostgreSQL** es una réplica analítica alimentada por el stream (proyector);
  a futuro pasa a ser el store primario. El migrador aplica el esquema en cada deploy
  que cambie su código (`aws-cdk-lib/triggers`, después de la BD).
- **TaskSyncFn** (`magicode-<env>-task-sync`, fuera de VPC): write-back a Jira (outbox).
  Consume del mismo stream solo ítems `OutboxAction` con `status=pending` (filtro en el
  poller, LATEST, batch 10, 5 reintentos, DLQ SQS). Tokens de integraciones en Secrets
  Manager `magicode/<env>/integrations/*` (la API los crea; task-sync los lee).
- El proyector filtra en el poller `OutboxAction`/`ActionIdem`/`WebhookDelivery` (no van a Postgres).

## Por qué la RDS es privada (a diferencia de coolfix)

En coolfix la RDS ya existía, era pública con TLS y las Lambdas iban fuera de VPC.
Aquí la BD es nueva y la gestiona este stack, así que la ponemos en subredes
**PRIVATE_ISOLATED**: sin IP pública y con el puerto 5432 abierto solo al SG de las
Lambdas en VPC. Para no pagar un NAT Gateway (~US$33/mes), las Lambdas en VPC usan
un endpoint gateway de DynamoDB (gratis) y **un único** endpoint interface de Secrets
Manager en una sola AZ. La API no va en VPC: necesita internet para MagiHub y no
toca Postgres. Para consultas ad-hoc, añadir un bastion (o SSM) en la subred pública.

## Costo estimado (us-east-1, dev, tráfico de demo)

| Recurso                                   | US$/mes aprox. |
|-------------------------------------------|---------------:|
| RDS db.t4g.micro single-AZ (730 h)        | ~11.7–12.5     |
| RDS 20 GB gp3                             | ~2.3           |
| VPC endpoint interface Secrets Manager ×1 | ~7.3           |
| Secreto Secrets Manager                   | 0.40           |
| DynamoDB on-demand + PITR + stream        | ~0             |
| Lambda / API Gateway / SQS                | ~0 (free tier) |
| S3 + CloudFront                           | ~0             |
| CloudWatch Logs (2 semanas)               | < 1            |
| **Total**                                 | **~US$22–24**  |

Sin NAT Gateway ni IPv4 públicas en uso. El stack opcional de ML (SageMaker) no está
incluido (solo se despliega con `-c deployMl=true`).

## Comandos

```bash
cd infra
npm ci
npx tsc --noEmit
npx jest
npx cdk synth MagicodeStack-dev -c environment=dev
npx cdk diff  MagicodeStack-dev -c environment=dev
npx cdk deploy MagicodeStack-dev -c environment=dev
npx cdk destroy MagicodeStack-dev -c environment=dev
```

- `cdk synth`/`deploy` empaquetan las Lambdas con esbuild (devDependency de `infra/`)
  desde la raíz del monorepo (`projectRoot`/`package-lock.json` raíz). Hay que tener
  instaladas las dependencias del monorepo (`npm ci` en la raíz).
- El dashboard (`apps/dashboard/dist/dashboard/browser`) solo se sube si existe al
  sintetizar: compilar Angular **antes** de `cdk deploy`. `/config.json`
  (`{ "apiUrl", "environment" }`) se escribe siempre y se invalida CloudFront.
  Si en el futuro el dashboard se publica con `aws s3 sync --delete`, excluir `config.json`.
- `destroy` en dev: la tabla y el bucket se borran; la RDS deja un snapshot final
  (removal `SNAPSHOT`). Las ENI de las Lambdas en VPC pueden tardar ~20 min en liberarse.
- Bootstrap: la cuenta ya tiene `CDKToolkit` (versión 32).

## MagiHub real vs. mock

Por defecto se despliega el MagiHub **SIMULADO** (tag `simulated=true`) y la API
recibe `MAGIHUB_BASE_URL=<url del mock>` y `MAGIHUB_MODE=mock`. Para apuntar al real:

```bash
npx cdk deploy MagicodeStack-dev -c environment=dev \
  -c magihubBaseUrl=https://<magihub-real> -c deployMock=false
```

(`MAGIHUB_MODE=real`.) También se puede pasar `magihubBaseUrl` manteniendo el mock
desplegado (`deployMock` por defecto `true`).

## Scoring XGBoost (opcional)

`-c deployMl=true` agrega `MagicodeMlStack-<env>` (`lib/ml-stack.ts`) con los endpoints
SageMaker Serverless `magicode-<env>-survival` / `magicode-<env>-rework`. La API ya tiene
esas variables y permiso `sagemaker:InvokeEndpoint` sobre `endpoint/magicode-<env>-*`;
si los endpoints no existen, usa la heurística local.

## Outputs

`ApiUrl`, `WebhookBaseUrl`, `MagiHubMockUrl`, `DashboardUrl`, `DashboardBucket`,
`DistributionId`, `TableName`, `TableStreamArn`, `DbEndpoint`, `DbSecretArn`, `VpcId`.
