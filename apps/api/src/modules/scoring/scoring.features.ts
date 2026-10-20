import { DEFAULT_TIER_WEIGHTS, SCORING_FEATURES, type FileChange, type FileTier } from '@magicode/contracts';
import { fileTier } from '@magicode/metrics';
import type { BuiltFeatures, FeatureVector, ScoringChangeInput, ScoringContext } from './scoring.types';

/**
 * Vector de features de UN cambio aceptado, en el orden de SCORING_FEATURES (= columnas del
 * modelo XGBoost). Espejo exacto de ml/features.py → build_feature_row (ver definiciones allí
 * y en ml/README.md). Cualquier cambio aquí debe replicarse en Python y reentrenar.
 */

const DEFAULT_BRANCHES = new Set(['main', 'master', 'develop', 'trunk']);
const BUG_TYPES = new Set(['bug', 'defect', 'incident', 'hotfix']);
/** Imputación si falta session_acceptance_rate (igual en ml/features.py). */
export const NEUTRAL_ACCEPTANCE = 0.6;

const num = (v: unknown, fallback = 0): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const ratio = (a: number, b: number) => (b > 0 ? a / b : 0);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export const changeFiles = (c: ScoringChangeInput): FileChange[] => c.files ?? c.accepted_files ?? [];
export const changeTime = (c: ScoringChangeInput): string | undefined => c.occurred_at ?? c.accepted_at ?? c.first_seen_at;

/** % de líneas agregadas por tier (ponderado por `added`). */
export function tierShares(files: FileChange[]): Record<FileTier, number> {
  const totals: Record<FileTier, number> = { core: 0, test: 0, infra: 0, docs: 0, generated: 0 };
  for (const f of files) totals[fileTier(f.path)] += num(f.added);
  const sum = Object.values(totals).reduce((a, b) => a + b, 0);
  return Object.fromEntries(Object.entries(totals).map(([t, v]) => [t, ratio(v, sum)])) as Record<FileTier, number>;
}

/** Hora UTC (0..23); 12 si no hay fecha válida (igual que Python). */
export function hourOfDay(iso: string | undefined): number {
  if (!iso) return 12;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 12 : new Date(t).getUTCHours();
}

export function buildFeatures(change: ScoringChangeInput, ctx: ScoringContext = {}): BuiltFeatures {
  const files = changeFiles(change);
  const dims = change.dimensions;
  const imp = dims?.importance;
  const aut = dims?.automation;
  const byKind = (imp?.by_kind ?? {}) as Partial<Record<string, number>>;

  const added = num(change.accepted_added_lines, files.reduce((s, f) => s + num(f.added), 0));
  const deleted = num(change.accepted_deleted_lines, files.reduce((s, f) => s + num(f.deleted), 0));
  const lines = num(imp?.lines, added);
  const effective = num(dims?.effective_lines, num(change.effective_lines));
  const asIs = num(aut?.accepted_as_is);
  const edited = num(aut?.edited_before_accept);
  const shares = tierShares(files);
  const tokens = num(ctx.tokens_total);
  const taskType = String(ctx.task_type ?? '').trim().toLowerCase();
  const branch = change.branch ?? undefined;
  const isDefault = branch
    ? ctx.default_branch
      ? branch === ctx.default_branch
      : DEFAULT_BRANCHES.has(branch)
    : false;

  const vector: FeatureVector = {
    accepted_added_lines: added,
    accepted_deleted_lines: deleted,
    files_count: files.length,
    importance_score: clamp01(num(imp?.score, num(change.importance_score))),
    redundancy_score: clamp01(num(dims?.redundancy?.score, num(change.redundancy_score))),
    mechanical_share: clamp01(num(aut?.mechanical_share, num(change.mechanical_share))),
    effective_lines: effective,
    edited_before_accept_ratio: clamp01(ratio(edited, asIs + edited)),
    core_tier_share: shares.core,
    test_tier_share: shares.test,
    logic_kind_share: clamp01(ratio(num(byKind.logic), lines)),
    test_kind_share: clamp01(ratio(num(byKind.test), lines)),
    tokens_total: tokens,
    tokens_per_effective_line: tokens / Math.max(effective, 1),
    regenerations: num(ctx.regenerations),
    latency_ms: num(ctx.latency_ms),
    // sin dato → 0.6 (≈ media poblacional): un 0 implícito castigaría la supervivencia
    session_acceptance_rate: clamp01(num(ctx.session_acceptance_rate, NEUTRAL_ACCEPTANCE)),
    has_task: change.task_key ? 1 : 0,
    task_is_bug: change.task_key && BUG_TYPES.has(taskType) ? 1 : 0,
    branch_is_default: isDefault ? 1 : 0,
    hour_of_day: hourOfDay(changeTime(change)),
  };

  const tier_weight = clamp01(
    (Object.keys(shares) as FileTier[]).reduce((s, t) => s + shares[t] * DEFAULT_TIER_WEIGHTS[t], 0),
  );
  return { vector, tier_weight };
}

/** Atajo: solo el vector. */
export const buildFeatureVector = (change: ScoringChangeInput, ctx?: ScoringContext): FeatureVector =>
  buildFeatures(change, ctx).vector;

/** Fila CSV SIN cabecera en el orden de SCORING_FEATURES (formato del contenedor XGBoost). */
export const toCsvRow = (v: FeatureVector): string => SCORING_FEATURES.map((f) => String(v[f])).join(',');
