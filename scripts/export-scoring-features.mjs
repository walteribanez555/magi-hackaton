#!/usr/bin/env node
// Exporta SCORING_FEATURES (orden fijo de columnas del modelo) desde el build de
// @magicode/contracts a ml/features.json, para que Python (features.py / train.py) y
// TypeScript (apps/api/src/modules/scoring) nunca diverjan.
//
// Uso:  npm run build -w @magicode/contracts && node scripts/export-scoring-features.mjs
//       node scripts/export-scoring-features.mjs --check   # falla (exit 1) si ml/features.json está desactualizado
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distEntry = join(root, 'packages/contracts/dist/scoring.js');
const outFile = join(root, 'ml/features.json');

let mod;
try {
  mod = await import(pathToFileURL(distEntry).href);
} catch (err) {
  console.error(`✗ No se pudo cargar ${distEntry}. Compila primero: npm run build -w @magicode/contracts`);
  console.error(String(err));
  process.exit(1);
}

const { SCORING_FEATURES, CRITICALITY_THRESHOLDS } = mod;
if (!Array.isArray(SCORING_FEATURES) || SCORING_FEATURES.length === 0) {
  console.error('✗ SCORING_FEATURES no encontrado en el build de contracts');
  process.exit(1);
}

const payload = {
  $comment: 'GENERADO por scripts/export-scoring-features.mjs desde @magicode/contracts (scoring.ts). No editar a mano.',
  features: [...SCORING_FEATURES],
  criticality_thresholds: CRITICALITY_THRESHOLDS,
};
const json = `${JSON.stringify(payload, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const current = await readFile(outFile, 'utf8').catch(() => '');
  if (current !== json) {
    console.error('✗ ml/features.json está desactualizado: corre node scripts/export-scoring-features.mjs');
    process.exit(1);
  }
  console.log(`✓ ml/features.json al día (${SCORING_FEATURES.length} features)`);
} else {
  await writeFile(outFile, json);
  console.log(`✓ ${outFile} (${SCORING_FEATURES.length} features)`);
}
