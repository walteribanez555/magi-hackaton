import { keys, type DataSource, type Provenance, type UsageGranularity, type UsageRecord, type UsageResponse } from '@magicode/contracts';
import { config } from '../../config/config';
import { createLogger } from '../../config/logger';
import { BadGatewayException, UnauthorizedException } from '../../common/exceptions';
import { DAY_MS, HOUR_MS, floorTo, iso, toUtcIso } from '../../common/utils/time';
import { getMagiHubClient } from '../magihub/magihub.client';
import {
  MagiHubAuthError,
  MagiHubUnsupportedError,
  type MagiHubClient,
} from '../magihub/magihub.types';
import { usageRepository, type UsageRepository } from './usage.repository';
import type { UsageSnapshotItem, UsageSyncMarker, UsageWindowResult } from './usage.types';

const logger = createLogger('Usage');

export interface UsageCaller {
  tenant_id: string;
  key_id: string;
}

/** ¿Hace falta ir a MagiHub? (sin marcador, ventana fuera de cobertura o cobertura >5 min vieja). */
export function needsSync(marker: UsageSyncMarker | undefined, from: string, to: string, nowMs: number, staleSeconds: number): boolean {
  if (!marker) return true;
  const clampedTo = Math.min(Date.parse(to), nowMs);
  if (Date.parse(from) < Date.parse(marker.covered_from)) return true;
  if (clampedTo > Date.parse(marker.covered_to)) return nowMs - Date.parse(marker.synced_at) > staleSeconds * 1000;
  return false;
}

/** Une coberturas si se solapan; si no, se queda con la nueva. */
export function mergeCoverage(
  marker: UsageSyncMarker | undefined,
  from: string,
  to: string,
  granularity: UsageGranularity,
): { covered_from: string; covered_to: string } {
  if (!marker || marker.granularity !== granularity) return { covered_from: from, covered_to: to };
  const overlaps = Date.parse(from) <= Date.parse(marker.covered_to) && Date.parse(to) >= Date.parse(marker.covered_from);
  if (!overlaps) return { covered_from: from, covered_to: to };
  return {
    covered_from: from < marker.covered_from ? from : marker.covered_from,
    covered_to: to > marker.covered_to ? to : marker.covered_to,
  };
}

/** Sufijo del SK: request ⇒ `{ts}#{request_id}`; hora/día ⇒ `{window_start}#{model|all}` (MagiHub puede desglosar por modelo). */
const windowKey = (g: UsageGranularity, r: UsageRecord) =>
  g === 'request' ? `${r.window_start}#${r.request_id ?? 'unknown'}` : `${r.window_start}#${r.model ?? 'all'}`;

/** Une registros que caerían en el mismo SK (BatchWrite no admite claves repetidas). */
function mergeBySk(items: UsageSnapshotItem[]): UsageSnapshotItem[] {
  const by = new Map<string, UsageSnapshotItem>();
  for (const it of items) {
    const cur = by.get(it.SK);
    if (!cur) {
      by.set(it.SK, { ...it, usage: { ...it.usage } });
      continue;
    }
    cur.usage.prompt_tokens += it.usage.prompt_tokens;
    cur.usage.completion_tokens += it.usage.completion_tokens;
    cur.usage.total_tokens += it.usage.total_tokens;
    cur.requests += it.requests;
    if (typeof it.cost_usd === 'number') cur.cost_usd = (cur.cost_usd ?? 0) + it.cost_usd;
  }
  return [...by.values()];
}

/**
 * Consumo REAL de MagiHub por API key + intervalo. Se consulta con la key del propio usuario
 * (nunca se guarda), se persiste como UsageSnapshot y se sirve desde Dynamo mientras esté fresco.
 */
export class UsageService {
  constructor(
    private readonly repo: UsageRepository = usageRepository,
    private readonly client: () => MagiHubClient = getMagiHubClient,
    private readonly now: () => number = Date.now,
  ) {}

