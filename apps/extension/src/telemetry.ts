/**
 * Cliente de telemetría de productividad. Puro: no importa 'vscode' (store, fetch y logger se inyectan).
 *
 * - Construye el sobre (event_id, schema_version, occurred_at con offset, sesión/proyecto/repo, source).
 * - Valida contra `ProductivityEvent` de @magicode/contracts ANTES de encolar; lo inválido se descarta.
 * - Lotes ≤ 25, flush cada 5 s o al llegar a 10 eventos; reintentos con backoff exponencial.
 * - La cola sin enviar se persiste (globalState) y sobrevive a recargas de ventana.
 * - Solo viajan IDs, rutas, conteos y hashes: nunca código, prompts ni la API key (va en Authorization).
 */
import { randomUUID } from 'node:crypto';
import { API_PREFIX, ProductivityEvent, ROUTES, SCHEMA_VERSION, type ProductivityEventType } from '@magicode/contracts';
import type { z } from 'zod';
import { joinUrl, type FetchLike } from './smartAuto';
import type { Logger } from './log';

export type EventInput = z.input<typeof ProductivityEvent>;
export type PayloadOf<T extends ProductivityEventType> = Extract<EventInput, { event_type: T }>['payload'];

export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface TelemetryContext {
  session_id: string;
  project_id: string;
  repository: string;
  branch?: string;
  task_key?: string;
}

export interface TelemetryOptions {
  /** base de la API, p. ej. http://localhost:3000/api/v1 */
  getBaseUrl: () => string;
  getApiKey: () => Promise<string | undefined>;
  store: KeyValueStore;
  logger: Logger;
  fetchImpl?: FetchLike;
  batchSize?: number;
  flushThreshold?: number;
  flushIntervalMs?: number;
  maxQueue?: number;
  maxBackoffMs?: number;
  now?: () => Date;
  uuid?: () => string;
  /** desactiva el temporizador (tests) */
  autoFlush?: boolean;
}

export const QUEUE_KEY = 'magicode.telemetryQueue';

