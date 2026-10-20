import type { CommitAutomation, FileChange } from '@magicode/contracts';
import { classifyLine, detectLanguage } from './classify.js';
import { hashLine, normalizeLine, ratio, round4 } from './hash.js';

/** Lo mínimo que la extensión guarda de cada cambio aceptado (sin código). */
export interface AcceptedChangeRef {
  change_id: string;
  lineHashes: string[];
  effectiveWeights: Record<string, number>;
}

/**
 * "Bolsa" de ocurrencias aceptadas: hash → cola de change_ids que lo aceptaron.
 * Cada ocurrencia encontrada consume una entrada (multiconjunto), así un `return null;`
 * aceptado una vez no casa con cinco apariciones del commit.
 */
function acceptedPool(changes: AcceptedChangeRef[]): Map<string, number[]> {
  const pool = new Map<string, number[]>();
  changes.forEach((c, idx) => {
    for (const h of new Set(c.lineHashes)) {
      const q = pool.get(h);
      if (q) q.push(idx);
      else pool.set(h, [idx]);
    }
  });
  return pool;
}

/**
 * Cruza las líneas agregadas de un commit con los hashes de líneas IA aceptadas.
 *
 * Decisiones:
 * - `commit_added_lines` cuenta líneas agregadas no vacías y NO triviales (numerador y
 *   denominador de `ai_share` excluyen triviales, que casarían por azar). `files[].added` sí
 *   cuenta todas las no vacías, como en `code.accepted`.
 * - Multiconjunto: cada línea aceptada casa como máximo una vez; si dos cambios aceptaron el
 *   mismo hash, se asigna al primero en el orden de `acceptedChanges` que aún tenga cupo.
 * - `ai_lost_lines` = hashes de los cambios con ≥1 coincidencia que no aparecen en el commit.
 *   Si un cambio se reparte en varios commits, las líneas del otro commit cuentan como perdidas
 *   aquí: pasar solo los cambios aún no registrados.
 * - `matchedHashes` = hashes únicos que casaron, en orden de aparición.
 */
export function matchCommit(input: {
  salt: string;
  commitFiles: Array<{ path: string; language?: string; addedLines: string[]; deletedLines: string[] }>;
  acceptedChanges: AcceptedChangeRef[];
}): { automation: CommitAutomation; change_ids: string[]; files: FileChange[]; matchedHashes: string[] } {
  const pool = acceptedPool(input.acceptedChanges);
  const matchedPerChange = input.acceptedChanges.map(() => new Set<string>());
  const matchedHashes: string[] = [];
  const matchedSeen = new Set<string>();
  const files: FileChange[] = [];
  let commitAdded = 0;
  let matched = 0;
  let effective = 0;

  for (const f of input.commitFiles) {
    const ctx = { path: f.path, language: f.language };
    let added = 0;
    for (const raw of f.addedLines) {
      const norm = normalizeLine(raw);
      if (norm === '') continue;
      added++;
      if (classifyLine(norm, ctx) === 'trivial') continue;
      commitAdded++;
      const h = hashLine(input.salt, norm);
      const idx = pool.get(h)?.shift();
      if (idx === undefined) continue;
      matched++;
      matchedPerChange[idx]!.add(h);
      effective += input.acceptedChanges[idx]!.effectiveWeights[h] ?? 0;
      if (!matchedSeen.has(h)) {
        matchedSeen.add(h);
        matchedHashes.push(h);
      }
    }
    const deleted = f.deletedLines.filter((l) => normalizeLine(l) !== '').length;
    const language = f.language ?? detectLanguage(f.path);
    files.push({ path: f.path, ...(language ? { language } : {}), added, deleted });
  }

  const change_ids: string[] = [];
  let lost = 0;
  input.acceptedChanges.forEach((c, idx) => {
    const got = matchedPerChange[idx]!;
    if (got.size === 0) return;
    change_ids.push(c.change_id);
    lost += new Set(c.lineHashes).size - got.size;
  });

  return {
    automation: {
      commit_added_lines: commitAdded,
      ai_matched_lines: matched,
      ai_share: ratio(matched, commitAdded),
      ai_lost_lines: lost,
      effective_lines: round4(effective),
    },
    change_ids,
    files,
    matchedHashes,
  };
}

/**
 * Supervivencia en la versión de referencia: líneas aceptadas cuyo hash sigue presente en
 * algún archivo del SHA del tag. Multiconjunto como `matchCommit` (cada ocurrencia en el tag
 * respalda a lo sumo una línea aceptada).
 */
export function computeSurvival(input: {
  salt: string;
  filesAtRef: Array<{ path: string; lines: string[] }>;
  acceptedChanges: AcceptedChangeRef[];
}): { surviving_lines: number; surviving_effective_lines: number; surviving_change_ids: string[] } {
  const available = new Map<string, number>();
  for (const f of input.filesAtRef) {
    for (const raw of f.lines) {
      const norm = normalizeLine(raw);
      if (norm === '') continue;
      const h = hashLine(input.salt, norm);
      available.set(h, (available.get(h) ?? 0) + 1);
    }
  }

  let lines = 0;
  let effective = 0;
  const ids: string[] = [];
  for (const c of input.acceptedChanges) {
    let survived = 0;
    for (const h of new Set(c.lineHashes)) {
      const n = available.get(h) ?? 0;
      if (n <= 0) continue;
      available.set(h, n - 1);
      survived++;
      effective += c.effectiveWeights[h] ?? 0;
    }
    if (survived > 0) ids.push(c.change_id);
    lines += survived;
  }
  return { surviving_lines: lines, surviving_effective_lines: round4(effective), surviving_change_ids: ids };
}
