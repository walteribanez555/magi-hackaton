import { describe, expect, it } from 'vitest';
import { ProductivitySummary } from '@magicode/contracts';
import {
  computeChangeItems,
  computeSessionItems,
  computeSummary,
  computeTimeline,
  highestStage,
  per100,
  ratio,
  redundantRegenerations,
  worst,
} from '../productivity.metrics';
import { accepted, change, commit, input, ref, request, session, usageRec } from './fixtures';

/** Escenario base: 3 peticiones (una redundante), 1 aceptado, 1 rechazado, 1 solo propuesto. */
const scenario = () => {
  const requests = [
    request('r1', 1000, { output_hash: 'aaaa1111', occurred_at: '2026-10-20T10:05:00.000Z' }),
    request('r2', 400, { output_hash: 'bbbb2222', occurred_at: '2026-10-20T10:10:00.000Z', model: 'mock-haiku' }),
    request('r3', 600, { output_hash: 'AAAA1111', occurred_at: '2026-10-20T10:15:00.000Z' }),
  ];
  const changes = [
    accepted('c1', 'r1', 20, { d: { effective: 12, mechanical: 4 } }),
    change('c2', 'r2', { status: 'rejected', proposed_added_lines: 8 }),
    change('c3', 'r3', { proposed_added_lines: 5 }),
  ];
  const commits = [commit('a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0', ['c1'], 18)];
  const references = [ref('demo-v1', 15)];
  const usage = {
    granularity: 'request' as const,
    provenance: 'real' as const,
    source: 'magihub-usage-api' as const,
    records: [usageRec('r1', 1000), usageRec('r2', 400), usageRec('r3', 600), usageRec('other-app', 500)],
  };
  return input({ requests, changes, commits, references, usage });
};

describe('helpers', () => {
  it('ratio/per100 devuelven null con denominador 0', () => {
    expect(ratio(5, 0)).toBeNull();
    expect(per100(1000, 0)).toBeNull();
    expect(per100(null, 10)).toBeNull();
    expect(per100(1000, 20)).toBe(5000);
  });

  it('worst: simulated > estimated > real', () => {
    expect(worst('real', 'estimated')).toBe('estimated');
    expect(worst('estimated', 'simulated', 'real')).toBe('simulated');
    expect(worst()).toBe('real');
  });
});

describe('computeSummary — embudo y tokens', () => {
  const s = computeSummary(scenario());

  it('cumple el schema de contracts', () => {
    expect(() => ProductivitySummary.parse(s)).not.toThrow();
  });

  it('total = API de consumo; reconciliación muestra lo que no reportó el IDE', () => {
    expect(s.tokens.total).toMatchObject({ value: 2500, provenance: 'real', source: 'magihub-usage-api' });
    expect(s.tokens.reported_by_requests.value).toBe(2000);
    expect(s.tokens.unreconciled.value).toBe(500);
  });

  it('desglose: aceptados, exploración, regeneraciones redundantes, mecánico', () => {
    expect(s.tokens.on_accepted.value).toBe(1000);
    expect(s.tokens.on_rejected.value).toBe(1000); // r2 + r3 (sin cambio aceptado)
    expect(s.tokens.on_redundant_regenerations.value).toBe(600); // r3 repite el output_hash de r1
    expect(s.tokens.on_mechanical.value).toBe(200); // 1000 × 4/20
    expect(s.tokens.on_mechanical.provenance).toBe('estimated');
    expect(s.dimensions.redundancy.redundant_regenerations).toBe(1);
  });

  it('líneas y tokens/100 por etapa', () => {
    const byStage = Object.fromEntries(s.funnel.map((f) => [f.stage, f]));
    expect(byStage.generated!.lines.value).toBe(33);
    expect(byStage.accepted!.lines.value).toBe(20);
    expect(byStage.committed!.lines.value).toBe(18);
    expect(byStage.in_reference!.lines.value).toBe(15);
    expect(byStage.deployed!.lines.value).toBe(0);

    expect(byStage.accepted!.tokens_per_100_lines.value).toBe(12500);
    expect(byStage.accepted!.tokens_per_100_effective_lines.value).toBeCloseTo(20833.3333, 3);
    expect(byStage.generated!.tokens_per_100_lines.value).toBeCloseTo(7575.7576, 3);
    expect(byStage.generated!.effective_lines.value).toBeNull();
    expect(byStage.generated!.tokens_per_100_effective_lines.value).toBeNull();
    // desplegado sin líneas ⇒ null (nunca Infinity)
    expect(byStage.deployed!.tokens_per_100_lines.value).toBeNull();
    expect(byStage.deployed!.tokens_per_100_effective_lines.value).toBeNull();
  });

  it('conversión = etapa / etapa anterior', () => {
    const conv = s.funnel.map((f) => f.conversion.value);
    expect(conv[0]).toBeNull();
    expect(conv[1]).toBeCloseTo(20 / 33, 4);
    expect(conv[2]).toBe(0.9);
    expect(conv[3]).toBeCloseTo(15 / 18, 4);
    expect(conv[4]).toBe(0);
  });

  it('atribución exacta y procedencia global = peor presente', () => {
    expect(s.attribution).toBe('exact');
    expect(s.overall_provenance).toBe('estimated'); // líneas efectivas/hash matching son estimadas
    expect(s.funnel[3]!.lines.provenance).toBe('estimated');
    expect(s.funnel[1]!.lines.provenance).toBe('real');
  });

  it('counts y by_model', () => {
    expect(s.counts).toMatchObject({ ai_requests: 3, changes_proposed: 3, changes_accepted: 1, changes_rejected: 1, commits: 1, references: 1 });
    const sonnet = s.by_model.find((b) => b.model === 'mock-sonnet')!;
    expect(sonnet).toMatchObject({ requests: 2, accepted_lines: 20 });
    expect(sonnet.tokens.value).toBe(1600);
  });
});

