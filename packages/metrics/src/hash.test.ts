import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { clamp01, hashLine, normalizeLine, outputHash, patchHash, round4 } from './index.js';

describe('normalizeLine', () => {
  it('recorta y colapsa espacios internos (tabs incluidos)', () => {
    expect(normalizeLine('   const  x =\t\t1;  ')).toBe('const x = 1;');
    expect(normalizeLine('\t\t')).toBe('');
    expect(normalizeLine('a\r')).toBe('a');
  });
});

describe('hashLine', () => {
  it('es HMAC-SHA256(salt, línea) truncado a 16 hex', () => {
    const expected = createHmac('sha256', 's1').update('return x;').digest('hex').slice(0, 16);
    expect(hashLine('s1', 'return x;')).toBe(expected);
    expect(hashLine('s1', 'return x;')).toMatch(/^[0-9a-f]{16}$/);
  });
  it('depende del salt', () => {
    expect(hashLine('s1', 'x')).not.toBe(hashLine('s2', 'x'));
  });
});

describe('outputHash', () => {
  it('ignora indentación, espacios y líneas vacías', () => {
    const a = 'function f() {\n  return 1;\n}\n';
    const b = '\n\nfunction  f() {\r\n\t\treturn 1;\r\n\n}';
    expect(outputHash(a)).toBe(outputHash(b));
    expect(outputHash(a)).toMatch(/^[0-9a-f]{16}$/);
  });
  it('distingue contenido distinto', () => {
    expect(outputHash('return 1;')).not.toBe(outputHash('return 2;'));
  });
});

describe('patchHash', () => {
  it('es determinista e independiente del orden de archivos', () => {
    const a = { path: 'src/a.ts', lineHashes: ['aa', 'bb'] };
    const b = { path: 'src/b.ts', lineHashes: ['cc'] };
    expect(patchHash([a, b])).toBe(patchHash([b, a]));
    expect(patchHash([a, b])).toMatch(/^[0-9a-f]{16}$/);
  });
  it('cambia con la ruta o el orden de líneas', () => {
    const base = patchHash([{ path: 'a', lineHashes: ['1', '2'] }]);
    expect(patchHash([{ path: 'b', lineHashes: ['1', '2'] }])).not.toBe(base);
    expect(patchHash([{ path: 'a', lineHashes: ['2', '1'] }])).not.toBe(base);
  });
});

describe('redondeo', () => {
  it('round4 y clamp01', () => {
    expect(round4(0.1 + 0.2)).toBe(0.3);
    expect(round4(0.123456)).toBe(0.1235);
    expect(clamp01(1.5)).toBe(1);
    expect(clamp01(-0.2)).toBe(0);
    expect(clamp01(Number.NaN)).toBe(0);
  });
});
