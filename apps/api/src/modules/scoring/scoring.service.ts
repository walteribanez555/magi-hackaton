import {
  CRITICALITY_THRESHOLDS,
  keys,
  type ChangeScores,
  type Criticality,
  type FeatureVector,
  type ScoringModel,
} from '@magicode/contracts';
import { createRequire } from 'node:module';
import type { UpdateCommandInput } from '@aws-sdk/lib-dynamodb';
import { createLogger } from '../../config/logger';
import importanceJson from './feature-importance.json';
import { buildFeatures, toCsvRow } from './scoring.features';
import { HEURISTIC_VERSION, HEURISTIC_WEIGHTS, TERM_FEATURE, heuristicContributions, heuristicPredict } from './scoring.heuristic';
import type {
  EndpointInvoker,
  FeatureImportanceFile,
  ModelScores,
  ScoringChangeInput,
  ScoringContext,
  ScoringEnv,
} from './scoring.types';

/**
 * Scoring de cambios IA aceptados — mismo patrón que fraud-detector (aggregate-risk.handler):
 *   Primario — XGBoost en SageMaker Serverless (SCORING_SURVIVAL_ENDPOINT / SCORING_REWORK_ENDPOINT),
 *              CSV sin cabecera en el orden de SCORING_FEATURES.
 *   Fallback — heurística determinista 'heuristic:v1' ante CUALQUIER error, endpoint inexistente
 *              o timeout (presupuesto SCORING_TIMEOUT_MS, 300 ms por defecto).
 * Todo-o-nada: si cualquiera de los dos endpoints falla, ambos scores salen de la heurística
 * (un model_version mixto confundiría al dashboard).
 *
 * Criticidad (documentada en ml/README.md):
 *   exposure          = clamp01(0.5 × importance_score + 0.5 × tier_weight)
 *   criticality_score = rework_risk^0.7 × exposure^0.3      → umbrales CRITICALITY_THRESHOLDS
 *   (tier_weight = Σ share(tier) × DEFAULT_TIER_WEIGHTS[tier]; docs/generated ⇒ exposición baja)
 */

const logger = createLogger('Scoring');

