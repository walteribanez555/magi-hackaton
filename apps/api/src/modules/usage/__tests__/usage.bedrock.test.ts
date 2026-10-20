import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../../../config/config';
import { computeSummary, resolveRequestTokens } from '../../productivity/productivity.metrics';
import { input, request, usageRec } from '../../productivity/__tests__/fixtures';
import type { MagiHubClient } from '../../magihub';
import type { UsageRepository } from '../usage.repository';
import { UsageService } from '../usage.service';
import { app } from '../../../app';

process.env.LOG_LEVEL = 'error';
const ORIGINAL = process.env.MAGIHUB_MODE;

const setMode = (m: string | undefined) => {
  if (m === undefined) delete process.env.MAGIHUB_MODE;
  else process.env.MAGIHUB_MODE = m;
  config.reload();
};

afterEach(() => setMode(ORIGINAL));

/** Sincroniza una ventana con un cliente falso y devuelve el marker guardado. */
async function syncWith(simulated: boolean) {
  const saved: Array<{ provenance: string; source: string }> = [];
  const repo = {
    getMarker: async () => undefined,
    putRecords: async (items: Array<{ provenance: string; source: string }>) => void saved.push(...items),
    putMarker: async () => undefined,
  } as unknown as UsageRepository;
  const client = {
    usage: async () => ({
      key_id: 'k1',
      from: '2026-10-20T00:00:00.000Z',
      to: '2026-10-20T01:00:00.000Z',
      granularity: 'request',
      records: [usageRec('r1', 100)],
      simulated,
    }),
  } as unknown as MagiHubClient;
  const svc = new UsageService(repo, () => client, () => Date.parse('2026-10-20T12:00:00.000Z'));
  const marker = await svc.sync({ tenant_id: 't1', key_id: 'k1' }, 'key', '2026-10-20T00:00:00.000Z', '2026-10-20T01:00:00.000Z');
  return { marker, saved };
}

describe('MAGIHUB_MODE=bedrock', () => {
  it('config acepta bedrock (además de real|mock; cualquier otro valor ⇒ mock)', () => {
    setMode('bedrock');
    expect(config.getValue('magihub').mode).toBe('bedrock');
    setMode('real');
    expect(config.getValue('magihub').mode).toBe('real');
    setMode('otro');
    expect(config.getValue('magihub').mode).toBe('mock');
    setMode(undefined);
    expect(config.getValue('magihub').mode).toBe('mock');
  });

  it('snapshots de /v1/usage del adaptador ⇒ real con source bedrock', async () => {
    setMode('bedrock');
    const { marker, saved } = await syncWith(false);
    expect(marker).toMatchObject({ provenance: 'real', source: 'bedrock' });
    expect(saved[0]).toMatchObject({ provenance: 'real', source: 'bedrock' });
    // si el adaptador marcara simulated=true, sigue siendo simulated
    expect((await syncWith(true)).marker).toMatchObject({ provenance: 'simulated', source: 'magihub-mock' });
    setMode('real');
    expect((await syncWith(false)).marker).toMatchObject({ provenance: 'real', source: 'magihub-usage-api' });
  });

  it('usage por petición con usage_source bedrock ⇒ real / bedrock (también el fallback Σ reportado)', () => {
    const reqs = [request('r1', 1000, { usage_source: 'bedrock' }), request('r2', 500, { usage_source: 'bedrock' })];
    const tokens = resolveRequestTokens(input({ magihubMode: 'bedrock', requests: reqs }));
    expect(tokens.get('r1')).toMatchObject({ tokens: 1000, provenance: 'real', source: 'bedrock' });

    const s = computeSummary(input({ magihubMode: 'bedrock', requests: reqs }));
    expect(s.tokens.reported_by_requests).toMatchObject({ value: 1500, provenance: 'real', source: 'bedrock' });
    expect(s.tokens.total).toMatchObject({ value: 1500, provenance: 'estimated', source: 'bedrock' });
  });

  it('API de consumo (bedrock) ⇒ total real sin simulated', () => {
    const reqs = [request('r1', 1000, { usage_source: 'bedrock' })];
    const s = computeSummary(
      input({
        magihubMode: 'bedrock',
        requests: reqs,
        usage: { granularity: 'request', provenance: 'real', source: 'bedrock', records: [usageRec('r1', 1200)] },
      }),
    );
    expect(s.tokens.total).toMatchObject({ value: 1200, provenance: 'real', source: 'bedrock' });
    expect(s.overall_provenance).not.toBe('simulated');
  });

  it('/health expone magihub_mode=bedrock', async () => {
    setMode('bedrock');
    const res = await app.request('/api/v1/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', magihub_mode: 'bedrock' });
  });
});
