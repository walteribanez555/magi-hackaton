import { describe, expect, it, vi } from 'vitest';
import { ChangeScores, SCORING_FEATURES, keys } from '@magicode/contracts';
import { buildFeatureVector } from '../scoring.features';
import { heuristicPredict } from '../scoring.heuristic';
import {
  createScoringService,
  onChangeAccepted,
  parseProbability,
  readScoringEnv,
  scoringInputFromAcceptedEvent,
} from '../scoring.service';
import type { EndpointInvoker, ScoringEnv } from '../scoring.types';
import { changeItem, ctx } from './fixtures';

const env = (o: Partial<ScoringEnv> = {}): ScoringEnv => ({
  survivalEndpoint: 'magicode-dev-survival',
  reworkEndpoint: 'magicode-dev-rework',
  trainedOn: 'synthetic',
  modelVersion: '20261020-000000',
  timeoutMs: 300,
  cooldownMs: 60_000,
  ...o,
});

const okInvoker = (s = '0.81', r = '0.42'): EndpointInvoker =>
  vi.fn(async (name: string) => (name.endsWith('survival') ? `${s}\n` : r));

describe('scoringService.scoreChange', () => {
  it('usa XGBoost cuando los endpoints responden: CSV en orden, provenance simulated (sintético)', async () => {
    const invoker = okInvoker();
    const svc = createScoringService({ invoker, env: () => env() });
    const scores = await svc.scoreChange({ change: changeItem(), ctx: ctx() });

    expect(ChangeScores.parse(scores)).toEqual(scores);
    expect(scores.survival_probability).toBe(0.81);
    expect(scores.rework_risk).toBe(0.42);
    expect(scores.model_version).toBe('xgboost:20261020-000000');
    expect(scores.provenance).toBe('simulated');
    expect(scores.top_factors.length).toBeGreaterThan(0);
    expect(scores.top_factors.length).toBeLessThanOrEqual(5);

    const [name, csv] = (invoker as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(name).toBe('magicode-dev-survival');
    expect(String(csv).split(',')).toHaveLength(SCORING_FEATURES.length);
  });

  it('modelo entrenado con datos reales ⇒ provenance estimated', async () => {
    const svc = createScoringService({ invoker: okInvoker(), env: () => env({ trainedOn: 'real' }) });
    expect((await svc.scoreChange({ change: changeItem(), ctx: ctx() })).provenance).toBe('estimated');
  });

  it('cae a la heurística si el endpoint falla (y abre el circuito)', async () => {
    const invoker = vi.fn(async () => {
      throw new Error('ValidationError: Endpoint magicode-dev-rework of account 1 not found.');
    });
    let t = 1_000;
    const svc = createScoringService({ invoker, env: () => env(), now: () => t });
    const v = buildFeatureVector(changeItem(), ctx());

    const s1 = await svc.scoreChange({ change: changeItem(), ctx: ctx() });
    expect(s1.model_version).toBe('heuristic:v1');
    expect(s1.provenance).toBe('estimated');
    expect(s1.survival_probability).toBeCloseTo(heuristicPredict('survival', v), 4);
    expect(s1.rework_risk).toBeCloseTo(heuristicPredict('rework', v), 4);
    expect(ChangeScores.parse(s1)).toEqual(s1);
    const calls = invoker.mock.calls.length;

    await svc.scoreChange({ change: changeItem(), ctx: ctx() }); // circuito abierto: no invoca
    expect(invoker.mock.calls.length).toBe(calls);

    t += 61_000; // pasó el cooldown → reintenta
    await svc.scoreChange({ change: changeItem(), ctx: ctx() });
    expect(invoker.mock.calls.length).toBeGreaterThan(calls);
  });

  it('cae a la heurística por timeout (presupuesto 300 ms) y aborta la petición', async () => {
    let aborted = false;
    const slow: EndpointInvoker = (_n, _b, signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => (aborted = true));
        setTimeout(() => resolve('0.5'), 5_000);
      });
    const svc = createScoringService({ invoker: slow, env: () => env({ timeoutMs: 30 }) });
    const t0 = Date.now();
    const s = await svc.scoreChange({ change: changeItem(), ctx: ctx() });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(s.model_version).toBe('heuristic:v1');
    expect(aborted).toBe(true);
  });

  it('todo-o-nada: si solo un endpoint falla, ambos scores salen de la heurística', async () => {
    const half: EndpointInvoker = async (name) => {
      if (name.endsWith('rework')) throw new Error('boom');
      return '0.9';
    };
    const s = await createScoringService({ invoker: half, env: () => env() }).scoreChange({ change: changeItem(), ctx: ctx() });
    expect(s.model_version).toBe('heuristic:v1');
    expect(s.survival_probability).not.toBe(0.9);
  });

  it('respuesta no numérica o fuera de 0..1 ⇒ heurística', async () => {
    const svc = createScoringService({ invoker: okInvoker('<html>', '1.7'), env: () => env() });
    expect((await svc.scoreChange({ change: changeItem(), ctx: ctx() })).model_version).toBe('heuristic:v1');
  });

  it('sin endpoints configurados o sin SDK instalado ⇒ heurística sin lanzar', async () => {
    const noEnv = createScoringService({ invoker: okInvoker(), env: () => env({ survivalEndpoint: '' }) });
    expect((await noEnv.scoreChange({ change: changeItem() })).model_version).toBe('heuristic:v1');
    // invoker real: en tests @aws-sdk/client-sagemaker-runtime no está instalado → import() falla
    const realSdk = createScoringService({ env: () => env() });
    expect((await realSdk.scoreChange({ change: changeItem() })).model_version).toBe('heuristic:v1');
  });
});

