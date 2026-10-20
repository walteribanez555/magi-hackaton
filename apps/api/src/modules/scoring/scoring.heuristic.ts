import type { FeatureVector, ScoringModel } from '@magicode/contracts';
import weightsJson from './heuristic-weights.json';
import type { HeuristicWeightsFile } from './scoring.types';

/**
 * Heurística determinista 'heuristic:v1' (fallback cuando no hay endpoint SageMaker).
 *
 * Es una regresión logística con pesos FIJOS y documentados en ml/heuristic_weights.json
 * (copiado aquí por ml/train.py). Son los MISMOS coeficientes que usa ml/generate_synthetic.py
 * como parte determinista de su proceso generativo, así que:
 *   - con datos sintéticos, la heurística es (casi) el "modelo verdadero" sin el latente ni ruido;
 *   - con datos reales, el XGBoost solo se despliega si la supera en AUC (train.py).
 *
 * Supuestos (signo de cada peso):
 *   survival ↓ redundancia, ↓ mecánico, ↓ regeneraciones;  ↑ core, ↑ logic, ↑ importancia,
 *            ↑ editado antes de aceptar, ↑ tasa de aceptación de la sesión, ↑ tarea, ↑ rama default.
 *   rework   ↑ core + logic + editado, ↑ tamaño, ↑↑ "grande y sin tests en core", ↑ tarea Bug,
 *            ↑ redundancia, ↑ regeneraciones, ↑ nocturno;  ↓ mecánico, ↓ tests, ↓ tasa de aceptación.
 * Espejo exacto de ml/heuristic.py.
 */

export const HEURISTIC_WEIGHTS = weightsJson as unknown as HeuristicWeightsFile;
export const HEURISTIC_VERSION = HEURISTIC_WEIGHTS.version; // 'heuristic:v1'

const LN21 = Math.log(21);
const LN41 = Math.log(41);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export const sigmoid = (z: number) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

/** Términos derivados (mismas definiciones que ml/heuristic.py → terms). */
export function heuristicTerms(f: FeatureVector): Record<string, number> {
  const log1pAdded = Math.log1p(Math.max(0, f.accepted_added_lines));
  const big = clamp01((log1pAdded - LN41) / 1.5);
  const hour = Math.trunc(f.hour_of_day);
  return {
    redundancy_score: f.redundancy_score,
    mechanical_share: f.mechanical_share,
    importance_score: f.importance_score,
    core_tier_share: f.core_tier_share,
    test_tier_share: f.test_tier_share,
    logic_kind_share: f.logic_kind_share,
    edited_before_accept_ratio: f.edited_before_accept_ratio,
    has_task: f.has_task,
    task_is_bug: f.task_is_bug,
    branch_is_default: f.branch_is_default,
    acceptance_centered: f.session_acceptance_rate - 0.6,
    log_added: log1pAdded - LN21,
    log_regen: Math.log1p(Math.max(0, f.regenerations)),
    large_untested_core: f.core_tier_share * big * (1 - f.test_tier_share) ** 2,
    late_night: hour >= 22 || hour <= 5 ? 1 : 0,
  };
}

/** Contribuciones al logit (peso × término) — sirven para top_factors del fallback. */
export function heuristicContributions(model: ScoringModel, f: FeatureVector): Record<string, number> {
  const t = heuristicTerms(f);
  const { coef } = HEURISTIC_WEIGHTS[model];
  return Object.fromEntries(Object.entries(coef).map(([k, w]) => [k, w * (t[k] ?? 0)]));
}

export function heuristicLogit(model: ScoringModel, f: FeatureVector): number {
  const c = heuristicContributions(model, f);
  return HEURISTIC_WEIGHTS[model].intercept + Object.values(c).reduce((a, b) => a + b, 0);
}

export const heuristicPredict = (model: ScoringModel, f: FeatureVector): number => sigmoid(heuristicLogit(model, f));

/**
 * Término heurístico → feature del contrato que lo origina (para nombrar top_factors).
 * `large_untested_core` no se renombra: es una interacción (core × tamaño × sin tests) y su
 * nombre ya la describe.
 */
export const TERM_FEATURE: Record<string, string> = {
  acceptance_centered: 'session_acceptance_rate',
  log_added: 'accepted_added_lines',
  log_regen: 'regenerations',
  late_night: 'hour_of_day',
};
