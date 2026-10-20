import { describe, expect, it } from 'vitest';
import { ChangeDimensions, CodeAccepted, FileChange, LineKind } from '@magicode/contracts';
import { analyzeChange, buildRepoHashIndex, DEFAULT_WEIGHTS, hashLine, normalizeLine } from './index.js';

const SALT = 'sesion-salt';
const EMPTY = new Set<string>();
const h = (line: string) => hashLine(SALT, normalizeLine(line));

function analyze(files: Parameters<typeof analyzeChange>[0]['files'], opts: Partial<Parameters<typeof analyzeChange>[0]> = {}) {
  const res = analyzeChange({ salt: SALT, files, existingRepoHashes: EMPTY, sessionAcceptedHashes: EMPTY, ...opts });
  // siempre debe cumplir el contrato
  ChangeDimensions.parse(res.dimensions);
  for (const f of res.files) FileChange.parse(f);
  return res;
}

describe('DEFAULT_WEIGHTS', () => {
  it('replica los pesos del contrato', () => {
    expect(DEFAULT_WEIGHTS.kinds.logic).toBe(1);
    expect(DEFAULT_WEIGHTS.kinds.trivial).toBe(0);
    expect(DEFAULT_WEIGHTS.tiers.test).toBe(0.9);
    expect(DEFAULT_WEIGHTS.tiers.generated).toBe(0);
  });
});

describe('analyzeChange — importancia', () => {
  it('cuenta líneas no vacías, pondera kind×tier y llena by_kind completo', () => {
    const res = analyze([
      {
        path: 'src/sum.ts',
        addedLines: [
          "import { x } from './x';", // import 0.1
          '', // vacía: no cuenta
          'export function sum(xs: number[]) {', // declaration 0.8
          '  let total = 0;', // logic 1
          '  // suma positivos', // comment 0.2
          '  return total;', // logic 1
          '}', // trivial 0
        ],
        deletedLines: ['old', '   '],
      },
    ]);
    const imp = res.dimensions.importance;
    expect(imp.lines).toBe(6);
    expect(imp.weighted_lines).toBe(3.1);
    expect(imp.score).toBe(0.5167);
    expect(Object.keys(imp.by_kind).sort()).toEqual([...LineKind.options].sort());
    expect(imp.by_kind).toMatchObject({ import: 1, declaration: 1, logic: 2, comment: 1, trivial: 1, test: 0, config: 0 });
    expect(res.acceptedAddedLines).toBe(6);
    expect(res.acceptedDeletedLines).toBe(1);
    expect(res.files).toEqual([{ path: 'src/sum.ts', language: 'typescript', added: 6, deleted: 1 }]);
  });

  it('aplica el tier del archivo (test 0.9, docs 0.3)', () => {
    const res = analyze([
      { path: 'src/a.test.ts', addedLines: ['expect(sum(1, 2)).toBe(3);'], deletedLines: [] }, // 0.7×0.9
      { path: 'docs/guide.md', addedLines: ['Explica la suma.'], deletedLines: [] }, // 0.2×0.3
    ]);
    expect(res.dimensions.importance.weighted_lines).toBe(0.69);
    expect(res.dimensions.effective_lines).toBe(0.69);
    expect(res.effectiveWeights[h('expect(sum(1, 2)).toBe(3);')]).toBe(0.63);
  });

  it('acepta pesos parciales del proyecto y los acota a [0,1]', () => {
    const res = analyze([{ path: 'src/a.ts', addedLines: ['// doc', 'x = 1;'], deletedLines: [] }], {
      weights: { kinds: { ...DEFAULT_WEIGHTS.kinds, comment: 5, logic: 0.5 } },
    });
    expect(res.dimensions.importance.weighted_lines).toBe(1.5); // comment → 1 (acotado), logic 0.5
    expect(res.dimensions.importance.score).toBe(0.75);
  });

  it('cambio vacío: todo en 0 y válido', () => {
    const res = analyze([{ path: 'src/a.ts', addedLines: ['', '  '], deletedLines: [] }]);
    expect(res.dimensions.importance).toMatchObject({ lines: 0, weighted_lines: 0, score: 0 });
    expect(res.dimensions.redundancy.score).toBe(0);
    expect(res.dimensions.automation.mechanical_share).toBe(0);
    expect(res.lineHashes).toEqual([]);
  });
});