describe('helpers', () => {
  it('parseProbability tolera salto de línea / coma final', () => {
    expect(parseProbability('0.25\n')).toBe(0.25);
    expect(parseProbability('0.25,')).toBe(0.25);
    expect(() => parseProbability('')).toThrow();
  });

  it('readScoringEnv: default conservador synthetic y 300 ms', () => {
    const e = readScoringEnv({ SCORING_SURVIVAL_ENDPOINT: 'a', SCORING_REWORK_ENDPOINT: 'b' });
    expect(e.trainedOn).toBe('synthetic');
    expect(e.timeoutMs).toBe(300);
    expect(readScoringEnv({ SCORING_TRAINED_ON: 'real' }).trainedOn).toBe('real');
  });
});

describe('onChangeAccepted', () => {
  const heuristicOnly = createScoringService({ invoker: null, env: () => env() });

  it('devuelve scores + UpdateCommand que persiste `scores` en el ítem Change', async () => {
    const { scores, update } = await onChangeAccepted(
      changeItem(),
      { ...ctx(), tableName: 'magicode-dev-productivity', nowIso: '2026-10-20T12:00:00.000Z' },
      heuristicOnly,
    );
    expect(update.TableName).toBe('magicode-dev-productivity');
    expect(update.Key).toEqual({ PK: 'T#t1#S#s1', SK: 'C#c1' });
    expect(update.UpdateExpression).toContain('#scores = :scores');
    expect(update.ConditionExpression).toBe('attribute_exists(PK)');
    expect(update.ExpressionAttributeValues?.[':scores']).toEqual(scores);
    expect(update.ExpressionAttributeValues?.[':now']).toBe('2026-10-20T12:00:00.000Z');
  });

  it('deriva la clave con keys.change desde el evento code.accepted', async () => {
    const input = scoringInputFromAcceptedEvent({
      tenant_id: 't1',
      session_id: 's#1',
      change_id: 'c2',
      event: {
        occurred_at: '2026-10-20T10:00:00Z',
        branch: 'main',
        payload: { files: [{ path: 'src/a.ts', added: 3, deleted: 0 }], accepted_added_lines: 3, accepted_deleted_lines: 0 },
      },
    });
    const { update } = await onChangeAccepted(input, {}, heuristicOnly);
    expect(update.Key).toEqual(keys.change('t1', 's#1', 'c2'));
  });

  it('falla explícito si no hay forma de construir la clave', async () => {
    await expect(onChangeAccepted({ accepted_added_lines: 1 }, {}, heuristicOnly)).rejects.toThrow(/PK\/SK/);
  });
});