  private provenanceOf(simulated: boolean): { provenance: Provenance; source: DataSource } {
    const mode = config.getValue('magihub').mode;
    if (mode === 'mock' || simulated) return { provenance: 'simulated', source: 'magihub-mock' };
    // adaptador Bedrock: GET /v1/usage devuelve mediciones reales de Bedrock (simulated=false)
    return mode === 'bedrock' ? { provenance: 'real', source: 'bedrock' } : { provenance: 'real', source: 'magihub-usage-api' };
  }

  /** Granularidad que se intentará: request salvo que MagiHub ya la haya rechazado. */
  private async fetchUsage(apiKey: string, from: string, to: string, marker?: UsageSyncMarker): Promise<UsageResponse & { request_unsupported?: boolean }> {
    const client = this.client();
    const tryGranularities: UsageGranularity[] = marker?.request_unsupported ? ['hour'] : ['request', 'hour'];
    let lastErr: unknown;
    for (const granularity of tryGranularities) {
      try {
        const res = await client.usage(apiKey, { from, to, granularity });
        return { ...res, request_unsupported: granularity !== 'request' };
      } catch (err) {
        lastErr = err;
        if (err instanceof MagiHubUnsupportedError) {
          logger.info('MagiHub no soporta la granularidad; se baja a la siguiente', { granularity });
          continue;
        }
        break;
      }
    }
    if (lastErr instanceof MagiHubAuthError) throw new UnauthorizedException('API key inválida para MagiHub', 'INVALID_API_KEY');
    throw new BadGatewayException('No se pudo leer el consumo de MagiHub', 'MAGIHUB_USAGE_UNAVAILABLE');
  }

  /** POST /usage/sync — fuerza la lectura a MagiHub y guarda los snapshots. */
  async sync(caller: UsageCaller, apiKey: string, from: string, to: string): Promise<UsageSyncMarker & { records: number }> {
    const nowMs = this.now();
    const nowIso = iso(nowMs);
    const clampedTo = iso(Math.min(Date.parse(to), nowMs));
    const marker = await this.repo.getMarker(caller.tenant_id, caller.key_id);
    const res = await this.fetchUsage(apiKey, from, clampedTo, marker);
    const { provenance, source } = this.provenanceOf(res.simulated);

    const items: UsageSnapshotItem[] = res.records.map((r) => {
      const rec: UsageRecord = { ...r, window_start: toUtcIso(r.window_start), window_end: toUtcIso(r.window_end) };
      return {
        ...keys.usage(caller.tenant_id, caller.key_id, res.granularity, windowKey(res.granularity, rec)),
        entity: 'UsageSnapshot',
        tenant_id: caller.tenant_id,
        key_id: caller.key_id,
        ...rec,
        granularity: res.granularity,
        simulated: res.simulated,
        provenance,
        source,
        synced_at: nowIso,
        created_at: nowIso,
        updated_at: nowIso,
      };
    });
    await this.repo.putRecords(mergeBySk(items));

    const coverage = mergeCoverage(marker, from, clampedTo, res.granularity);
    const next: UsageSyncMarker = {
      granularity: res.granularity,
      ...coverage,
      synced_at: nowIso,
      provenance,
      source,
      request_unsupported: res.request_unsupported,
      ingestion_delay_minutes: res.ingestion_delay_minutes,
    };
    await this.repo.putMarker(caller.tenant_id, caller.key_id, next, nowIso);
    logger.info('usage synced', { key_id: caller.key_id, granularity: res.granularity, records: items.length });
    return { ...next, records: items.length };
  }

