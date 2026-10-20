import type { ChangeDimensions } from '@magicode/contracts';
import type { ScoringChangeInput, ScoringContext } from '../scoring.types';

/** Dimensiones coherentes con docs/metrics-model.md (conteos, nunca código). */
export const dims = (o: Partial<{ lines: number; logic: number; test: number; redundancy: number; mechanical: number; edited: number; effective: number; importance: number }> = {}): ChangeDimensions => {
  const lines = o.lines ?? 40;
  const logic = o.logic ?? 20;
  const test = o.test ?? 8;
  const edited = o.edited ?? 10;
  return {
    importance: {
      lines,
      weighted_lines: (o.importance ?? 0.75) * lines,
      score: o.importance ?? 0.75,
      by_kind: { logic, declaration: 0, test, config: 0, comment: 0, import: 4, trivial: lines - logic - test - 4 },
    },
    redundancy: { intra_change: 0, existing_in_repo: 0, repeated_in_session: 0, redundant_lines: 0, score: o.redundancy ?? 0.05 },
    automation: { mechanical_lines: 0, mechanical_share: o.mechanical ?? 0.3, accepted_as_is: lines - edited, edited_before_accept: edited },
    effective_lines: o.effective ?? 25.5,
  };
};

/** Ítem Change tal como lo guarda productivity (accepted_files / accepted_at). */
export const changeItem = (o: Partial<ScoringChangeInput> = {}): ScoringChangeInput => ({
  PK: 'T#t1#S#s1',
  SK: 'C#c1',
  tenant_id: 't1',
  session_id: 's1',
  change_id: 'c1',
  accepted_files: [
    { path: 'src/app/total.ts', added: 30, deleted: 2 },
    { path: 'src/app/total.test.ts', added: 10, deleted: 0 },
  ],
  accepted_added_lines: 40,
  accepted_deleted_lines: 2,
  dimensions: dims(),
  branch: 'feature/MAG-1-total',
  task_key: 'MAG-1',
  accepted_at: '2026-10-20T23:15:00-03:00',
  ...o,
});

export const ctx = (o: Partial<ScoringContext> = {}): ScoringContext => ({
  tokens_total: 5100,
  regenerations: 1,
  latency_ms: 900,
  session_acceptance_rate: 0.5,
  task_type: 'Bug',
  ...o,
});
