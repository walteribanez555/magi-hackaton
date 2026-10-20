import { z } from 'zod';

/**
 * Las tres aristas con las que se pondera cada línea aceptada (ver docs/metrics-model.md).
 * Las calcula la extensión en local con @magicode/metrics (tiene el código); al backend
 * solo viajan CONTEOS y pesos, nunca el contenido.
 */

/** Clase de línea → peso de IMPORTANCIA por defecto. */
export const LineKind = z.enum([
  'logic', // control de flujo, expresiones, asignaciones, returns con valor   → 1.0
  'declaration', // firmas de función/clase/interfaz/tipo                       → 0.8
  'test', // líneas en archivos de test o aserciones                            → 0.7
  'config', // json/yaml/toml/env y similares                                  → 0.4
  'comment', // comentarios y docstrings                                        → 0.2
  'import', // import/require/using/include                                     → 0.1
  'trivial', // solo puntuación: `}`, `);`, `]`, `end`                          → 0.0
]);
export type LineKind = z.infer<typeof LineKind>;

export const DEFAULT_KIND_WEIGHTS: Record<LineKind, number> = {
  logic: 1.0,
  declaration: 0.8,
  test: 0.7,
  config: 0.4,
  comment: 0.2,
  import: 0.1,
  trivial: 0,
};

/** Criticidad del archivo (multiplicador de importancia por ruta). */
export const FileTier = z.enum([
  'core', // src/**, lib/**, app/**                → 1.0
  'test', // **/*.test.*, **/*.spec.*, tests/**     → 0.9
  'infra', // infra/**, Dockerfile, *.tf, ci        → 0.7
  'docs', // *.md, docs/**                          → 0.3
  'generated', // lockfiles, dist/**, *.g.*, snapshots → 0.0 (además cuenta como mecánico)
]);
export type FileTier = z.infer<typeof FileTier>;

export const DEFAULT_TIER_WEIGHTS: Record<FileTier, number> = {
  core: 1.0,
  test: 0.9,
  infra: 0.7,
  docs: 0.3,
  generated: 0,
};

/** 1) IMPORTANCIA — cuánto valor aportan las líneas aceptadas. */
export const ImportanceBreakdown = z.object({
  /** líneas agregadas no vacías */
  lines: z.number().int().nonnegative(),
  /** Σ peso(kind) × peso(tier) — "líneas ponderadas" */
  weighted_lines: z.number().nonnegative(),
  /** weighted_lines / lines (0..1); 0 si lines = 0 */
  score: z.number().min(0).max(1),
  by_kind: z.record(LineKind, z.number().int().nonnegative()),
});
export type ImportanceBreakdown = z.infer<typeof ImportanceBreakdown>;

/** 2) REDUNDANCIA — líneas que no agregan algo nuevo. */
export const RedundancyBreakdown = z.object({
  /** repetidas dentro del mismo cambio (a partir de la 2ª aparición, sin triviales) */
  intra_change: z.number().int().nonnegative(),
  /** ya existían en el workspace antes de aceptar (copy-paste / duplicación) */
  existing_in_repo: z.number().int().nonnegative(),
  /** ya habían sido aceptadas en un cambio anterior de la misma sesión */
  repeated_in_session: z.number().int().nonnegative(),
  /** total de líneas redundantes (sin doble conteo) */
  redundant_lines: z.number().int().nonnegative(),
  /** redundant_lines / líneas no triviales (0..1) */
  score: z.number().min(0).max(1),
});
export type RedundancyBreakdown = z.infer<typeof RedundancyBreakdown>;

/** 3) AUTOMATIZACIÓN — qué parte es automatización real de IA y qué parte era mecánica. */
export const AutomationBreakdown = z.object({
  /** líneas que una herramienta determinista habría producido (imports, generados, boilerplate) */
  mechanical_lines: z.number().int().nonnegative(),
  /** mechanical_lines / lines (0..1) — tokens gastados en algo automatizable sin LLM */
  mechanical_share: z.number().min(0).max(1),
  /** líneas aceptadas tal cual vs. editadas por el humano antes de aceptar (si el IDE lo detecta) */
  accepted_as_is: z.number().int().nonnegative(),
  edited_before_accept: z.number().int().nonnegative(),
});
export type AutomationBreakdown = z.infer<typeof AutomationBreakdown>;

export const ChangeDimensions = z.object({
  importance: ImportanceBreakdown,
  redundancy: RedundancyBreakdown,
  automation: AutomationBreakdown,
  /**
   * Líneas efectivas = Σ sobre líneas NO redundantes y NO mecánicas de peso(kind)×peso(tier).
   * Es el denominador "honesto" de tokens por 100 líneas.
   */
  effective_lines: z.number().nonnegative(),
});
export type ChangeDimensions = z.infer<typeof ChangeDimensions>;

/**
 * Automatización a nivel de COMMIT (se calcula al detectar el commit, cruzando hashes de las
 * líneas aceptadas con las líneas agregadas del diff del commit).
 */
export const CommitAutomation = z.object({
  /** líneas agregadas no vacías y NO triviales del commit (todo el commit, IA + humano) */
  commit_added_lines: z.number().int().nonnegative(),
  /** de esas, cuántas coinciden con líneas IA aceptadas */
  ai_matched_lines: z.number().int().nonnegative(),
  /** ai_matched_lines / commit_added_lines — % del commit automatizado por IA */
  ai_share: z.number().min(0).max(1),
  /** líneas IA aceptadas en estos cambios que NO aparecen en el commit (editadas/borradas) */
  ai_lost_lines: z.number().int().nonnegative(),
  /** líneas efectivas (ponderadas) que llegaron al commit */
  effective_lines: z.number().nonnegative(),
});
export type CommitAutomation = z.infer<typeof CommitAutomation>;