export const IMPORTANCE = importanceJson as unknown as FeatureImportanceFile;
const DEFAULT_TIMEOUT_MS = 300;
const DEFAULT_COOLDOWN_MS = 60_000;
const r4 = (x: number) => Math.round(x * 10_000) / 10_000;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export function readScoringEnv(env: NodeJS.ProcessEnv = process.env): ScoringEnv {
  return {
    survivalEndpoint: env.SCORING_SURVIVAL_ENDPOINT ?? '',
    reworkEndpoint: env.SCORING_REWORK_ENDPOINT ?? '',
    trainedOn: env.SCORING_TRAINED_ON === 'real' ? 'real' : 'synthetic',
    modelVersion: env.SCORING_MODEL_VERSION || IMPORTANCE.model_version || 'unknown',
    timeoutMs: Number(env.SCORING_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    cooldownMs: Number(env.SCORING_COOLDOWN_MS) || DEFAULT_COOLDOWN_MS,
  };
}

// ── Cliente SageMaker Runtime (SDK v3 del runtime de Lambda) ──────────────────────────

/** Tipado mínimo local: @aws-sdk/client-sagemaker-runtime NO es dependencia del paquete. */
interface SageMakerRuntimeModule {
  SageMakerRuntimeClient: new (cfg: { maxAttempts?: number }) => {
    send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<{ Body?: Uint8Array }>;
  };
  InvokeEndpointCommand: new (input: {
    EndpointName: string;
    ContentType: string;
    Accept: string;
    Body: Uint8Array;
  }) => unknown;
}

type RuntimeClient = InstanceType<SageMakerRuntimeModule['SageMakerRuntimeClient']>;
let runtime: { mod: SageMakerRuntimeModule; client: RuntimeClient } | null = null;

/**
 * El runtime Node 22 de Lambda trae el SDK v3 completo y esbuild externaliza `@aws-sdk/*`.
 * Se carga con `require` perezoso (no con `import()`): en un bundle CJS `require` respeta
 * NODE_PATH, que en Lambda incluye /var/runtime/node_modules; la resolución ESM de `import()`
 * no lo hace. `require` de un string tampoco obliga a tsc a resolver el módulo (no está en
 * node_modules). En local/tests no está instalado → lanza → heurística.
 */
function loadRuntime(): { mod: SageMakerRuntimeModule; client: RuntimeClient } {
  if (!runtime) {
    const req: NodeJS.Require = typeof require === 'function' ? require : createRequire(__filename);
    const mod = req('@aws-sdk/client-sagemaker-runtime') as SageMakerRuntimeModule;
    runtime = { mod, client: new mod.SageMakerRuntimeClient({ maxAttempts: 1 }) };
  }
  return runtime;
}

export const sagemakerInvoker: EndpointInvoker = async (endpointName, csvBody, signal) => {
  const { mod, client } = loadRuntime();
  const res = await client.send(
    new mod.InvokeEndpointCommand({
      EndpointName: endpointName,
      ContentType: 'text/csv',
      Accept: 'text/csv',
      Body: new TextEncoder().encode(csvBody),
    }),
    { abortSignal: signal },
  );
  return new TextDecoder().decode(res.Body ?? new Uint8Array());
};

/** El contenedor XGBoost devuelve "0.123" (o "0.123\n" / "0.123,"). */
export function parseProbability(body: string): number {
  const p = Number.parseFloat(body.trim().split(/[\s,]+/)[0] ?? '');
  if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error(`Respuesta inesperada del endpoint: ${body.slice(0, 80)}`);
  return p;
}

// ── Criticidad y factores ──────────────────────────────────────────────────────────

export function criticalityFrom(reworkRisk: number, importanceScore: number, tierWeight: number): { score: number; level: Criticality } {
  const c = HEURISTIC_WEIGHTS.criticality;
  const exposure = clamp01(c.importance_weight * importanceScore + c.tier_weight * tierWeight);
  const score = clamp01(clamp01(reworkRisk) ** c.rework_exponent * exposure ** c.exposure_exponent);
  let level: Criticality = 'low';
  for (const [name, th] of Object.entries(CRITICALITY_THRESHOLDS).sort((a, b) => a[1] - b[1])) {
    if (score >= th) level = name as Criticality;
  }
  return { score: r4(score), level };
}

type Factor = ChangeScores['top_factors'][number];

/**
 * top_factors (explican rework_risk, la base de la criticidad):
 *  - XGBoost: gain normalizado × |desviación robusta de la mediana de train| (tabla estática
 *    feature-importance.json); dirección = signo de la desviación × dirección monótona aprendida.
 *    Aproximación barata (sin SHAP en línea), declarada como tal.
 *  - Heurística: contribuciones exactas del logit (peso × término).
 */
export function topFactors(v: FeatureVector, source: ModelScores['source'], model: ScoringModel = 'rework', n = 5): Factor[] {
  const table = IMPORTANCE.models?.[model]?.features;
  if (source === 'xgboost' && table?.length) {
    return table
      .map((e) => {
        const x = v[e.feature as keyof FeatureVector];
        const dev = typeof x === 'number' ? (x - e.median) / (e.scale || 1) : 0;
        const up = dev >= 0 === (e.direction === 'up');
        return { feature: e.feature, weight: e.gain * Math.abs(dev), direction: up ? 'up' : 'down' } as const;
      })
      .filter((f) => f.weight > 0)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, n)
      .map(({ feature, direction }) => ({ feature, direction }));
  }
  return Object.entries(heuristicContributions(model, v))
    .filter(([, c]) => c !== 0)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, n)
    .map(([term, c]) => ({ feature: TERM_FEATURE[term] ?? term, direction: c > 0 ? 'up' : 'down' }));
}

// ── Servicio ───────────────────────────────────────────────────────────────────────

export interface ScoreChangeInput {
  change: ScoringChangeInput;
  ctx?: ScoringContext;
}

export interface ScoringServiceDeps {
  /** null ⇒ nunca intenta SageMaker (solo heurística) */
  invoker?: EndpointInvoker | null;
  env?: () => ScoringEnv;
  now?: () => number;
}

