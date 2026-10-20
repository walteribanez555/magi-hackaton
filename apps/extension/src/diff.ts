/**
 * Diff de líneas (Myers O((N+M)·D)) sin dependencias. Puro: no importa 'vscode'.
 * Se usa para calcular las líneas agregadas/borradas de una propuesta frente al original.
 */

export type DiffOpType = 'equal' | 'add' | 'del';
export interface DiffOp {
  type: DiffOpType;
  line: string;
}

/** Por encima de esta distancia se cae a un diff "bloque" (todo borrado / todo agregado). */
const MAX_EDIT_DISTANCE = 6000;

/** Separa en líneas aceptando \n y \r\n; un salto final no genera una línea vacía extra. */
export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Diff de dos listas de líneas. Devuelve la secuencia de operaciones en orden. */
export function diffLines(a: readonly string[], b: readonly string[]): DiffOp[] {
  // Prefijo y sufijo comunes: abaratan el caso típico (cambio local en un archivo grande).
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ type: 'equal', line: a[i]! });
  ops.push(...myers(a.slice(start, endA), b.slice(start, endB)));
  for (let i = endA; i < a.length; i++) ops.push({ type: 'equal', line: a[i]! });
  return ops;
}

function myers(a: readonly string[], b: readonly string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((line) => ({ type: 'add' as const, line }));
  if (m === 0) return a.map((line) => ({ type: 'del' as const, line }));

  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = n + m + 1;
  const v = new Int32Array(2 * offset + 1);
  // trace[d] = copia de v[k] para k ∈ [-(d+1), d+1] ANTES del paso d (memoria O(D²)).
  const trace: Int32Array[] = [];
  v[offset + 1] = 0;

  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!;
      else x = v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b);
    }
  }
  // Distancia excesiva: bloque completo (conservador, sigue siendo correcto en conteos máximos).
  return [...a.map((line) => ({ type: 'del' as const, line })), ...b.map((line) => ({ type: 'add' as const, line }))];
}

function backtrack(trace: Int32Array[], a: readonly string[], b: readonly string[]): DiffOp[] {
  const ops: DiffOp[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const t = trace[d]!;
    const get = (k: number) => t[k + d + 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1;
    const prevX = get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: 'equal', line: a[x - 1]! });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ type: 'add', line: b[y - 1]! });
      else ops.push({ type: 'del', line: a[x - 1]! });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

export interface LineChanges {
  addedLines: string[];
  deletedLines: string[];
  ops: DiffOp[];
}

/** Líneas agregadas y borradas de `oldText` → `newText`. */
export function lineChanges(oldText: string, newText: string): LineChanges {
  const ops = diffLines(splitLines(oldText), splitLines(newText));
  const addedLines: string[] = [];
  const deletedLines: string[] = [];
  for (const op of ops) {
    if (op.type === 'add') addedLines.push(op.line);
    else if (op.type === 'del') deletedLines.push(op.line);
  }
  return { addedLines, deletedLines, ops };
}

/** Cuenta líneas no vacías (la convención de FileChange.added/deleted). */
export function countNonEmpty(lines: readonly string[]): number {
  let c = 0;
  for (const l of lines) if (l.trim().length > 0) c++;
  return c;
}
