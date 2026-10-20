import { describe, expect, it } from 'vitest';
import type { FileTier, LineKind } from '@magicode/contracts';
import { classifyLine, detectLanguage, fileTier, isMechanical, languageFamily } from './index.js';

type Row = [path: string, line: string, kind: LineKind];

const table: Record<string, Row[]> = {
  'TS/JS': [
    ['src/a.ts', "import { x } from './x';", 'import'],
    ['src/a.ts', "import type { T } from './t';", 'import'],
    ['src/a.ts', "} from './y';", 'import'],
    ['src/a.ts', "export * from './z.js';", 'import'],
    ['src/a.ts', "export { a, b } from './ab.js';", 'import'],
    ['src/a.js', "const fs = require('fs');", 'import'],
    ['src/a.ts', 'export function sum(a: number) {', 'declaration'],
    ['src/a.ts', 'export default async function handler(req, res) {', 'declaration'],
    ['src/a.ts', 'export abstract class Repo<T> {', 'declaration'],
    ['src/a.ts', 'export interface Foo {', 'declaration'],
    ['src/a.ts', 'type A = string | number;', 'declaration'],
    ['src/a.ts', 'export enum Color {', 'declaration'],
    ['src/a.ts', 'const add = (a: number, b: number): number => {', 'declaration'],
    ['src/a.ts', 'async handle(req: Request): Promise<void> {', 'declaration'],
    ['src/a.ts', 'constructor(private readonly db: Db) {', 'declaration'],
    ['src/a.ts', 'readonly name?: string;', 'declaration'],
    ['src/a.ts', '@Injectable()', 'declaration'],
    ['src/a.ts', 'if (x > 0) total += x;', 'logic'],
    ['src/a.ts', 'return x;', 'logic'],
    ['src/a.ts', 'foo(a)', 'logic'],
    ['src/a.ts', 'const total = items.reduce((s, i) => s + i, 0);', 'logic'],
    ['src/a.ts', "app.get('/', (req, res) => {", 'logic'],
    ['src/a.ts', 'for (const x of xs) {', 'logic'],
    ['src/a.ts', "const mod = await import('./lazy.js');", 'logic'],
    ['src/a.ts', 'default: return 1;', 'logic'],
    ['src/a.ts', '// suma los positivos', 'comment'],
    ['src/a.ts', '/* bloque */', 'comment'],
    ['src/a.ts', ' * @param a primer sumando', 'comment'],
    ['src/a.ts', 'expect(sum(1, 2)).toBe(3);', 'test'],
    ['src/a.ts', "describe('sum', () => {", 'test'],
    ['src/a.ts', "it.each([1, 2])('x %i', (n) => {", 'test'],
    ['src/a.test.ts', 'const r = sum(1, 2);', 'test'],
    ['src/a.test.ts', "import { sum } from './a';", 'import'],
    ['src/a.ts', '}', 'trivial'],
    ['src/a.ts', '});', 'trivial'],
    ['src/a.ts', '} else {', 'trivial'],
    ['src/a.ts', '],', 'trivial'],
    ['src/a.ts', 'try {', 'trivial'],
    ['src/a.ts', '} finally {', 'trivial'],
    ['src/a.ts', 'break;', 'trivial'],
    ['src/a.ts', '/**', 'trivial'],
    ['src/a.ts', '*/', 'trivial'],
    ['src/a.tsx', '</div>', 'trivial'],
    ['src/a.tsx', '/>', 'trivial'],
    ['src/a.ts', '', 'trivial'],
  ],
  Python: [
    ['app/m.py', 'import os', 'import'],
    ['app/m.py', 'from .models import User', 'import'],
    ['app/m.py', 'def total(xs: list[int]) -> int:', 'declaration'],
    ['app/m.py', 'async def fetch(url):', 'declaration'],
    ['app/m.py', 'class User(Base):', 'declaration'],
    ['app/m.py', '@dataclass', 'declaration'],
    ['app/m.py', 'return sum(x for x in xs if x > 0)', 'logic'],
    ['app/m.py', 'if not user:', 'logic'],
    ['app/m.py', '# comentario', 'comment'],
    ['app/m.py', '"""Docstring de una línea."""', 'comment'],
    ['app/m.py', "'''", 'trivial'],
    ['app/m.py', 'else:', 'trivial'],
    ['app/m.py', 'pass', 'trivial'],
    ['app/m.py', 'assert total([1]) == 1', 'test'],
    ['app/m.py', 'self.assertEqual(a, b)', 'test'],
    ['tests/test_m.py', 'result = total([1, 2])', 'test'],
  ],
  Go: [
    ['cmd/main.go', 'package main', 'import'],
    ['cmd/main.go', 'import (', 'import'],
    ['cmd/main.go', '"fmt"', 'import'],
    ['cmd/main.go', 'log "github.com/sirupsen/logrus"', 'import'],
    ['cmd/main.go', 'func (s *Server) Start(ctx context.Context) error {', 'declaration'],
    ['cmd/main.go', 'type Server struct {', 'declaration'],
    ['cmd/main.go', 'Name string `json:"name"`', 'declaration'],
    ['cmd/main.go', 'Close() error', 'declaration'],
    ['cmd/main.go', 'x := compute(1)', 'logic'],
    ['cmd/main.go', 'return err', 'logic'],
    ['cmd/main.go', 'fmt.Println("hola")', 'logic'],
    ['cmd/main.go', 'if err != nil {', 'logic'],
    ['cmd/main.go', '// Start arranca el server', 'comment'],
    ['cmd/main_test.go', 'got := Sum(1, 2)', 'test'],
    ['cmd/main.go', 't.Errorf("got %d", got)', 'test'],
  ],
  'Java/C#': [
    ['src/A.java', 'package com.acme;', 'import'],
    ['src/A.java', 'import java.util.List;', 'import'],
    ['src/A.java', 'public class A extends B {', 'declaration'],
    ['src/A.java', 'public static void main(String[] args) {', 'declaration'],
    ['src/A.java', 'String getName() {', 'declaration'],
    ['src/A.java', 'private final int x;', 'declaration'],
    ['src/A.java', '@Override', 'declaration'],
    ['src/A.java', 'int y = x + 1;', 'logic'],
    ['src/A.java', 'return repo.findAll();', 'logic'],
    ['src/A.java', 'assertEquals(1, x);', 'test'],
    ['src/A.java', '@Test', 'test'],
    ['src/A.cs', 'using System.Linq;', 'import'],
    ['src/A.cs', 'namespace Acme.Billing;', 'declaration'],
    ['src/A.cs', 'public sealed record Invoice(decimal Total);', 'declaration'],
    ['src/A.cs', 'public string Name { get; set; }', 'declaration'],
    ['src/A.cs', 'var total = items.Sum(i => i.Price);', 'logic'],
    ['src/A.cs', 'using (var conn = Open()) {', 'logic'],
    ['src/A.cs', '[Fact]', 'test'],
    ['src/A.cs', 'Assert.Equal(3, total);', 'test'],
    ['src/A.cs', '/// <summary>Doc</summary>', 'comment'],
  ],
  Rust: [
    ['src/lib.rs', 'use std::collections::HashMap;', 'import'],
    ['src/lib.rs', 'mod parser;', 'import'],
    ['src/lib.rs', 'pub fn run(cfg: &Config) -> Result<()> {', 'declaration'],
    ['src/lib.rs', 'pub struct Config {', 'declaration'],
    ['src/lib.rs', 'impl Display for Config {', 'declaration'],
    ['src/lib.rs', '#[derive(Debug, Clone)]', 'declaration'],
    ['src/lib.rs', 'let total: u32 = xs.iter().sum();', 'logic'],
    ['src/lib.rs', 'match x {', 'logic'],
    ['src/lib.rs', '#[test]', 'test'],
    ['src/lib.rs', 'assert_eq!(run(&cfg), Ok(()));', 'test'],
    ['src/lib.rs', '/// documenta run', 'comment'],
  ],
  'Config/Markdown/otros': [
    ['package.json', '"strict": true,', 'config'],
    ['package.json', '},', 'trivial'],
    ['config/app.yaml', 'retries: 3', 'config'],
    ['config/app.yml', '# comentario yaml', 'comment'],
    ['config/app.yml', '---', 'trivial'],
    ['Cargo.toml', '[dependencies]', 'config'],
    ['setup.ini', '; comentario ini', 'comment'],
    ['.env', 'API_URL=http://localhost', 'config'],
    ['.env.local', 'DEBUG=1', 'config'],
    ['README.md', '# Título', 'comment'],
    ['docs/guide.md', 'Texto explicativo.', 'comment'],
    ['docs/guide.md', '```ts', 'trivial'],
    ['scripts/run.sh', '#!/usr/bin/env bash', 'comment'],
    ['scripts/run.sh', 'fi', 'trivial'],
    ['scripts/run.sh', 'source ./env.sh', 'import'],
    ['db/q.sql', '-- índice', 'comment'],
    ['db/q.sql', 'CREATE TABLE users (', 'declaration'],
    ['src/x.c', '#include <stdio.h>', 'import'],
    ['src/x.c', '#define MAX 10', 'declaration'],
    ['infra/main.tf', 'resource "aws_s3_bucket" "b" {', 'declaration'],
    ['infra/main.tf', '# bucket', 'comment'],
    ['lib/a.rb', "require 'json'", 'import'],
    ['lib/a.rb', 'end', 'trivial'],
    ['lib/a.rb', 'def total', 'declaration'],
  ],
};

