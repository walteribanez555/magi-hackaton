# MagiCode · token-tracker

Monorepo de **MagiCode**, la respuesta al reto MagiHub: un IDE conectado a MagiHub Smart Auto y un
módulo de productividad que responde

> ¿Cuántos tokens consumimos mediante MagiHub para producir cambios de código que se aceptan, se
> registran en Git y llegan a una versión de referencia o despliegue?

Gestionado con Turborepo + npm workspaces (mismo patrón que coolfix-v2). Estado: **en construcción**.

## Estructura

| Parte | Ruta | Qué es |
| --- | --- | --- |
| Contratos | [`packages/contracts`](packages/contracts) | Esquemas zod compartidos: eventos, embudo, aristas, multitenant, webhooks, respuesta a Jira, scoring, claves DynamoDB, rutas |
| Métricas | [`packages/metrics`](packages/metrics) | Análisis local de cambios (importancia, redundancia, automatización) con hashes HMAC; nunca envía código |
| API | [`apps/api`](apps/api) | Hono sobre Lambda (estructura de coolfix-v2): eventos, resumen, uso MagiHub, proyector a RDS, migrador, task-sync |
| Extensión | [`apps/extension`](apps/extension) | Extensión de VS Code MagiCode: Smart Auto, diff, aceptar, telemetría, Git, versión de referencia |
| Dashboard | [`apps/dashboard`](apps/dashboard) | Angular 21 (patrón de dashboards coolfix-v2) |
| Mock MagiHub | [`services/magihub-mock`](services/magihub-mock) | **Simulado**: Smart Auto + usage + keys/self para dev y demo |
| ML | [`ml/`](ml) | XGBoost (supervivencia y retrabajo → criticidad), patrón fraud-detector |
| Infra | [`infra/`](infra) | AWS CDK: DynamoDB, RDS PostgreSQL privada, Lambdas, HTTP API, S3 + CloudFront |
| Docs | [`docs/`](docs) | Modelo de métricas, integraciones y guía (KB) |
| Demo | [`examples/demo-repo`](examples/demo-repo) | Repositorio semilla para la demo (`scripts/init-demo-repo.sh`) |

## Empezar

```bash
npm install
npm run build          # turbo: contracts → metrics → apps
npm test
docker compose up -d   # dynamodb-local + postgres
```

Detalles por parte en el README de cada carpeta. Modelo de métricas: [`docs/metrics-model.md`](docs/metrics-model.md).

## Honestidad de datos

Cada cifra declara su procedencia: **real**, **estimada** o **simulada**. Con el mock de MagiHub,
todos los tokens se marcan como simulados.
