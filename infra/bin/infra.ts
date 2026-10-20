#!/usr/bin/env node
// CDK app entrypoint — un stack por entorno (dev/staging/prod) vía `-c environment=<env>`.
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { MagicodeStack } from '../lib/magicode-stack';

const app = new cdk.App();

const environment: string = app.node.tryGetContext('environment') ?? 'dev';

// ── MagiHub: mock SIMULADO (default) o API real ────────────────────────────────
// `-c deployMock=false -c magihubBaseUrl=https://...` apunta la API al MagiHub real y
// deja de desplegar el mock. Los valores de contexto por CLI llegan como string.
const deployMockCtx = app.node.tryGetContext('deployMock');
const deployMock = deployMockCtx === undefined ? true : String(deployMockCtx) !== 'false';
const magihubBaseUrl: string | undefined = app.node.tryGetContext('magihubBaseUrl') || undefined;

// Cuenta/región explícitas: la VPC resuelve las AZ reales (cdk.context.json).
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT, // lo resuelve el CLI con el perfil activo
  region:  process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

const main = new MagicodeStack(app, `MagicodeStack-${environment}`, {
  env,
  environment,
  deployMock,
  magihubBaseUrl,
  description: `MagiCode (${environment}): API + proyector Dynamo→RDS + dashboard + MagiHub mock`,
});

// ── Scoring XGBoost (SageMaker Serverless + reentrenamiento) — OPCIONAL ─────────
// Solo con `-c deployMl=true` (default false: sin datos no vale la pena el costo de
// SageMaker). La API siempre recibe los nombres de endpoint y cae a la heurística si no
// existen. `require` perezoso: el synth no depende de lib/ml-stack.ts si deployMl=false.
if (String(app.node.tryGetContext('deployMl') ?? 'false') === 'true') {
  // Tipado local (no `typeof import`) para que `tsc` no exija el archivo si aún no existe.
  type MlStackCtor = new (
    scope: cdk.App,
    id: string,
    props: cdk.StackProps & { environment: string; table: dynamodb.ITable },
  ) => cdk.Stack;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { MagicodeMlStack } = require('../lib/ml-stack') as { MagicodeMlStack: MlStackCtor };
  new MagicodeMlStack(app, `MagicodeMlStack-${environment}`, {
    env,
    environment,
    table: main.table,
  });
}
