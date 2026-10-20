import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FeatureVector } from '@magicode/contracts';
import { buildFeatureVector } from '../scoring.features';
import { HEURISTIC_VERSION, HEURISTIC_WEIGHTS, heuristicPredict } from '../scoring.heuristic';
import { criticalityFrom } from '../scoring.service';
import { changeItem, ctx } from './fixtures';

const base = (): FeatureVector => buildFeatureVector(changeItem(), ctx());
const withF = (o: Partial<FeatureVector>): FeatureVector => ({ ...base(), ...o });

describe('heurística heuristic:v1', () => {
  it('usa los mismos pesos que ml/heuristic_weights.json (fuente de verdad)', () => {
    const src = JSON.parse(readFileSync(join(__dirname, '../../../../../../ml/heuristic_weights.json'), 'utf8'));
    expect(HEURISTIC_VERSION).toBe('heuristic:v1');
    expect(HEURISTIC_WEIGHTS.survival).toEqual(src.survival);
    expect(HEURISTIC_WEIGHTS.rework).toEqual(src.rework);
    expect(HEURISTIC_WEIGHTS.criticality).toEqual(src.criticality);
  });

  it('monotonía: más redundancia ⇒ menor supervivencia (estricta en todo el rango)', () => {
    const ps = [0, 0.2, 0.4, 0.6, 0.8, 1].map((r) => heuristicPredict('survival', withF({ redundancy_score: r })));
    for (let i = 1; i < ps.length; i++) expect(ps[i]!).toBeLessThan(ps[i - 1]!);
  });

  it('monotonía: más código mecánico ⇒ menor supervivencia', () => {
    expect(heuristicPredict('survival', withF({ mechanical_share: 0.9 }))).toBeLessThan(
      heuristicPredict('survival', withF({ mechanical_share: 0.1 })),
    );
  });

  it('tarea Bug y cambio grande sin tests en core ⇒ más riesgo de retrabajo', () => {
    expect(heuristicPredict('rework', withF({ task_is_bug: 1 }))).toBeGreaterThan(heuristicPredict('rework', withF({ task_is_bug: 0 })));
    const bigUntested = withF({ accepted_added_lines: 300, core_tier_share: 1, test_tier_share: 0 });
    const smallTested = withF({ accepted_added_lines: 10, core_tier_share: 0.6, test_tier_share: 0.4 });
    expect(heuristicPredict('rework', bigUntested)).toBeGreaterThan(heuristicPredict('rework', smallTested) + 0.15);
  });

  it('paridad numérica con ml/features.py + ml/heuristic.py (mismo ítem → mismo vector y score)', () => {
    // Referencia: features.build_feature_row(<fixture changeItem>, <fixture ctx>) y
    // heuristic.predict(...) ejecutados en Python 3.12 sobre el mismo ítem.
    const v = base();
    expect(v).toEqual({
      accepted_added_lines: 40, accepted_deleted_lines: 2, files_count: 2, importance_score: 0.75,
      redundancy_score: 0.05, mechanical_share: 0.3, effective_lines: 25.5, edited_before_accept_ratio: 0.25,
      core_tier_share: 0.75, test_tier_share: 0.25, logic_kind_share: 0.5, test_kind_share: 0.2,
      tokens_total: 5100, tokens_per_effective_line: 200, regenerations: 1, latency_ms: 900,
      session_acceptance_rate: 0.5, has_task: 1, task_is_bug: 1, branch_is_default: 0, hour_of_day: 2,
    });
    expect(heuristicPredict('survival', v)).toBeCloseTo(0.7777714441661158, 10);
    expect(heuristicPredict('rework', v)).toBeCloseTo(0.5072536128739267, 10);
  });
});

describe('criticidad', () => {
  it('rework^0.7 × exposure^0.3 con umbrales de CRITICALITY_THRESHOLDS', () => {
    expect(criticalityFrom(0.2, 0.8, 0.8).level).toBe('low');
    expect(criticalityFrom(0.4, 0.5, 0.5).level).toBe('medium');
    expect(criticalityFrom(0.55, 0.9, 1).level).toBe('high');
    expect(criticalityFrom(0.85, 1, 1).level).toBe('critical');
  });

  it('docs/generated (exposición 0) nunca es crítico aunque el riesgo sea alto', () => {
    expect(criticalityFrom(0.95, 0, 0)).toEqual({ score: 0, level: 'low' });
  });

  it('crece con el riesgo de retrabajo y con la importancia', () => {
    expect(criticalityFrom(0.6, 0.5, 1).score).toBeGreaterThan(criticalityFrom(0.3, 0.5, 1).score);
    expect(criticalityFrom(0.5, 0.9, 1).score).toBeGreaterThan(criticalityFrom(0.5, 0.1, 1).score);
  });
});
