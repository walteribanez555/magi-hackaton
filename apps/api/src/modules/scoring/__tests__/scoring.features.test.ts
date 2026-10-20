import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCORING_FEATURES } from '@magicode/contracts';
import { buildFeatures, buildFeatureVector, hourOfDay, tierShares, toCsvRow } from '../scoring.features';
import { changeItem, ctx, dims } from './fixtures';

const ROOT = join(__dirname, '../../../../../..');

describe('vector de features', () => {
  it('sigue exactamente el orden de SCORING_FEATURES (y el de ml/features.json)', () => {
    const v = buildFeatureVector(changeItem(), ctx());
    expect(Object.keys(v)).toEqual([...SCORING_FEATURES]);
    const mlJson = JSON.parse(readFileSync(join(ROOT, 'ml/features.json'), 'utf8')) as { features: string[] };
    expect(mlJson.features).toEqual([...SCORING_FEATURES]);
  });

  it('aplica las definiciones de ml/features.py sobre un ítem Change de Dynamo', () => {
    const { vector: v, tier_weight } = buildFeatures(changeItem(), ctx());
    expect(v.accepted_added_lines).toBe(40);
    expect(v.files_count).toBe(2);
    expect(v.edited_before_accept_ratio).toBeCloseTo(10 / 40);
    expect(v.core_tier_share).toBeCloseTo(30 / 40);
    expect(v.test_tier_share).toBeCloseTo(10 / 40);
    expect(v.logic_kind_share).toBeCloseTo(20 / 40);
    expect(v.test_kind_share).toBeCloseTo(8 / 40);
    expect(v.tokens_per_effective_line).toBeCloseTo(5100 / 25.5);
    expect(v.has_task).toBe(1);
    expect(v.task_is_bug).toBe(1);
    expect(v.branch_is_default).toBe(0);
    expect(v.hour_of_day).toBe(2); // 23:15 −03:00 = 02:15 UTC
    expect(tier_weight).toBeCloseTo(0.75 * 1 + 0.25 * 0.9);
  });

  it('acepta el payload de code.accepted (files/occurred_at) y variantes aplanadas', () => {
    const v = buildFeatureVector(
      {
        files: [{ path: 'README.md', added: 5, deleted: 0 }],
        accepted_added_lines: 5,
        importance_score: 0.2,
        redundancy_score: 0.1,
        mechanical_share: 0,
        effective_lines: 0,
        branch: 'main',
        occurred_at: '2026-10-20T05:00:00Z',
      },
      {},
    );
    expect(v.importance_score).toBe(0.2);
    expect(v.tokens_per_effective_line).toBe(0);
    expect(v.branch_is_default).toBe(1);
    expect(v.has_task).toBe(0);
    expect(v.task_is_bug).toBe(0);
    expect(v.hour_of_day).toBe(5);
    expect(v.session_acceptance_rate).toBe(0.6); // imputación neutral (igual en Python)
  });

  it('respeta la rama default declarada y no marca Bug sin tarea', () => {
    const v = buildFeatureVector(changeItem({ branch: 'trunk-x', task_key: null }), ctx({ default_branch: 'trunk-x' }));
    expect(v.branch_is_default).toBe(1);
    expect(v.task_is_bug).toBe(0);
  });

  it('acota ratios a 0..1 aunque los conteos vengan inconsistentes', () => {
    const v = buildFeatureVector(changeItem({ dimensions: dims({ lines: 2, logic: 9 }) }), ctx());
    expect(v.logic_kind_share).toBe(1);
  });

  it('CSV sin cabecera en el orden del contrato', () => {
    const v = buildFeatureVector(changeItem(), ctx());
    const parts = toCsvRow(v).split(',');
    expect(parts).toHaveLength(SCORING_FEATURES.length);
    expect(Number(parts[0])).toBe(40);
    expect(Number(parts[SCORING_FEATURES.indexOf('task_is_bug')])).toBe(1);
  });

  it('tiers por ruta con @magicode/metrics (mismo clasificador que la extensión)', () => {
    const s = tierShares([
      { path: 'src/a.ts', added: 3, deleted: 0 },
      { path: 'package-lock.json', added: 1, deleted: 0 },
    ]);
    expect(s.core).toBeCloseTo(0.75);
    expect(s.generated).toBeCloseTo(0.25);
    expect(hourOfDay('basura')).toBe(12);
  });
});
