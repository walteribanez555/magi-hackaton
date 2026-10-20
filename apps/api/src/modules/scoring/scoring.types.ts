import type { ChangeDimensions, ChangeScores, Criticality, FeatureVector, FileChange, ScoringModel } from '@magicode/contracts';

/**
 * Cambio a puntuar. Acepta el ítem Change de DynamoDB (productivity → `accepted_files`,
 * `accepted_at`, `dimensions`) o el payload de `code.accepted` (`files`, `occurred_at`).
 * Solo conteos, rutas y ratios: nunca código.
 */
export interface ScoringChangeInput {
  PK?: string;
  SK?: string;
  tenant_id?: string;
  session_id?: string;
  change_id?: string;
  files?: FileChange[];
  accepted_files?: FileChange[];
  accepted_added_lines?: number;
  accepted_deleted_lines?: number;
  dimensions?: ChangeDimensions;
  /** variantes aplanadas (ChangeListItem) */
  importance_score?: number;
  redundancy_score?: number;
  mechanical_share?: number;
  effective_lines?: number;
  branch?: string | null;
  task_key?: string | null;
  occurred_at?: string;
  accepted_at?: string;
  first_seen_at?: string;
}

/** Contexto de sesión / petición IA que NO está en el ítem Change. */
export interface ScoringContext {
  /** tokens imputados al cambio: Σ total_tokens de la petición + su cadena de regeneraciones */
  tokens_total?: number;
  /** nº de regeneraciones previas de la petición (cadena `regenerates`) */
  regenerations?: number;
  latency_ms?: number;
  /** aceptados / propuestos en la sesión hasta este cambio (0..1) */
  session_acceptance_rate?: number;
  /** tipo de la tarea Jira (Story/Bug/Task…) si se conoce */
  task_type?: string | null;
  /** rama default del repo si se conoce (si no: main/master/develop/trunk) */
  default_branch?: string | null;
}

/** Features + auxiliares que no van al modelo pero sí a la criticidad. */
export interface BuiltFeatures {
  vector: FeatureVector;
  /** Σ share(tier) × DEFAULT_TIER_WEIGHTS[tier] (0..1) */
  tier_weight: number;
}

/** Invoca un endpoint SageMaker con CSV y devuelve el cuerpo de la respuesta (texto). */
export type EndpointInvoker = (endpointName: string, csvBody: string, signal: AbortSignal) => Promise<string>;

export interface ScoringEnv {
  survivalEndpoint: string;
  reworkEndpoint: string;
  /** 'synthetic' (default) ⇒ provenance 'simulated'; 'real' ⇒ 'estimated' */
  trainedOn: 'synthetic' | 'real';
  modelVersion: string;
  timeoutMs: number;
  /** tras un fallo del endpoint, no reintentar durante este tiempo (circuit breaker) */
  cooldownMs: number;
}

export interface ModelScores {
  survival: number;
  rework: number;
  source: 'xgboost' | 'heuristic';
}

/** Tabla estática exportada por ml/train.py (feature-importance.json). */
export interface FeatureImportanceEntry {
  feature: string;
  gain: number;
  median: number;
  scale: number;
  direction: 'up' | 'down';
}
export interface FeatureImportanceFile {
  model_version: string;
  trained_on: 'synthetic' | 'real';
  xgboost_version: string;
  features: string[];
  models: Partial<Record<ScoringModel, { auc: number; features: FeatureImportanceEntry[] }>>;
}

/** Pesos de la heurística (copia de ml/heuristic_weights.json). */
export interface HeuristicWeightsFile {
  version: string;
  survival: { intercept: number; coef: Record<string, number> };
  rework: { intercept: number; coef: Record<string, number> };
  criticality: {
    rework_exponent: number;
    exposure_exponent: number;
    importance_weight: number;
    tier_weight: number;
  };
}

export type { ChangeScores, Criticality, FeatureVector };
