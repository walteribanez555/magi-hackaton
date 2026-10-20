import { z } from 'zod';
import { Attribution, DataSource } from './provenance.js';
import { ChangeDimensions, CommitAutomation } from './dimensions.js';

/**
 * Contrato de POST /api/v1/productivity/events (nuevo; no existe en MagiHub).
 *
 * Reglas:
 * - El tenant y la clave se DERIVAN de la API key (header Authorization). El cuerpo nunca
 *   trae tenant_id; si lo trae, se ignora.
 * - Sin volcar código: solo IDs, rutas, conteos y hashes. Nada de prompts ni contenido.
 * - Idempotente por event_id (reintentos del IDE no duplican).
 */

export const SCHEMA_VERSION = 1 as const;

const Sha = z.string().regex(/^[0-9a-f]{7,64}$/i, 'git SHA inválido');
const Iso = z.iso.datetime({ offset: true });
const Hash = z.string().regex(/^[0-9a-f]{8,64}$/i);

export const FileChange = z.object({
  path: z.string().min(1).max(512), // ruta relativa al repo
  language: z.string().max(40).optional(),
  added: z.number().int().nonnegative(), // líneas agregadas no vacías
  deleted: z.number().int().nonnegative(),
});
export type FileChange = z.infer<typeof FileChange>;

export const TokenUsage = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  cached_tokens: z.number().int().nonnegative().optional(),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

const Envelope = {
  event_id: z.uuid(),
  schema_version: z.literal(SCHEMA_VERSION),
  occurred_at: Iso,
  session_id: z.string().min(1).max(128),
  project_id: z.string().min(1).max(128),
  repository: z.string().min(1).max(256), // "org/repo" o ruta lógica del repo local
  /** rama activa al emitir el evento — enlaza sesión ↔ rama ↔ tarea */
  branch: z.string().max(256).optional(),
  /** tarea (Jira) explícita o inferida de la rama con extractTaskKeys */
  task_key: z.string().regex(/^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/).optional(),
  source: z.enum(['ide-extension', 'demo-seed']),
};

export const SessionStarted = z.object({
  ...Envelope,
  event_type: z.literal('session.started'),
  payload: z.object({
    editor: z.string().max(60), // "vscode 1.105.0"
    extension_version: z.string().max(30),
    branch: z.string().max(256).optional(),
    head_sha: Sha.optional(),
  }),
});

export const SessionEnded = z.object({
  ...Envelope,
  event_type: z.literal('session.ended'),
  payload: z.object({ reason: z.enum(['user', 'window-closed', 'idle']).default('user') }),
});

/** Una llamada a Smart Auto terminó (éxito o error: los errores también consumen tokens). */
export const AiRequestCompleted = z.object({
  ...Envelope,
  event_type: z.literal('ai.request.completed'),
  payload: z.object({
    ai_request_id: z.string().min(1).max(128), // id devuelto por MagiHub (header/body)
    model: z.string().max(120).optional(), // modelo que eligió Smart Auto, si lo expone
    status: z.enum(['ok', 'error', 'cancelled']),
    latency_ms: z.number().int().nonnegative(),
    /** usage devuelto en la respuesta; se reconcilia luego con la API de consumo */
    usage: TokenUsage.optional(),
    usage_source: DataSource.extract(['magihub-response', 'magihub-mock']).optional(),
    /** hash del contenido generado: detecta regeneraciones redundantes sin guardar código */
    output_hash: Hash.optional(),
    /** si el usuario pidió "regenerar" sobre una petición previa */
    regenerates: z.string().max(128).optional(),
  }),
});

/** La IA propuso un cambio (estado GENERADO). */
export const CodeProposed = z.object({
  ...Envelope,
  event_type: z.literal('code.proposed'),
  payload: z.object({
    change_id: z.string().min(1).max(128),
    ai_request_id: z.string().min(1).max(128),
    files: z.array(FileChange).min(1).max(100),
    patch_hash: Hash,
  }),
});

