import { describe, expect, it } from 'vitest';
import { countNonEmpty, diffLines, lineChanges, splitLines, type DiffOp } from '../src/diff';

/** Reconstruye ambos lados a partir de las operaciones (propiedad básica de cualquier diff). */
function sides(ops: DiffOp[]) {
  return {
    a: ops.filter((o) => o.type !== 'add').map((o) => o.line),
    b: ops.filter((o) => o.type !== 'del').map((o) => o.line),
  };
}

/** LCS por programación dinámica (referencia para verificar que Myers es mínimo). */
function lcsLength(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
  return dp[a.length]![b.length]!;
}

describe('splitLines', () => {
  it('handles LF, CRLF, trailing newline and empty text', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\r\nb')).toEqual(['a', 'b']);
    expect(splitLines('a\n\n')).toEqual(['a', '']);
  });
});

describe('diffLines', () => {
  it('returns only equal ops for identical input', () => {
    const ops = diffLines(['a', 'b'], ['a', 'b']);
    expect(ops.every((o) => o.type === 'equal')).toBe(true);
  });

  it('detects pure insertions and deletions', () => {
    expect(diffLines([], ['x', 'y']).map((o) => o.type)).toEqual(['add', 'add']);
    expect(diffLines(['x', 'y'], []).map((o) => o.type)).toEqual(['del', 'del']);
  });

  it('finds a minimal diff for an insertion in the middle', () => {
    const a = ['function f() {', '  return 1;', '}'];
    const b = ['function f() {', '  const x = 1;', '  return x;', '}'];
    const { addedLines, deletedLines } = lineChanges(a.join('\n'), b.join('\n'));
    expect(addedLines).toEqual(['  const x = 1;', '  return x;']);
    expect(deletedLines).toEqual(['  return 1;']);
  });

  it('is consistent and minimal on random inputs', () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let t = 0; t < 200; t++) {
      const a = Array.from({ length: Math.floor(rnd() * 20) }, () => 'abcde'[Math.floor(rnd() * 5)]!);
      const b = Array.from({ length: Math.floor(rnd() * 20) }, () => 'abcde'[Math.floor(rnd() * 5)]!);
      const ops = diffLines(a, b);
      expect(sides(ops)).toEqual({ a, b });
      const equal = ops.filter((o) => o.type === 'equal').length;
      expect(equal).toBe(lcsLength(a, b));
    }
  });

  it('handles larger files with a local change quickly', () => {
    const a = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
    const b = [...a];
    b.splice(2500, 1, 'changed', 'added');
    const started = Date.now();
    const { addedLines, deletedLines } = lineChanges(a.join('\n'), b.join('\n'));
    expect(Date.now() - started).toBeLessThan(500);
    expect(addedLines).toEqual(['changed', 'added']);
    expect(deletedLines).toEqual(['line 2500']);
  });

  it('countNonEmpty ignores blank lines', () => {
    expect(countNonEmpty(['a', '', '  ', 'b'])).toBe(2);
  });
});
