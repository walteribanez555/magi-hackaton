import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from './index.js';

/** Salida real de `git show` (rename con espacios, binario, borrado, multi-hunk, nuevo, sin \n final). */
const GIT_SHOW = [
  'commit d9d7632328a60b6eadaa0c7fde7ce27a5f0152a2',
  'Author: t <t@t>',
  'Date:   Tue Oct 20 16:18:17 2026 -0400',
  '',
  '    feat: cambios varios',
  '',
  'diff --git a/docs/old name.md b/docs/new name.md',
  'similarity index 65%',
  'rename from docs/old name.md',
  'rename to docs/new name.md',
  'index 53f1df8..5491c25 100644',
  '--- a/docs/old name.md\t',
  '+++ b/docs/new name.md\t',
  '@@ -1,4 +1,4 @@',
  ' line one',
  ' line two',
  ' line three',
  '-line four',
  '+line 4 changed',
  'diff --git a/logo.png b/logo.png',
  'new file mode 100644',
  'index 0000000..ac6c544',
  'Binary files /dev/null and b/logo.png differ',
  'diff --git a/src/gone.ts b/src/gone.ts',
  'deleted file mode 100644',
  'index a85183a..0000000',
  '--- a/src/gone.ts',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-gone 1',
  '-gone 2',
  'diff --git a/src/math.ts b/src/math.ts',
  'index dbbfc9b..12fdc8a 100644',
  '--- a/src/math.ts',
  '+++ b/src/math.ts',
  '@@ -1,3 +1,4 @@',
  '+import { z } from "./z";',
  ' export function a() {',
  '   return 1;',
  ' }',
  '@@ -8,5 +9,5 @@ export function b() {',
  ' // x',
  ' // y',
  ' // z',
  '-export const c = 3;',
  '+export const c = 30;',
  ' export const d = 4;',
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  'index 0000000..4e3d4a3',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1,3 @@',
  '+export const added = true;',
  '+--- not a header',
  '++++ also not',
  'diff --git a/src/nonl.ts b/src/nonl.ts',
  'index c693f13..0e4d068 100644',
  '--- a/src/nonl.ts',
  '+++ b/src/nonl.ts',
  '@@ -1 +1 @@',
  '-keep',
  '\\ No newline at end of file',
  '+keep2',
  '\\ No newline at end of file',
  '',
].join('\n');

/** `git show -U0` (hunks sin contexto, contadores omitidos = 1). */
const GIT_U0 = [
  'diff --git a/src/math.ts b/src/math.ts',
  'index dbbfc9b..12fdc8a 100644',
  '--- a/src/math.ts',
  '+++ b/src/math.ts',
  '@@ -0,0 +1 @@',
  '+import { z } from "./z";',
  '@@ -11 +12 @@ export function b() {',
  '-export const c = 3;',
  '+export const c = 30;',
  '',
].join('\n');