describe('computeSummary — denominadores 0 y casos vacíos', () => {
  it('sin datos: todo 0/null, sin NaN', () => {
    const s = computeSummary(input({ usage: { granularity: 'request', provenance: 'real', source: 'magihub-usage-api', records: [] } }));
    expect(s.tokens.total.value).toBe(0);
    for (const f of s.funnel) {
      expect(f.tokens_per_100_lines.value).toBeNull();
      expect(f.tokens_per_100_effective_lines.value).toBeNull();
    }
    expect(s.dimensions.importance.score.value).toBeNull();
    expect(s.dimensions.automation.ai_share_of_commits.value).toBeNull();
    expect(s.attribution).toBe('exact');
    expect(() => ProductivitySummary.parse(s)).not.toThrow();
  });
});

describe('computeSummary — procedencia', () => {
  it('sin API de consumo ⇒ fallback a Σ reportado como estimated', () => {
    const s = computeSummary({ ...scenario(), usage: null });
    expect(s.tokens.total).toMatchObject({ value: 2000, provenance: 'estimated', source: 'magihub-response' });
    expect(s.tokens.unreconciled.value).toBe(0);
    expect(s.attribution).toBe('estimated');
  });

  it('usage vacío pero peticiones con usage ⇒ fallback estimated', () => {
    const s = computeSummary({ ...scenario(), usage: { granularity: 'request', provenance: 'real', source: 'magihub-usage-api', records: [] } });
    expect(s.tokens.total.value).toBe(2000);
    expect(s.tokens.total.provenance).toBe('estimated');
    expect(s.attribution).toBe('estimated');
  });

  it('MAGIHUB_MODE=mock ⇒ toda cifra de tokens es simulated (magihub-mock)', () => {
    const s = computeSummary({ ...scenario(), magihubMode: 'mock' });
    expect(s.tokens.total).toMatchObject({ provenance: 'simulated', source: 'magihub-mock' });
    expect(s.tokens.on_accepted.provenance).toBe('simulated');
    expect(s.funnel[1]!.tokens_per_100_lines.provenance).toBe('simulated');
    expect(s.overall_provenance).toBe('simulated');
  });

  it('datos del seed (demo-seed) ⇒ líneas simulated', () => {
    const base = scenario();
    const s = computeSummary({
      ...base,
      changes: base.changes.map((c) => ({ ...c, provenance: 'simulated' as const, source: 'demo-seed' as const })),
    });
    expect(s.funnel[1]!.lines).toMatchObject({ provenance: 'simulated', source: 'demo-seed' });
    expect(s.overall_provenance).toBe('simulated');
  });

  it('granularidad hora + alcance ⇒ prorrateo estimated y atribución estimated', () => {
    const reqs = [request('r1', 300, { occurred_at: '2026-10-20T10:05:00.000Z' })];
    const other = request('rX', 100, { session_id: 's9', occurred_at: '2026-10-20T10:20:00.000Z' });
    const s = computeSummary(
      input({
        scoped: true,
        scope: { tenant_id: 't1', key_id: 'k1', session_id: 's1', from: '2026-10-20T00:00:00.000Z', to: '2026-10-20T23:00:00.000Z' },
        requests: reqs,
        keyRequests: [...reqs, other],
        usage: {
          granularity: 'hour',
          provenance: 'real',
          source: 'magihub-usage-api',
          records: [usageRec(undefined, 480, { window_start: '2026-10-20T10:00:00.000Z', window_end: '2026-10-20T11:00:00.000Z', requests: 2 })],
        },
      }),
    );
    // 480 × 300/400 = 360
    expect(s.tokens.total).toMatchObject({ value: 360, provenance: 'estimated' });
    expect(s.attribution).toBe('estimated');
  });

  it('alcance + granularidad request ⇒ solo los request_id del alcance', () => {
    const s = computeSummary({ ...scenario(), scoped: true });
    expect(s.tokens.total.value).toBe(2000);
    expect(s.tokens.unreconciled.value).toBe(0);
  });
});

