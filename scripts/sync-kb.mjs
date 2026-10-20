#!/usr/bin/env node
/**
 * Copia la guía (docs/kb/*.md + index.json) a apps/dashboard/public/kb/, que el dashboard
 * Angular sirve en /kb/*. Antes de copiar valida el índice:
 *   - index.json es JSON válido y un arreglo de { id, title, summary, file, metric_keys[], tags[] }
 *   - ids únicos, cada `file` existe y cada .md de docs/kb está en el índice
 *   - cada metric_key aparece en un solo artículo (el "?" del dashboard lleva a un único lugar)
 *   - los enlaces relativos entre artículos (`[x](otro.md)`) apuntan a archivos existentes
 * Uso: node scripts/sync-kb.mjs        (falla con código 1 si la validación no pasa)
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'docs', 'kb');
const dest = join(root, 'apps', 'dashboard', 'public', 'kb');

const errors = [];
const index = JSON.parse(readFileSync(join(src, 'index.json'), 'utf8'));
if (!Array.isArray(index)) errors.push('index.json debe ser un arreglo');

const mdFiles = readdirSync(src).filter((f) => f.endsWith('.md'));
const ids = new Set();
const keyOwner = new Map();
for (const a of index) {
  for (const field of ['id', 'title', 'summary', 'file']) {
    if (typeof a[field] !== 'string' || !a[field]) errors.push(`${a.id ?? '?'}: falta "${field}"`);
  }
  if (!Array.isArray(a.metric_keys) || !Array.isArray(a.tags)) errors.push(`${a.id}: metric_keys y tags deben ser arreglos`);
  if (ids.has(a.id)) errors.push(`id duplicado: ${a.id}`);
  ids.add(a.id);
  if (!existsSync(join(src, a.file))) errors.push(`${a.id}: no existe ${a.file}`);
  for (const k of a.metric_keys ?? []) {
    if (keyOwner.has(k)) errors.push(`metric_key "${k}" en ${keyOwner.get(k)} y ${a.id}`);
    else keyOwner.set(k, a.id);
  }
}
const listed = new Set(index.map((a) => a.file));
for (const f of mdFiles) if (!listed.has(f)) errors.push(`${f} no está en index.json`);

for (const f of mdFiles) {
  const text = readFileSync(join(src, f), 'utf8');
  for (const m of text.matchAll(/\]\(([^)#\s]+\.md)(#[^)]*)?\)/g)) {
    if (!/^[a-z]+:/i.test(m[1]) && !existsSync(join(src, m[1]))) errors.push(`${f}: enlace roto a ${m[1]}`);
  }
}

if (errors.length) {
  console.error(`sync-kb: ${errors.length} error(es)\n- ${errors.join('\n- ')}`);
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
for (const f of [...mdFiles, 'index.json']) copyFileSync(join(src, f), join(dest, f));
console.log(`sync-kb: ${mdFiles.length} artículos + index.json → ${dest.replace(root + '/', '')} (${keyOwner.size} metric_keys)`);