export function createScoringService(deps: ScoringServiceDeps = {}) {
  const invoker = deps.invoker === undefined ? sagemakerInvoker : deps.invoker;
  const getEnv = deps.env ?? (() => readScoringEnv());
  const now = deps.now ?? Date.now;
  let disabledUntil = 0;

  async function invokeModels(v: FeatureVector, env: ScoringEnv): Promise<ModelScores | null> {
    if (!invoker || !env.survivalEndpoint || !env.reworkEndpoint) return null;
    if (now() < disabledUntil) return null;

    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort();
        reject(new Error(`timeout ${env.timeoutMs} ms`));
      }, env.timeoutMs);
    });
    const csv = toCsvRow(v);
    try {
      const [s, r] = await Promise.race([
        Promise.all([
          invoker(env.survivalEndpoint, csv, ctrl.signal).then(parseProbability),
          invoker(env.reworkEndpoint, csv, ctrl.signal).then(parseProbability),
        ]),
        timeout,
      ]);
      return { survival: s, rework: r, source: 'xgboost' };
    } catch (err) {
      disabledUntil = now() + env.cooldownMs;
      logger.warn('SageMaker scoring falló — heurística (circuit breaker abierto)', {
        error: String(err),
        cooldown_ms: env.cooldownMs,
      });
      return null;
    } finally {
      clearTimeout(timer);
      ctrl.abort();
    }
  }

  async function scoreChange(input: ScoreChangeInput): Promise<ChangeScores> {
    const env = getEnv();
    const { vector, tier_weight } = buildFeatures(input.change, input.ctx);
    const ml = await invokeModels(vector, env);
    const m: ModelScores = ml ?? {
      survival: heuristicPredict('survival', vector),
      rework: heuristicPredict('rework', vector),
      source: 'heuristic',
    };
    const crit = criticalityFrom(m.rework, vector.importance_score, tier_weight);
    return {
      survival_probability: r4(clamp01(m.survival)),
      rework_risk: r4(clamp01(m.rework)),
      criticality: crit.level,
      criticality_score: crit.score,
      model_version: m.source === 'xgboost' ? `xgboost:${env.modelVersion}` : HEURISTIC_VERSION,
      // heurística = estimación declarada; XGBoost hereda la procedencia de sus datos de entrenamiento
      provenance: m.source === 'heuristic' ? 'estimated' : env.trainedOn === 'real' ? 'estimated' : 'simulated',
      top_factors: topFactors(vector, m.source),
    };
  }

  return {
    scoreChange,
    /** solo tests */
    resetCircuit: () => {
      disabledUntil = 0;
    },
  };
}

export type ScoringService = ReturnType<typeof createScoringService>;
export const scoringService: ScoringService = createScoringService();

// ── Hook para productivity (code.accepted) ───────────────────────────────────────────

/** Forma mínima del contexto que productivity pasa a su hook (AcceptedChangeContext). */
export interface AcceptedEventLike {
  tenant_id: string;
  session_id: string;
  change_id: string;
  event: {
    occurred_at: string;
    branch?: string;
    task_key?: string;
    payload: Pick<ScoringChangeInput, 'files' | 'accepted_added_lines' | 'accepted_deleted_lines' | 'dimensions'>;
  };
}

/** Adapta el evento code.accepted al input de scoring. */
export const scoringInputFromAcceptedEvent = (a: AcceptedEventLike): ScoringChangeInput => ({
  tenant_id: a.tenant_id,
  session_id: a.session_id,
  change_id: a.change_id,
  files: a.event.payload.files,
  accepted_added_lines: a.event.payload.accepted_added_lines,
  accepted_deleted_lines: a.event.payload.accepted_deleted_lines,
  dimensions: a.event.payload.dimensions,
  branch: a.event.branch,
  task_key: a.event.task_key,
  occurred_at: a.event.occurred_at,
});

export interface OnChangeAcceptedOptions extends ScoringContext {
  tableName?: string;
  /** ISO de escritura (default: ahora) */
  nowIso?: string;
}

/**
 * Calcula las puntuaciones y devuelve los parámetros del UpdateCommand que persiste `scores`
 * en el ítem Change (no escribe: el llamador decide si lo manda solo o en una transacción).
 */
export async function onChangeAccepted(
  change: ScoringChangeInput,
  opts: OnChangeAcceptedOptions = {},
  service: ScoringService = scoringService,
): Promise<{ scores: ChangeScores; update: UpdateCommandInput }> {
  const { tableName, nowIso, ...ctx } = opts;
  const scores = await service.scoreChange({ change, ctx });

  let Key: { PK: string; SK: string };
  if (change.PK && change.SK) Key = { PK: change.PK, SK: change.SK };
  else if (change.tenant_id && change.session_id && change.change_id)
    Key = keys.change(change.tenant_id, change.session_id, change.change_id);
  else throw new Error('onChangeAccepted: faltan PK/SK o tenant_id + session_id + change_id');

  const now = nowIso ?? new Date().toISOString();
  return {
    scores,
    update: {
      TableName: tableName ?? process.env.TABLE_NAME ?? 'magicode-dev-productivity',
      Key,
      UpdateExpression: 'SET #scores = :scores, #scored_at = :now, #updated_at = :now',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeNames: { '#scores': 'scores', '#scored_at': 'scored_at', '#updated_at': 'updated_at' },
      ExpressionAttributeValues: { ':scores': scores, ':now': now },
    },
  };
}