describe('etapa desplegado', () => {
  it('demo-reference NO cuenta como desplegado; deployment sí', () => {
    const base = scenario();
    const s1 = computeSummary(base);
    expect(s1.funnel[4]!.lines.value).toBe(0);
    const s2 = computeSummary({
      ...base,
      references: [...base.references, ref('prod-1', 12, { kind: 'deployment', evidence_url: 'https://ci/x', occurred_at: '2026-10-20T11:00:00.000Z' })],
    });
    expect(s2.funnel[4]!.lines).toMatchObject({ value: 12, source: 'deployment-evidence' });
  });

  it('Deployment success del webhook para el SHA del commit ⇒ desplegado', () => {
    const base = scenario();
    const sha = base.commits[0]!.sha;
    const s = computeSummary({ ...base, deployments: [{ repository: 'org/repo', sha, state: 'success', deployment_id: 'd1' }] });
    expect(s.funnel[4]!.lines.value).toBe(18);
    expect(s.counts.deployments_success).toBe(1);
    const failed = computeSummary({ ...base, deployments: [{ repository: 'org/repo', sha, state: 'failure', deployment_id: 'd2' }] });
    expect(failed.funnel[4]!.lines.value).toBe(0);
  });
});

describe('regeneraciones redundantes', () => {
  it('solo cuenta repeticiones POSTERIORES dentro de la misma sesión', () => {
    const reqs = [
      request('a', 10, { output_hash: 'deadbeef', occurred_at: '2026-10-20T10:00:00.000Z' }),
      request('b', 10, { output_hash: 'deadbeef', occurred_at: '2026-10-20T10:01:00.000Z' }),
      request('c', 10, { output_hash: 'deadbeef', occurred_at: '2026-10-20T10:02:00.000Z', session_id: 's2' }),
      request('d', 10, { output_hash: 'deadbeef', occurred_at: '2026-10-20T10:03:00.000Z' }),
      request('e', 10, { occurred_at: '2026-10-20T10:04:00.000Z' }),
    ];
    expect(redundantRegenerations(reqs).map((r) => r.ai_request_id)).toEqual(['b', 'd']);
  });
});

describe('listas', () => {
  it('sesiones: tokens, etapa más alta y commits', () => {
    const items = computeSessionItems({ ...scenario(), sessions: [session('s1', { branch: 'feature/MAG-1-x', task_key: 'MAG-1' })] });
    expect(items[0]).toMatchObject({ session_id: 's1', ai_requests: 3, accepted_lines: 20, effective_lines: 12, branch: 'feature/MAG-1-x', task_key: 'MAG-1' });
    expect(items[0]!.tokens.value).toBe(2000);
    expect(items[0]!.highest_stage).toBe('accepted');
  });

  it('highestStage respeta el orden del embudo', () => {
    expect(highestStage([])).toBe('generated');
    expect(highestStage([change('x', 'r', { status: 'rejected' })])).toBe('generated');
    expect(highestStage([change('x', 'r', { status: 'committed' }), change('y', 'r', { status: 'in_reference' })])).toBe('in_reference');
    expect(highestStage([change('x', 'r', { status: 'committed', commit_sha: 'abc1234' })], new Set(['abc1234'.padEnd(40, '0')]))).toBe('deployed');
  });

  it('cambios: tokens de la petición repartidos y scores null por defecto', () => {
    const base = scenario();
    const items = computeChangeItems({ ...base, changes: [...base.changes, change('c4', 'r1')] });
    const c1 = items.find((c) => c.change_id === 'c1')!;
    expect(c1.tokens.value).toBe(500); // r1 (1000) / 2 cambios
    expect(c1.scores).toBeNull();
    expect(c1.effective_lines).toBe(12);
  });

  it('timeline rellena buckets y suma tokens/líneas', () => {
    const base = scenario();
    const pts = computeTimeline(
      { ...base, scope: { ...base.scope, from: '2026-10-20T09:00:00.000Z', to: '2026-10-20T11:00:00.000Z' } },
      'hour',
    );
    expect(pts).toHaveLength(3);
    const ten = pts.find((p) => p.bucket_start === '2026-10-20T10:00:00.000Z')!;
    expect(ten.tokens).toBe(2500);
    expect(ten.accepted_lines).toBe(20);
    expect(ten.committed_lines).toBe(18);
  });
});
