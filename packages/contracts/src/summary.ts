import { z } from 'zod';
import { Attribution, Measured, Provenance } from './provenance.js';
import { LineKind } from './dimensions.js';
import { ChangeScores } from './scoring.js';

/**
 * Respuesta de GET /api/v1/productivity/summary — lo que pinta el dashboard.
 * Cada número es un `Measured` (valor + procedencia + fuente).
 */

export const FunnelStage = z.enum(['generated', 'accepted', 'committed', 'in_reference', 'deployed']);
export type FunnelStage = z.infer<typeof FunnelStage>;

export const FunnelStep = z.object({
  stage: FunnelStage,
  lines: Measured, // líneas brutas que llegan a esta etapa
  effective_lines: Measured, // líneas ponderadas por las 3 aristas
  /** (tokens_total / lines) × 100; null si lines = 0 */
  tokens_per_100_lines: Measured,
  tokens_per_100_effective_lines: Measured,
  /** lines(etapa) / lines(etapa anterior) */
  conversion: Measured,
});
export type FunnelStep = z.infer<typeof FunnelStep>;

export const TokenBreakdown = z.object({
  /** fuente de verdad: API de consumo de MagiHub para key + intervalo */
  total: Measured,
  /** Σ usage por petición reportado en las respuestas (para reconciliar) */
  reported_by_requests: Measured,
  /** total − reported (≠0 ⇒ otro proceso usó la key o hay latencia de ingesta) */
  unreconciled: Measured,
  /** tokens de peticiones con ≥1 cambio aceptado */
  on_accepted: Measured,
  /** tokens de peticiones rechazadas/errores — costo de exploración */
  on_rejected: Measured,
  /** tokens de regeneraciones con salida casi idéntica (output_hash repetido) */
  on_redundant_regenerations: Measured,
  /** tokens proporcionales a líneas mecánicas (automatizables sin LLM) */
  on_mechanical: Measured,
  cost_usd: Measured, // value=null si MagiHub no expone costo verificable
});
export type TokenBreakdown = z.infer<typeof TokenBreakdown>;

export const DimensionsSummary = z.object({
  importance: z.object({
    score: Measured, // 0..1 promedio ponderado
    by_kind: z.record(LineKind, z.number()),
  }),
  redundancy: z.object({
    score: Measured, // 0..1
    intra_change: z.number(),
    existing_in_repo: z.number(),
    repeated_in_session: z.number(),
    redundant_regenerations: z.number(), // nº de peticiones
  }),
  automation: z.object({
    /** % de las líneas de los commits que vino de IA */
    ai_share_of_commits: Measured,
    /** % de las líneas IA aceptadas que eran mecánicas */
    mechanical_share: Measured,
    /** % de líneas IA aceptadas que se perdieron antes del commit */
    lost_before_commit: Measured,
    accepted_as_is: z.number(),
    edited_before_accept: z.number(),
  }),
});
export type DimensionsSummary = z.infer<typeof DimensionsSummary>;

export const SummaryScope = z.object({
  tenant_id: z.string(),
  key_id: z.string(), // id/huella de la key, NUNCA la key
  project_id: z.string().optional(),
  repository: z.string().optional(),
  session_id: z.string().optional(),
  task_key: z.string().optional(),
  branch: z.string().optional(),
  from: z.string(),
  to: z.string(),
});

export const ProductivitySummary = z.object({
  scope: SummaryScope,
  attribution: Attribution,
  /** procedencia "peor" presente en el resumen (simulated > estimated > real) */
  overall_provenance: Provenance,
  tokens: TokenBreakdown,
  funnel: z.array(FunnelStep),
  dimensions: DimensionsSummary,
  counts: z.object({
    sessions: z.number(),
    ai_requests: z.number(),
    changes_proposed: z.number(),
    changes_accepted: z.number(),
    changes_rejected: z.number(),
    commits: z.number(),
    references: z.number(),
    /** desde webhooks del repositorio origen */
    pull_requests: z.number(),
    pull_requests_merged: z.number(),
    deployments_success: z.number(),
    /** desde el gestor de tareas (Jira) */
    tasks: z.number(),
    tasks_done: z.number(),
  }),
  by_model: z.array(
    z.object({ model: z.string(), requests: z.number(), tokens: Measured, accepted_lines: z.number() }),
  ),
  generated_at: z.string(),
});
export type ProductivitySummary = z.infer<typeof ProductivitySummary>;

export const TimelinePoint = z.object({
  bucket_start: z.string(),
  tokens: z.number(),
  tokens_provenance: Provenance,
  accepted_lines: z.number(),
  effective_lines: z.number(),
  committed_lines: z.number(),
});
export type TimelinePoint = z.infer<typeof TimelinePoint>;

export const SessionListItem = z.object({
  session_id: z.string(),
  project_id: z.string(),
  repository: z.string(),
  branch: z.string().nullable(),
  task_key: z.string().nullable(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  ai_requests: z.number(),
  tokens: Measured,
  accepted_lines: z.number(),
  effective_lines: z.number(),
  commits: z.array(z.string()),
  highest_stage: FunnelStage,
});
export type SessionListItem = z.infer<typeof SessionListItem>;

export const ChangeListItem = z.object({
  change_id: z.string(),
  session_id: z.string(),
  ai_request_id: z.string(),
  status: z.enum(['proposed', 'accepted', 'rejected', 'committed', 'in_reference']),
  files: z.array(z.object({ path: z.string(), added: z.number(), deleted: z.number() })),
  accepted_added_lines: z.number(),
  importance_score: z.number(),
  redundancy_score: z.number(),
  mechanical_share: z.number(),
  effective_lines: z.number(),
  commit_sha: z.string().nullable(),
  tokens: Measured,
  /** puntuaciones XGBoost (o heurística) — null hasta que se calculen */
  scores: ChangeScores.nullable(),
  branch: z.string().nullable(),
  task_key: z.string().nullable(),
  occurred_at: z.string(),
});
export type ChangeListItem = z.infer<typeof ChangeListItem>;
