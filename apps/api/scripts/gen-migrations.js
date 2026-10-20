#!/usr/bin/env node
/**
 * Genera src/orm/migrations.ts a partir de migrations/*.sql (fuente de verdad).
 * Así el SQL viaja DENTRO del bundle (CDK NodejsFunction / esbuild) sin loaders ni archivos extra.
 * Uso: npm run migrations:gen -w @magicode/api   (un test verifica que estén sincronizados)
 */
const { readdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const dir = join(__dirname, '..', 'migrations');
const out = join(__dirname, '..', 'src', 'orm', 'migrations.ts');
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

const body = files
  .map((f) => `  {\n    version: ${JSON.stringify(f.replace(/\.sql$/, ''))},\n    sql: ${JSON.stringify(readFileSync(join(dir, f), 'utf8'))},\n  },`)
  .join('\n');

writeFileSync(
  out,
  `// ARCHIVO GENERADO por scripts/gen-migrations.js desde migrations/*.sql — no editar a mano.\n` +
    `// Regenerar: npm run migrations:gen -w @magicode/api\n\n` +
    `export interface EmbeddedMigration {\n  version: string;\n  sql: string;\n}\n\n` +
    `export const MIGRATIONS: EmbeddedMigration[] = [\n${body}\n];\n`,
);
console.log(`✓ ${files.length} migración(es) → src/orm/migrations.ts`);
