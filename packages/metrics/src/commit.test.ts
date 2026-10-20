import { describe, expect, it } from 'vitest';
import { CommitAutomation, FileChange } from '@magicode/contracts';
import { analyzeChange, computeSurvival, matchCommit, parseUnifiedDiff, type AcceptedChangeRef } from './index.js';

const SALT = 'salt-commit';
const NONE = new Set<string>();

function accept(change_id: string, path: string, addedLines: string[]): AcceptedChangeRef {
  const r = analyzeChange({
    salt: SALT,
    files: [{ path, addedLines, deletedLines: [] }],
    existingRepoHashes: NONE,
    sessionAcceptedHashes: NONE,
  });
  return { change_id, lineHashes: r.lineHashes, effectiveWeights: r.effectiveWeights };
}

function match(commitFiles: Parameters<typeof matchCommit>[0]['commitFiles'], acceptedChanges: AcceptedChangeRef[]) {
  const res = matchCommit({ salt: SALT, commitFiles, acceptedChanges });
  CommitAutomation.parse(res.automation);
  for (const f of res.files) FileChange.parse(f);
  return res;
}

describe('matchCommit', () => {
  const c1 = accept('c1', 'src/a.ts', ['export function f(x: number) {', '  const y = x * 2;', '  return y;', '}']);
  const c2 = accept('c2', 'src/b.ts', ["import { f } from './a';", 'log(f(1));']);
  const unrelated = accept('c3', 'src/z.ts', ['zzz();']);

  it('commit 100% IA: todo casa, ai_share = 1', () => {
    const res = match(
      [{ path: 'src/a.ts', addedLines: ['export function f(x: number) {', '    const y = x * 2;', 'return y;', '}', ''], deletedLines: [] }],
      [c1, unrelated],
    );
    expect(res.automation).toEqual({
      commit_added_lines: 3, // `}` trivial y la vacía excluidas
      ai_matched_lines: 3,
      ai_share: 1,
      ai_lost_lines: 0,
      effective_lines: 2.8, // 0.8 + 1 + 1
    });
    expect(res.change_ids).toEqual(['c1']);
    expect(res.files).toEqual([{ path: 'src/a.ts', language: 'typescript', added: 4, deleted: 0 }]);
    expect(res.matchedHashes).toHaveLength(3);
  });

  it('líneas editadas por el humano: no casan y cuentan como perdidas', () => {
    const res = match(
      [
        {
          path: 'src/a.ts',
          addedLines: ['export function f(x: number) {', '  const y = x * 3; // humano', '  return y;', '}'],
          deletedLines: [],
        },
        { path: 'src/h.ts', addedLines: ['humanOnly();', 'moreHuman();'], deletedLines: ['old();'] },
      ],
      [c1, c2],
    );
    expect(res.automation.commit_added_lines).toBe(5);
    expect(res.automation.ai_matched_lines).toBe(2);
    expect(res.automation.ai_share).toBe(0.4);
    expect(res.automation.ai_lost_lines).toBe(1); // `const y = x * 2;` de c1; c2 no casó → no cuenta
    expect(res.automation.effective_lines).toBe(1.8);
    expect(res.change_ids).toEqual(['c1']);
    expect(res.files[1]).toEqual({ path: 'src/h.ts', language: 'typescript', added: 2, deleted: 1 });
  });

  it('multiconjunto: una línea aceptada una vez no casa con varias apariciones', () => {
    const once = accept('once', 'src/a.ts', ['return null;']);
    const res = match([{ path: 'src/a.ts', addedLines: ['return null;', 'return null;', 'return null;'], deletedLines: [] }], [once]);
    expect(res.automation.commit_added_lines).toBe(3);
    expect(res.automation.ai_matched_lines).toBe(1);
    expect(res.automation.ai_share).toBe(0.3333);
  });

  it('el mismo hash aceptado en dos cambios casa dos veces (uno por cambio)', () => {
    const a = accept('a', 'src/a.ts', ['return null;']);
    const b = accept('b', 'src/b.ts', ['return null;', 'other();']);
    const res = match([{ path: 'src/x.ts', addedLines: ['return null;', 'return null;'], deletedLines: [] }], [a, b]);
    expect(res.automation.ai_matched_lines).toBe(2);
    expect(res.change_ids).toEqual(['a', 'b']);
    expect(res.automation.ai_lost_lines).toBe(1); // other() de b
    expect(res.matchedHashes).toHaveLength(1);
  });

  it('imports casan pero aportan 0 líneas efectivas', () => {
    const res = match([{ path: 'src/b.ts', addedLines: ["import { f } from './a';", 'log(f(1));'], deletedLines: [] }], [c2]);
    expect(res.automation.ai_matched_lines).toBe(2);
    expect(res.automation.effective_lines).toBe(1);
  });

  it('commit sin líneas agregadas → ai_share 0 y válido', () => {
    const res = match([{ path: 'src/a.ts', addedLines: [], deletedLines: ['x();'] }], [c1]);
    expect(res.automation).toEqual({ commit_added_lines: 0, ai_matched_lines: 0, ai_share: 0, ai_lost_lines: 0, effective_lines: 0 });
    expect(res.change_ids).toEqual([]);
  });

  it('integra con parseUnifiedDiff de un `git show`', () => {
    const diff = [
      'commit 1234567',
      '',
      '    feat: f',
      '',
      'diff --git a/src/a.ts b/src/a.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/a.ts',
      '@@ -0,0 +1,5 @@',
      '+export function f(x: number) {',
      '+  const y = x * 2;',
      '+  return y;',
      '+}',
      '+export const extra = 1;',
    ].join('\n');
    const res = match(parseUnifiedDiff(diff), [c1]);
    expect(res.automation.commit_added_lines).toBe(4);
    expect(res.automation.ai_matched_lines).toBe(3);
    expect(res.automation.ai_share).toBe(0.75);
  });
});