describe('classifyLine', () => {
  for (const [lang, rows] of Object.entries(table)) {
    describe(lang, () => {
      it.each(rows)('%s: %s → %s', (path, line, kind) => {
        expect(classifyLine(line, { path })).toBe(kind);
      });
    });
  }

  it('respeta languageId de VS Code por sobre la extensión', () => {
    // archivo sin extensión reconocible, pero el editor dice python
    expect(classifyLine('import os', { path: 'bin/tool', language: 'python' })).toBe('import');
    expect(classifyLine('# nota', { path: 'bin/tool', language: 'python' })).toBe('comment');
    expect(classifyLine('"a": 1,', { path: 'x.conf', language: 'json' })).toBe('config');
  });

  it('ignora indentación', () => {
    expect(classifyLine('        return x;', { path: 'src/a.ts' })).toBe('logic');
  });
});

describe('fileTier', () => {
  const tiers: Array<[string, FileTier]> = [
    ['src/index.ts', 'core'],
    ['lib/util.py', 'core'],
    ['app/page.tsx', 'core'],
    ['main.go', 'core'],
    ['src/a.test.ts', 'test'],
    ['src/a.spec.js', 'test'],
    ['tests/test_api.py', 'test'],
    ['pkg/__tests__/x.ts', 'test'],
    ['pkg/server_test.go', 'test'],
    ['src/test/java/com/acme/FooTest.java', 'test'],
    ['infra/stack.ts', 'infra'],
    ['Dockerfile', 'infra'],
    ['main.tf', 'infra'],
    ['.github/workflows/ci.yml', 'infra'],
    ['.github/PULL_REQUEST_TEMPLATE.md', 'infra'],
    ['docker-compose.yml', 'infra'],
    ['README.md', 'docs'],
    ['docs/metrics-model.md', 'docs'],
    ['docs/diagram.ts', 'docs'],
    ['package-lock.json', 'generated'],
    ['packages/x/yarn.lock', 'generated'],
    ['go.sum', 'generated'],
    ['dist/index.js', 'generated'],
    ['packages/metrics/dist/index.d.ts', 'generated'],
    ['dist/a.test.js', 'generated'],
    ['lib/model.g.dart', 'generated'],
    ['src/__snapshots__/a.test.ts.snap', 'generated'],
    ['public/app.min.js', 'generated'],
    ['C:\\repo\\dist\\x.js', 'generated'],
  ];
  it.each(tiers)('%s → %s', (path, tier) => {
    expect(fileTier(path)).toBe(tier);
  });
});

describe('isMechanical', () => {
  it('import, trivial y tier generated son mecánicos', () => {
    expect(isMechanical('import', 'core')).toBe(true);
    expect(isMechanical('trivial', 'core')).toBe(true);
    expect(isMechanical('logic', 'generated')).toBe(true);
    expect(isMechanical('logic', 'core')).toBe(false);
    expect(isMechanical('comment', 'docs')).toBe(false);
    expect(isMechanical('test', 'test')).toBe(false);
  });
});

describe('languageFamily / detectLanguage', () => {
  it('deduce por ruta y languageId', () => {
    expect(languageFamily('src/a.tsx')).toBe('js');
    expect(languageFamily('x', 'csharp')).toBe('csharp');
    expect(languageFamily('Dockerfile')).toBe('shell');
    expect(detectLanguage('src/a.ts')).toBe('typescript');
    expect(detectLanguage('src/a.unknownext')).toBeUndefined();
  });
});