describe('parseUnifiedDiff', () => {
  it('parsea un `git show` real: rename, binario, borrado, multi-hunk, nuevo', () => {
    const files = parseUnifiedDiff(GIT_SHOW);
    expect(files.map((f) => f.path)).toEqual(['docs/new name.md', 'src/gone.ts', 'src/math.ts', 'src/new.ts', 'src/nonl.ts']);

    const [renamed, gone, math, created, nonl] = files;
    expect(renamed).toEqual({ path: 'docs/new name.md', addedLines: ['line 4 changed'], deletedLines: ['line four'] });
    expect(gone).toEqual({ path: 'src/gone.ts', addedLines: [], deletedLines: ['gone 1', 'gone 2'] });
    expect(math!.addedLines).toEqual(['import { z } from "./z";', 'export const c = 30;']);
    expect(math!.deletedLines).toEqual(['export const c = 3;']);
    // líneas de contenido que parecen cabeceras no rompen el parseo
    expect(created!.addedLines).toEqual(['export const added = true;', '--- not a header', '+++ also not']);
    expect(nonl).toEqual({ path: 'src/nonl.ts', addedLines: ['keep2'], deletedLines: ['keep'] });
  });

  it('omite binarios', () => {
    expect(parseUnifiedDiff(GIT_SHOW).some((f) => f.path === 'logo.png')).toBe(false);
  });

  it('parsea `-U0` con contadores implícitos', () => {
    expect(parseUnifiedDiff(GIT_U0)).toEqual([
      { path: 'src/math.ts', addedLines: ['import { z } from "./z";', 'export const c = 30;'], deletedLines: ['export const c = 3;'] },
    ]);
  });

  it('decodifica rutas entre comillas (unicode)', () => {
    const diff = [
      'diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"',
      'new file mode 100644',
      'index 0000000..5c1b149',
      '--- /dev/null',
      '+++ "b/src/caf\\303\\251.ts"',
      '@@ -0,0 +1 @@',
      '+hola',
    ].join('\n');
    expect(parseUnifiedDiff(diff)).toEqual([{ path: 'src/café.ts', addedLines: ['hola'], deletedLines: [] }]);
  });

  it('rename con cambios usa la ruta destino aunque difiera de a/', () => {
    const diff = [
      'diff --git a/src/old.ts b/src/new.ts',
      'similarity index 90%',
      'rename from src/old.ts',
      'rename to src/new.ts',
      '--- a/src/old.ts',
      '+++ b/src/new.ts',
      '@@ -1,2 +1,2 @@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
    ].join('\n');
    expect(parseUnifiedDiff(diff)).toEqual([{ path: 'src/new.ts', addedLines: ['const b = 3;'], deletedLines: ['const b = 2;'] }]);
  });

  it('omite renames puros, cambios de modo y diffs combinados de merge', () => {
    const diff = [
      'diff --git a/a.ts b/b.ts',
      'similarity index 100%',
      'rename from a.ts',
      'rename to b.ts',
      'diff --git a/run.sh b/run.sh',
      'old mode 100644',
      'new mode 100755',
      'diff --cc src/x.ts',
      'index 1111111,2222222..3333333',
      '--- a/src/x.ts',
      '+++ b/src/x.ts',
      '@@@ -1,1 -1,1 +1,1 @@@',
      '- a',
      ' -b',
      '++c',
    ].join('\n');
    expect(parseUnifiedDiff(diff)).toEqual([]);
  });

  it('acepta CRLF, líneas de contexto vacías recortadas y diff plano sin `diff --git`', () => {
    const diff = [
      '--- a/src/a.ts\t2026-01-01 00:00:00',
      '+++ b/src/a.ts\t2026-01-01 00:00:01',
      '@@ -1,3 +1,3 @@',
      ' const a = 1;',
      '', // contexto vacío sin el espacio inicial
      '-const b = 2;',
      '+const b = 3;',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1 +1,2 @@',
      ' x',
      '+y',
    ].join('\r\n');
    expect(parseUnifiedDiff(diff)).toEqual([
      { path: 'src/a.ts', addedLines: ['const b = 3;'], deletedLines: ['const b = 2;'] },
      { path: 'src/b.ts', addedLines: ['y'], deletedLines: [] },
    ]);
  });

  it('`git log -p` con varios commits ignora mensajes intermedios', () => {
    const diff = [
      'commit aaaaaaa',
      '',
      '    primero',
      '',
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -0,0 +1 @@',
      '+one',
      '',
      'commit bbbbbbb',
      '',
      '    segundo con +signo y -guion',
      '',
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-one',
      '+two',
    ].join('\n');
    const files = parseUnifiedDiff(diff);
    expect(files).toEqual([
      { path: 'a.ts', addedLines: ['one'], deletedLines: [] },
      { path: 'a.ts', addedLines: ['two'], deletedLines: ['one'] },
    ]);
  });

  it('diff vacío → []', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });
});