describe('analyzeChange — redundancia', () => {
  it('intra_change: desde la 2ª aparición, también entre archivos; triviales nunca', () => {
    const res = analyze([
      { path: 'src/a.ts', addedLines: ['x += 1;', 'x += 1;', '}', '}', '}'], deletedLines: [] },
      { path: 'src/b.ts', addedLines: ['   x  +=  1;'], deletedLines: [] }, // misma línea normalizada
    ]);
    const r = res.dimensions.redundancy;
    expect(r.intra_change).toBe(2);
    expect(r.redundant_lines).toBe(2);
    expect(r.score).toBe(0.6667); // 2 de 3 no triviales
    expect(res.lineHashes).toEqual([h('x += 1;')]); // únicos
    expect(res.effectiveWeights[h('x += 1;')]).toBe(1); // la 1ª aparición sí vale
    expect(res.dimensions.effective_lines).toBe(1);
  });

  it('existing_in_repo y repeated_in_session; prioridad intra → session → repo sin doble conteo', () => {
    const repo = buildRepoHashIndex(SALT, [{ path: 'src/old.ts', content: 'const a = 1;\nconst both = 3;\n}\n' }]);
    const session = new Set([h('const s = 2;'), h('const both = 3;')]);
    const res = analyze(
      [
        {
          path: 'src/new.ts',
          addedLines: ['const a = 1;', 'const s = 2;', 'const both = 3;', 'const both = 3;', 'const fresh = 4;'],
          deletedLines: [],
        },
      ],
      { existingRepoHashes: repo, sessionAcceptedHashes: session },
    );
    const r = res.dimensions.redundancy;
    expect(r.existing_in_repo).toBe(1); // a
    expect(r.repeated_in_session).toBe(2); // s, both (session gana a repo)
    expect(r.intra_change).toBe(1); // 2º both
    expect(r.redundant_lines).toBe(4);
    expect(r.score).toBe(0.8);
    expect(res.dimensions.effective_lines).toBe(1); // solo fresh
    expect(res.effectiveWeights).toEqual({
      [h('const a = 1;')]: 0,
      [h('const s = 2;')]: 0,
      [h('const both = 3;')]: 0,
      [h('const fresh = 4;')]: 1,
    });
  });

  it('buildRepoHashIndex excluye triviales y vacías', () => {
    const idx = buildRepoHashIndex(SALT, [{ path: 'src/a.ts', content: '}\n\n  return x;\r\n);' }]);
    expect([...idx]).toEqual([h('return x;')]);
  });

  it('una línea trivial que existe en repo/sesión no es redundante', () => {
    const res = analyze([{ path: 'src/a.ts', addedLines: ['}', '});'], deletedLines: [] }], {
      existingRepoHashes: new Set([h('}')]),
      sessionAcceptedHashes: new Set([h('});')]),
    });
    expect(res.dimensions.redundancy.redundant_lines).toBe(0);
    expect(res.dimensions.redundancy.score).toBe(0);
  });
});

describe('analyzeChange — automatización', () => {
  it('mechanical_lines = import + trivial + tier generated; no suman líneas efectivas', () => {
    const res = analyze([
      { path: 'src/a.ts', addedLines: ["import a from 'a';", 'run(a);', '}'], deletedLines: [] },
      { path: 'dist/a.js', addedLines: ['run(a);', 'more();'], deletedLines: [] },
    ]);
    const a = res.dimensions.automation;
    expect(a.mechanical_lines).toBe(4); // import, }, 2 de dist
    expect(a.mechanical_share).toBe(0.8);
    // run(a) en dist es redundante intra; more() es generada → 0
    expect(res.dimensions.effective_lines).toBe(1);
    expect(res.effectiveWeights[h('more();')]).toBe(0);
    expect(res.effectiveWeights[h("import a from 'a';")]).toBe(0);
  });

  it('accepted_as_is vs edited_before_accept según la propuesta original', () => {
    const res = analyze([
      {
        path: 'src/a.ts',
        addedLines: ['const a = 1;', 'const b = 20;', '  const   c = 3;'],
        proposedAddedLines: ['const a = 1;', 'const b = 2;', 'const c = 3;'],
        deletedLines: [],
      },
      { path: 'src/b.ts', addedLines: ['x();', 'y();'], deletedLines: [] }, // sin propuesta → tal cual
    ]);
    expect(res.dimensions.automation.accepted_as_is).toBe(4);
    expect(res.dimensions.automation.edited_before_accept).toBe(1);
  });
});

describe('analyzeChange — hashes y contrato', () => {
  it('no expone código: solo hashes de 16 hex', () => {
    const res = analyze([{ path: 'src/secret.ts', addedLines: ['const apiKey = "sk-123";'], deletedLines: [] }]);
    const json = JSON.stringify(res);
    expect(json).not.toContain('sk-123');
    expect(json).not.toContain('apiKey');
    expect(res.patchHash).toMatch(/^[0-9a-f]{16}$/);
    for (const x of res.lineHashes) expect(x).toMatch(/^[0-9a-f]{16}$/);
  });

  it('patchHash determinista, independiente del orden de archivos, sensible a borrados', () => {
    const fa = { path: 'src/a.ts', addedLines: ['a();'], deletedLines: [] };
    const fb = { path: 'src/b.ts', addedLines: ['b();'], deletedLines: ['old();'] };
    const p1 = analyze([fa, fb]).patchHash;
    expect(analyze([fb, fa]).patchHash).toBe(p1);
    expect(analyze([fa, { ...fb, deletedLines: [] }]).patchHash).not.toBe(p1);
  });

  it('Σ effectiveWeights = effective_lines', () => {
    const res = analyze([
      { path: 'src/a.ts', addedLines: ['export function f() {', 'return g(1);', 'return g(1);', '// ok', '}'], deletedLines: [] },
      { path: 'tests/a.test.ts', addedLines: ['expect(f()).toBe(1);'], deletedLines: [] },
    ]);
    const sum = Object.values(res.effectiveWeights).reduce((s, x) => s + x, 0);
    expect(Math.round(sum * 1e4) / 1e4).toBe(res.dimensions.effective_lines);
  });

  it('el resultado arma un payload code.accepted válido', () => {
    const res = analyze([{ path: 'src/a.ts', addedLines: ['a();'], deletedLines: [] }]);
    const event = {
      event_id: '0b8f2a8e-3c55-4f39-9b2e-5d6a5d3c9f10',
      schema_version: 1,
      occurred_at: '2026-10-20T10:00:00Z',
      session_id: 's',
      project_id: 'p',
      repository: 'org/repo',
      source: 'ide-extension',
      event_type: 'code.accepted',
      payload: {
        change_id: 'c1',
        ai_request_id: 'r1',
        files: res.files,
        patch_hash: res.patchHash,
        accepted_added_lines: res.acceptedAddedLines,
        accepted_deleted_lines: res.acceptedDeletedLines,
        dimensions: res.dimensions,
      },
    };
    expect(() => CodeAccepted.parse(event)).not.toThrow();
  });
});