describe('computeSurvival', () => {
  const c1 = accept('c1', 'src/a.ts', ['export function f(x: number) {', '  const y = x * 2;', '  return y;', '}']);
  const c2 = accept('c2', 'src/b.ts', ['log(f(1));', '// nota']);

  it('supervivencia parcial: cuenta hashes presentes en el SHA del tag', () => {
    const res = computeSurvival({
      salt: SALT,
      filesAtRef: [
        { path: 'src/a.ts', lines: ['export function f(x: number) {', '  const y = x * 3;', '    return y;', '}'] },
        { path: 'src/other.ts', lines: ['unrelated();'] },
      ],
      acceptedChanges: [c1, c2],
    });
    expect(res).toEqual({ surviving_lines: 2, surviving_effective_lines: 1.8, surviving_change_ids: ['c1'] });
  });

  it('la línea puede haberse movido a otro archivo', () => {
    const res = computeSurvival({ salt: SALT, filesAtRef: [{ path: 'src/moved.ts', lines: ['// nota'] }], acceptedChanges: [c2] });
    expect(res).toEqual({ surviving_lines: 1, surviving_effective_lines: 0.2, surviving_change_ids: ['c2'] });
  });

  it('multiconjunto: una ocurrencia en el tag respalda una sola línea aceptada', () => {
    const a = accept('a', 'src/a.ts', ['return null;']);
    const b = accept('b', 'src/b.ts', ['return null;']);
    const res = computeSurvival({ salt: SALT, filesAtRef: [{ path: 'src/a.ts', lines: ['return null;'] }], acceptedChanges: [a, b] });
    expect(res.surviving_lines).toBe(1);
    expect(res.surviving_change_ids).toEqual(['a']);
  });

  it('nada sobrevive → ceros', () => {
    expect(computeSurvival({ salt: SALT, filesAtRef: [], acceptedChanges: [c1] })).toEqual({
      surviving_lines: 0,
      surviving_effective_lines: 0,
      surviving_change_ids: [],
    });
  });

  it('otro salt no casa (hashes de sesión)', () => {
    const res = computeSurvival({ salt: 'otro', filesAtRef: [{ path: 'src/b.ts', lines: ['log(f(1));'] }], acceptedChanges: [c2] });
    expect(res.surviving_lines).toBe(0);
  });
});
