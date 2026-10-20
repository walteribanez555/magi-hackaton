import { z } from 'zod';
import { Provenance } from './provenance.js';

/**
 * Puntuaciones con XGBoost (mismo patrón que walteribanez555/fraud-detector: ml/train.py →
 * SageMaker Serverless si mejora el AUC; la Lambda invoca el endpoint y cae a una heurística
 * determinista si no hay endpoint). Ver ml/README.md y docs/kb/.
 *
 * Modelos:
 * - survival: P(un cambio IA aceptado llega a la versión de referencia / despliegue).
 * - rework:   P(el cambio requiere retrabajo: líneas reescritas/borradas en ≤14 días o tarea Bug
 *             enlazada a los mismos archivos) → base de la CRITICIDAD.
 */

/** Vector de features (orden fijo = orden de columnas del modelo). */
export const SCORING_FEATURES = [
  'accepted_added_lines',
  'accepted_deleted_lines',
  'files_count',
  'importance_score',
  'redundancy_score',
  'mechanical_share',
  'effective_lines',
  'edited_before_accept_ratio',
  'core_tier_share',
  'test_tier_share',
  'logic_kind_share',
  'test_kind_share',
  'tokens_total',
  'tokens_per_effective_line',
  'regenerations',
  'latency_ms',
  'session_acceptance_rate',
  'has_task',
  'task_is_bug',
  'branch_is_default',
  'hour_of_day',
] as const;
export type ScoringFeature = (typeof SCORING_FEATURES)[number];
export type FeatureVector = Record<ScoringFeature, number>;

export const ScoringModel = z.enum(['survival', 'rework']);
export type ScoringModel = z.infer<typeof ScoringModel>;

export const Criticality = z.enum(['low', 'medium', 'high', 'critical']);
export type Criticality = z.infer<typeof Criticality>;

export const ChangeScores = z.object({
  survival_probability: z.number().min(0).max(1),
  rework_risk: z.number().min(0).max(1),
  /** combina rework_risk × importancia × tier del archivo (ver docs/kb/criticidad.md) */
  criticality: Criticality,
  criticality_score: z.number().min(0).max(1),
  /** "xgboost:<version>" o "heuristic:v1" si no hay endpoint */
  model_version: z.string(),
  /** estimated si es el modelo real entrenado con datos reales; simulated si se entrenó con sintéticos */
  provenance: Provenance,
  /** top features que más empujaron la predicción (SHAP aprox. / gain), solo nombres + signo */
  top_factors: z.array(z.object({ feature: z.string(), direction: z.enum(['up', 'down']) })).max(5),
});
export type ChangeScores = z.infer<typeof ChangeScores>;

/** Umbrales de criticidad sobre criticality_score. */
export const CRITICALITY_THRESHOLDS: Record<Criticality, number> = {
  low: 0,
  medium: 0.35,
  high: 0.6,
  critical: 0.8,
};