/** ISO-8601 con offset local (p. ej. 2026-10-20T16:08:00.123-04:00). */
export function isoWithOffset(d: Date): string {
  const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`
  );
}

/** Si la base ya incluye /api/v1 se respeta; si no, se agrega el prefijo. */
export function eventsUrl(base: string): string {
  const b = base.replace(/\/+$/, '');
  return joinUrl(b.endsWith(API_PREFIX) ? b : joinUrl(b, API_PREFIX), ROUTES.events);
}

export function buildEvent<T extends ProductivityEventType>(
  ctx: TelemetryContext,
  eventType: T,
  payload: PayloadOf<T>,
  now: Date = new Date(),
  uuid: () => string = randomUUID,
): Record<string, unknown> {
  return {
    event_id: uuid(),
    schema_version: SCHEMA_VERSION,
    occurred_at: isoWithOffset(now),
    session_id: ctx.session_id,
    project_id: ctx.project_id,
    repository: ctx.repository,
    ...(ctx.branch ? { branch: ctx.branch } : {}),
    ...(ctx.task_key ? { task_key: ctx.task_key } : {}),
    source: 'ide-extension',
    event_type: eventType,
    payload,
  };
}

export type ValidationResult = { ok: true; event: ProductivityEvent } | { ok: false; issues: string };

export function validateEvent(candidate: unknown): ValidationResult {
  const r = ProductivityEvent.safeParse(candidate);
  if (r.success) return { ok: true, event: r.data };
  const issues = r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  return { ok: false, issues };
}

export class TelemetryClient {
  private queue: ProductivityEvent[];
  private readonly fetchImpl: FetchLike;
  private readonly batchSize: number;
  private readonly flushThreshold: number;
  private readonly maxQueue: number;
  private readonly maxBackoffMs: number;
  private readonly now: () => Date;
  private readonly uuid: () => string;
  private timer: ReturnType<typeof setInterval> | undefined;
  private flushing: Promise<void> | undefined;
  private failures = 0;
  private nextAttemptAt = 0;
  private warnedNoKey = false;
  /** contadores para la UI */
  sent = 0;
  dropped = 0;
  lastError: string | undefined;

  constructor(private readonly opts: TelemetryOptions) {
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
    this.batchSize = Math.min(25, opts.batchSize ?? 25);
    this.flushThreshold = opts.flushThreshold ?? 10;
    this.maxQueue = opts.maxQueue ?? 1000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 60_000;
    this.now = opts.now ?? (() => new Date());
    this.uuid = opts.uuid ?? randomUUID;
    // re-validar lo persistido (p. ej. tras un cambio de contrato) y descartar lo inválido
    const stored = opts.store.get<unknown[]>(QUEUE_KEY) ?? [];
    this.queue = [];
    for (const e of Array.isArray(stored) ? stored : []) {
      const v = validateEvent(e);
      if (v.ok) this.queue.push(v.event);
      else this.dropped++;
    }
    if (opts.autoFlush !== false) {
      this.timer = setInterval(() => void this.flush(), opts.flushIntervalMs ?? 5000);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Construye, valida y encola. Devuelve el evento validado o undefined si se descartó. */
  track<T extends ProductivityEventType>(ctx: TelemetryContext, eventType: T, payload: PayloadOf<T>): ProductivityEvent | undefined {
    const candidate = buildEvent(ctx, eventType, payload, this.now(), this.uuid);
    const v = validateEvent(candidate);
    if (!v.ok) {
      this.dropped++;
      this.opts.logger.warn(`Evento ${eventType} descartado: no valida contra el contrato (${v.issues})`);
      return undefined;
    }
    this.queue.push(v.event);
    if (this.queue.length > this.maxQueue) {
      const overflow = this.queue.length - this.maxQueue;
      this.queue.splice(0, overflow);
      this.dropped += overflow;
      this.opts.logger.warn(`Cola de telemetría llena: se descartaron ${overflow} eventos antiguos`);
    }
    void this.persist();
    this.opts.logger.debug(`evento ${eventType} encolado (${this.queue.length} pendientes)`);
    if (this.queue.length >= this.flushThreshold) void this.flush();
    return v.event;
  }

  /** Envía todo lo que se pueda; respeta el backoff salvo `force`. */
  flush(force = false): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.doFlush(force).finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  private async doFlush(force: boolean): Promise<void> {
    if (this.queue.length === 0) return;
    if (!force && this.now().getTime() < this.nextAttemptAt) return;
    const key = await this.opts.getApiKey();
    if (!key) {
      if (!this.warnedNoKey) this.opts.logger.warn('Telemetría en espera: configura la API key de MagiHub');
      this.warnedNoKey = true;
      return;
    }
    this.warnedNoKey = false;
    const url = eventsUrl(this.opts.getBaseUrl());
    while (this.queue.length > 0) {
      const batch = this.queue.slice(0, this.batchSize);
      let status = 0;
      try {
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({ events: batch }),
          signal: AbortSignal.timeout(15_000),
        });
        status = res.status;
        await res.text().catch(() => '');
      } catch (err) {
        this.backoff(`red: ${(err as Error).message}`);
        return;
      }
      if (status >= 200 && status < 300) {
        this.remove(batch);
        this.sent += batch.length;
        this.failures = 0;
        this.nextAttemptAt = 0;
        this.lastError = undefined;
        this.opts.logger.info(`Telemetría: ${batch.length} eventos enviados (HTTP ${status})`);
        continue;
      }
      if (status === 400 || status === 422) {
        // validamos localmente: si el servidor aún así rechaza, el lote es venenoso → descartar
        this.remove(batch);
        this.dropped += batch.length;
        this.opts.logger.warn(`Telemetría: el servidor rechazó ${batch.length} eventos (HTTP ${status}); descartados`);
        continue;
      }
      this.backoff(`HTTP ${status}`);
      return;
    }
  }

  private remove(batch: ProductivityEvent[]): void {
    const ids = new Set(batch.map((e) => e.event_id));
    this.queue = this.queue.filter((e) => !ids.has(e.event_id));
    void this.persist();
  }

  private backoff(reason: string): void {
    this.failures++;
    const base = Math.min(this.maxBackoffMs, 1000 * 2 ** (this.failures - 1));
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.nextAttemptAt = this.now().getTime() + delay;
    this.lastError = reason;
    this.opts.logger.warn(`Telemetría: envío fallido (${reason}); reintento en ${Math.round(delay / 1000)} s, ${this.queue.length} pendientes`);
  }

  private async persist(): Promise<void> {
    try {
      await this.opts.store.update(QUEUE_KEY, this.queue);
    } catch (err) {
      this.opts.logger.error('No se pudo persistir la cola de telemetría', err);
    }
  }

  /** Último intento de envío y persistencia (deactivate). */
  async dispose(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    try {
      await Promise.race([this.flush(true), new Promise((r) => setTimeout(r, 3000))]);
    } finally {
      await this.persist();
    }
  }
}