/** El usuario aplicó el cambio (estado ACEPTADO) — trae las 3 aristas calculadas en local. */
export const CodeAccepted = z.object({
  ...Envelope,
  event_type: z.literal('code.accepted'),
  payload: z.object({
    change_id: z.string().min(1).max(128),
    ai_request_id: z.string().min(1).max(128),
    files: z.array(FileChange).min(1).max(100),
    patch_hash: Hash,
    accepted_added_lines: z.number().int().nonnegative(),
    accepted_deleted_lines: z.number().int().nonnegative(),
    dimensions: ChangeDimensions,
  }),
});

export const CodeRejected = z.object({
  ...Envelope,
  event_type: z.literal('code.rejected'),
  payload: z.object({
    change_id: z.string().min(1).max(128),
    ai_request_id: z.string().min(1).max(128),
    reason: z.enum(['user', 'superseded', 'error']).default('user'),
  }),
});

/** Se detectó un commit que contiene cambios aceptados (estado REGISTRADO EN GIT). */
export const GitCommitted = z.object({
  ...Envelope,
  event_type: z.literal('git.committed'),
  payload: z.object({
    sha: Sha,
    parent_sha: Sha.optional(),
    branch: z.string().max(256).optional(),
    committed_at: Iso,
    files: z.array(FileChange).max(500),
    /** cambios aceptados cuyas líneas aparecen en este commit */
    change_ids: z.array(z.string().max(128)).max(500),
    automation: CommitAutomation,
    /** el commit trae el trailer `MagiCode-Session: <session_id>` */
    has_session_trailer: z.boolean(),
    remote_url: z.string().max(512).optional(),
    source: DataSource.extract(['git-local', 'git-remote']).default('git-local'),
  }),
});

/** Se marcó una versión de referencia / despliegue (estado EN VERSIÓN DE REFERENCIA). */
export const ReferenceMarked = z.object({
  ...Envelope,
  event_type: z.literal('reference.marked'),
  payload: z.object({
    tag: z.string().min(1).max(256),
    sha: Sha,
    /** demo-reference = "versión de referencia (demo)"; deployment SOLO con evidencia */
    kind: z.enum(['demo-reference', 'deployment']),
    evidence_url: z.url().optional(),
    /** commits de la sesión que son ancestros del tag (git merge-base --is-ancestor) */
    included_shas: z.array(Sha).max(500),
    /** líneas IA aceptadas que siguen presentes en el SHA del tag (diff simplificado) */
    surviving_lines: z.number().int().nonnegative(),
    surviving_effective_lines: z.number().nonnegative(),
  }),
});

export const ProductivityEvent = z
  .discriminatedUnion('event_type', [
    SessionStarted,
    SessionEnded,
    AiRequestCompleted,
    CodeProposed,
    CodeAccepted,
    CodeRejected,
    GitCommitted,
    ReferenceMarked,
  ])
  .refine((e) => e.event_type !== 'reference.marked' || e.payload.kind !== 'deployment' || !!e.payload.evidence_url, {
    message: 'kind=deployment requiere evidence_url (no se etiqueta "producción" sin prueba)',
  });
export type ProductivityEvent = z.infer<typeof ProductivityEvent>;
export type ProductivityEventType = ProductivityEvent['event_type'];

/** Cuerpo del POST: un evento o un lote (máx. 25 = límite de TransactWrite/BatchWrite). */
export const EventsRequest = z.union([
  ProductivityEvent,
  z.object({ events: z.array(ProductivityEvent).min(1).max(25) }),
]);
export type EventsRequest = z.infer<typeof EventsRequest>;

export const EventsResponse = z.object({
  accepted: z.number().int(),
  duplicates: z.number().int(),
  attribution: Attribution,
});
export type EventsResponse = z.infer<typeof EventsResponse>;
