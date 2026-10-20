/** Archivo de un diff unificado ya separado en líneas agregadas y borradas (sin prefijo). */
export interface DiffFile {
  path: string;
  addedLines: string[];
  deletedLines: string[];
}

interface Pending extends DiffFile {
  oldPath?: string;
  binary: boolean;
  combined: boolean;
  sawHunk: boolean;
}

/** Decodifica una ruta entre comillas estilo git (`"b/caf\303\251.txt"`). */
function unquote(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) return raw;
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  const esc: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '\\' && i + 1 < body.length) {
      const oct = /^[0-7]{3}/.exec(body.slice(i + 1));
      if (oct) {
        bytes.push(parseInt(oct[0], 8));
        i += 3;
        continue;
      }
      const next = body[i + 1]!;
      bytes.push(esc[next] ?? next.charCodeAt(0));
      i += 1;
      continue;
    }
    bytes.push(...Buffer.from(ch, 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Ruta de una cabecera `--- a/x` / `+++ b/x` (sin prefijo a/ b/, sin timestamp). null = /dev/null. */
function headerPath(rest: string): string | null {
  let p = rest.startsWith('"') ? rest : rest.split('\t')[0]!;
  p = unquote(p.trim());
  if (p === '/dev/null') return null;
  return stripPrefix(p);
}

function stripPrefix(p: string): string {
  return /^[abciwo12]\//.test(p) ? p.slice(2) : p;
}

/** Ruta destino de `diff --git a/x b/y` (maneja comillas y espacios cuando a = b). */
function gitHeaderPath(rest: string): string {
  if (rest.startsWith('"') || rest.includes(' "')) {
    const tokens = rest.match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? [];
    const last = tokens[tokens.length - 1] ?? '';
    return stripPrefix(unquote(last));
  }
  // `a/P b/P` con P idéntico (caso común, admite espacios en P)
  if ((rest.length - 1) % 2 === 0) {
    const half = (rest.length - 1) / 2;
    const a = rest.slice(0, half);
    const b = rest.slice(half + 1);
    if (a.slice(2) === b.slice(2)) return stripPrefix(b);
  }
  const idx = rest.lastIndexOf(' b/');
  return idx >= 0 ? rest.slice(idx + 3) : stripPrefix(rest.split(' ').pop() ?? rest);
}

/**
 * Parsea la salida de `git diff` / `git diff -U0` / `git show` / `git log -p` (o un diff
 * unificado plano) a líneas agregadas/borradas por archivo.
 * - La ruta es la de destino (`b/`); para archivos borrados, la de origen.
 * - Usa los contadores del encabezado `@@` para saber dónde termina cada hunk, así líneas de
 *   contenido como `--- x` o `+++ y` no se confunden con cabeceras.
 * - Se omiten: archivos binarios, diffs combinados de merges (`diff --cc`), y archivos sin
 *   líneas agregadas ni borradas (cambio de modo, rename puro).
 * - Se ignoran `\ No newline at end of file`, el encabezado del commit y el mensaje.
 */
export function parseUnifiedDiff(diff: string): DiffFile[] {
  const out: DiffFile[] = [];
  const lines = diff.split(/\r?\n/);
  let cur: Pending | null = null;
  let oldLeft = 0;
  let newLeft = 0;

  const flush = () => {
    if (cur && !cur.binary && !cur.combined && (cur.addedLines.length > 0 || cur.deletedLines.length > 0)) {
      out.push({ path: cur.path || cur.oldPath || '', addedLines: cur.addedLines, deletedLines: cur.deletedLines });
    }
    cur = null;
  };
  const start = (path: string): Pending => {
    flush();
    const p: Pending = { path, addedLines: [], deletedLines: [], binary: false, combined: false, sawHunk: false };
    cur = p;
    return p;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // dentro de un hunk: los contadores mandan
    if (cur && (oldLeft > 0 || newLeft > 0)) {
      const c: Pending = cur;
      const tag = line[0];
      if (tag === '+') {
        c.addedLines.push(line.slice(1));
        newLeft--;
      } else if (tag === '-') {
        c.deletedLines.push(line.slice(1));
        oldLeft--;
      } else if (tag === '\\') {
        // "\ No newline at end of file"
      } else {
        // contexto (algunas herramientas recortan el espacio de las líneas vacías)
        oldLeft--;
        newLeft--;
      }
      continue;
    }

    if (line.startsWith('diff --git ')) {
      start(gitHeaderPath(line.slice('diff --git '.length)));
      continue;
    }
    if (line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) {
      start(line.replace(/^diff --(cc|combined) /, '')).combined = true;
      continue;
    }
    if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      const c: Pending = !cur || (cur as Pending).sawHunk ? start('') : cur;
      const oldP = headerPath(line.slice(4));
      const newP = headerPath(lines[i + 1]!.slice(4));
      if (oldP) c.oldPath = oldP;
      c.path = newP ?? oldP ?? c.path;
      i++;
      continue;
    }
    if (!cur) continue;
    const c: Pending = cur;
    if (line.startsWith('rename to ') || line.startsWith('copy to ')) {
      c.path = unquote(line.replace(/^(rename|copy) to /, ''));
    } else if (line.startsWith('rename from ') || line.startsWith('copy from ')) {
      c.oldPath = unquote(line.replace(/^(rename|copy) from /, ''));
    } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      c.binary = true;
    } else if (line.startsWith('@@ ')) {
      const m = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
      if (m) {
        oldLeft = m[1] === undefined ? 1 : Number(m[1]);
        newLeft = m[2] === undefined ? 1 : Number(m[2]);
        c.sawHunk = true;
      }
    }
  }
  flush();
  return out;
}