  /** Lee snapshots de la ventana; sincroniza antes si faltan o están viejos. */
  async getWindow(
    caller: UsageCaller,
    apiKey: string,
    from: string,
    to: string,
    opts: { force?: boolean; granularity?: UsageGranularity } = {},
  ): Promise<UsageWindowResult> {
    const stale = config.getValue('usage').staleSeconds;
    let marker = await this.repo.getMarker(caller.tenant_id, caller.key_id);
    let synced = false;
    if (opts.force || needsSync(marker, from, to, this.now(), stale)) {
      marker = await this.sync(caller, apiKey, from, to);
      synced = true;
    }
    const granularity = marker!.granularity;
    const lowerBound =
      granularity === 'hour' ? iso(floorTo(Date.parse(from), HOUR_MS)) : granularity === 'day' ? iso(floorTo(Date.parse(from), DAY_MS)) : from;
    const items = await this.repo.listRecords(caller.tenant_id, caller.key_id, granularity, lowerBound, to);
    const records: UsageRecord[] = items.map((i) => ({
      request_id: i.request_id,
      window_start: i.window_start,
      window_end: i.window_end,
      model: i.model,
      usage: i.usage,
      requests: i.requests,
      cost_usd: i.cost_usd,
    }));
    const simulated = items.some((i) => i.simulated) || marker!.provenance === 'simulated';
    const response: UsageResponse = {
      key_id: caller.key_id,
      from,
      to,
      granularity: opts.granularity && opts.granularity !== granularity ? reaggregate(records, opts.granularity).granularity : granularity,
      records: opts.granularity && opts.granularity !== granularity ? reaggregate(records, opts.granularity).records : records,
      simulated,
      ...(marker!.ingestion_delay_minutes !== undefined ? { ingestion_delay_minutes: marker!.ingestion_delay_minutes } : {}),
    };
    return {
      response,
      granularity,
      provenance: marker!.provenance,
      source: marker!.source,
      synced,
      synced_at: marker!.synced_at ?? null,
    };
  }

  /**
   * Snapshots YA guardados de una key en [from, to], sin ir a MagiHub (sirve para keys que no son
   * la del caller, p. ej. las sesiones de una tarea). null si la key nunca se sincronizó.
   */
  async cachedWindow(
    tenantId: string,
    keyId: string,
    from: string,
    to: string,
  ): Promise<{ records: UsageRecord[]; granularity: UsageGranularity; provenance: Provenance; source: DataSource; ingestion_delay_minutes?: number } | null> {
    const marker = await this.repo.getMarker(tenantId, keyId);
    if (!marker) return null;
    const g = marker.granularity;
    const lower = g === 'hour' ? iso(floorTo(Date.parse(from), HOUR_MS)) : g === 'day' ? iso(floorTo(Date.parse(from), DAY_MS)) : from;
    const items = await this.repo.listRecords(tenantId, keyId, g, lower, to);
    const simulated = items.some((i) => i.simulated) || marker.provenance === 'simulated';
    const { provenance, source } = simulated ? this.provenanceOf(true) : { provenance: marker.provenance, source: marker.source };
    return {
      records: items.map((i) => ({
        request_id: i.request_id,
        window_start: i.window_start,
        window_end: i.window_end,
        model: i.model,
        usage: i.usage,
        requests: i.requests,
        cost_usd: i.cost_usd,
      })),
      granularity: g,
      provenance,
      source,
      ...(marker.ingestion_delay_minutes !== undefined ? { ingestion_delay_minutes: marker.ingestion_delay_minutes } : {}),
    };
  }
}

/** Reagrega registros a hora/día (solo hacia granularidades más gruesas). */
export function reaggregate(records: UsageRecord[], target: UsageGranularity): { granularity: UsageGranularity; records: UsageRecord[] } {
  if (target === 'request') return { granularity: 'request', records };
  const size = target === 'hour' ? HOUR_MS : DAY_MS;
  const buckets = new Map<number, UsageRecord>();
  for (const r of records) {
    const b = floorTo(Date.parse(r.window_start), size);
    const cur = buckets.get(b) ?? {
      window_start: iso(b),
      window_end: iso(b + size),
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      requests: 0,
    };
    cur.usage.prompt_tokens += r.usage.prompt_tokens;
    cur.usage.completion_tokens += r.usage.completion_tokens;
    cur.usage.total_tokens += r.usage.total_tokens;
    if (r.usage.cached_tokens) cur.usage.cached_tokens = (cur.usage.cached_tokens ?? 0) + r.usage.cached_tokens;
    cur.requests += r.requests;
    if (typeof r.cost_usd === 'number') cur.cost_usd = (cur.cost_usd ?? 0) + r.cost_usd;
    buckets.set(b, cur);
  }
  return { granularity: target, records: [...buckets.values()].sort((a, b) => a.window_start.localeCompare(b.window_start)) };
}

export const usageService = new UsageService();
