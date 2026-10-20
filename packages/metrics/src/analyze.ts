import {
  ChangeDimensions,
  DEFAULT_KIND_WEIGHTS,
  DEFAULT_TIER_WEIGHTS,
  LineKind,
  type FileChange,
  type FileTier,
} from '@magicode/contracts';
import { classifyLine, detectLanguage, fileTier, isMechanical } from './classify.js';
import { hashLine, normalizeLine, patchHash, ratio, round4, splitLines } from './hash.js';

export interface WeightsConfig {
  kinds: Record<LineKind, number>;
  tiers: Record<FileTier, number>;
}

export const DEFAULT_WEIGHTS: WeightsConfig = {
  kinds: { ...DEFAULT_KIND_WEIGHTS },
  tiers: { ...DEFAULT_TIER_WEIGHTS },
};

/**
 * Combina pesos parciales del proyecto con los por defecto. Valores no finitos se ignoran y
 * se acotan a [0, 1] para que `importance.score` siga siendo 0..1.
 */
export function resolveWeights(weights?: Partial<WeightsConfig>): WeightsConfig {
  const pick = <K extends string>(base: Record<K, number>, over?: Partial<Record<K, number>>): Record<K, number> => {
    const out = { ...base };
    for (const k of Object.keys(base) as K[]) {
      const v = over?.[k];
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.min(1, Math.max(0, v));
    }
    return out;
  };
  return { kinds: pick(DEFAULT_WEIGHTS.kinds, weights?.kinds), tiers: pick(DEFAULT_WEIGHTS.tiers, weights?.tiers) };
}

export interface ChangeFileInput {
  path: string;
  language?: string;
  addedLines: string[];
  deletedLines: string[];
  /** propuesta original de la IA antes de que el usuario la editara (si difiere) */
  proposedAddedLines?: string[];
}

export interface AnalyzedChange {
  dimensions: ChangeDimensions;
  files: FileChange[];
  acceptedAddedLines: number;
  acceptedDeletedLines: number;
  /** hashes ÚNICOS de las líneas agregadas no vacías y no triviales */
  lineHashes: string[];
  /** hash → peso efectivo (0 si la línea es redundante o mecánica) */
  effectiveWeights: Record<string, number>;
  patchHash: string;
}

/** Contadores en cero para todas las clases (el contrato exige todas las claves). */
export function emptyByKind(): Record<LineKind, number> {
  return Object.fromEntries(LineKind.options.map((k) => [k, 0])) as Record<LineKind, number>;
}

/** Líneas no vacías (tras normalizar). Acepta también líneas con `\n` embebido. */
function nonEmpty(lines: string[]): string[] {
  return lines.flatMap((l) => splitLines(l)).filter((l) => normalizeLine(l).length > 0);
}

/**
 * Calcula las 3 aristas de un cambio aceptado (docs/metrics-model.md §2) en local.
 *
 * Decisiones:
 * - `lines` = líneas agregadas no vacías (incluye triviales); `by_kind` las cuenta todas.
 * - Redundancia solo sobre líneas no triviales. Cada línea se cuenta UNA vez con prioridad
 *   `intra_change` (2ª+ aparición en el cambio, entre todos sus archivos) → `repeated_in_session`
 *   → `existing_in_repo`. `existingRepoHashes` debe construirse ANTES de aplicar el cambio.
 * - `accepted_as_is` / `edited_before_accept`: si el archivo trae `proposedAddedLines`, una línea
 *   es "tal cual" si su forma normalizada está en la propuesta; si no, editada. Sin propuesta,
 *   todas cuentan como tal cual.
 * - `effectiveWeights[h]` = peso efectivo de la PRIMERA aparición del hash (las siguientes son
 *   redundantes intra-cambio y valen 0), por lo que Σ effectiveWeights = effective_lines.
 * - `patchHash` = rutas ordenadas + hashes de líneas agregadas (todas las no vacías, en orden)
 *   y borradas (prefijo `-`).
 */
export function analyzeChange(input: {
  salt: string;
  files: ChangeFileInput[];
  existingRepoHashes: ReadonlySet<string>;
  sessionAcceptedHashes: ReadonlySet<string>;
  weights?: Partial<WeightsConfig>;
}): AnalyzedChange {
  const w = resolveWeights(input.weights);
  const byKind = emptyByKind();
  const seen = new Set<string>();
  const effectiveWeights: Record<string, number> = {};
  const lineHashes: string[] = [];
  const files: FileChange[] = [];
  const patchFiles: Array<{ path: string; lineHashes: string[] }> = [];

  let lines = 0;
  let weighted = 0;
  let nonTrivial = 0;
  let intra = 0;
  let session = 0;
  let repo = 0;
  let mechanical = 0;
  let asIs = 0;
  let edited = 0;
  let effective = 0;
  let deletedTotal = 0;

  for (const f of input.files) {
    const ctx = { path: f.path, language: f.language };
    const tier = fileTier(f.path);
    const added = nonEmpty(f.addedLines);
    const deleted = nonEmpty(f.deletedLines);
    const proposal = f.proposedAddedLines ? new Set(nonEmpty(f.proposedAddedLines).map(normalizeLine)) : null;
    const patchLines: string[] = [];

    for (const raw of added) {
      const norm = normalizeLine(raw);
      const kind = classifyLine(norm, ctx);
      const weight = w.kinds[kind] * w.tiers[tier];
      const mech = isMechanical(kind, tier);
      const h = hashLine(input.salt, norm);
      patchLines.push(h);
      lines++;
      byKind[kind]++;
      weighted += weight;
      if (mech) mechanical++;
      if (!proposal || proposal.has(norm)) asIs++;
      else edited++;
      if (kind === 'trivial') continue;

      nonTrivial++;
      let redundant = true;
      if (seen.has(h)) intra++;
      else if (input.sessionAcceptedHashes.has(h)) session++;
      else if (input.existingRepoHashes.has(h)) repo++;
      else redundant = false;

      if (!seen.has(h)) {
        seen.add(h);
        lineHashes.push(h);
        const eff = redundant || mech ? 0 : weight;
        effectiveWeights[h] = round4(eff);
        effective += eff;
      }
    }

    for (const raw of deleted) patchLines.push(`-${hashLine(input.salt, normalizeLine(raw))}`);
    deletedTotal += deleted.length;
    const language = f.language ?? detectLanguage(f.path);
    files.push({ path: f.path, ...(language ? { language } : {}), added: added.length, deleted: deleted.length });
    patchFiles.push({ path: f.path, lineHashes: patchLines });
  }

  const redundant = intra + session + repo;
  const dimensions: ChangeDimensions = {
    importance: { lines, weighted_lines: round4(weighted), score: ratio(weighted, lines), by_kind: byKind },
    redundancy: {
      intra_change: intra,
      existing_in_repo: repo,
      repeated_in_session: session,
      redundant_lines: redundant,
      score: ratio(redundant, nonTrivial),
    },
    automation: {
      mechanical_lines: mechanical,
      mechanical_share: ratio(mechanical, lines),
      accepted_as_is: asIs,
      edited_before_accept: edited,
    },
    effective_lines: round4(effective),
  };

  return {
    dimensions,
    files,
    acceptedAddedLines: lines,
    acceptedDeletedLines: deletedTotal,
    lineHashes,
    effectiveWeights,
    patchHash: patchHash(patchFiles),
  };
}

/**
 * Índice de hashes del workspace (para `existing_in_repo`): líneas no vacías y NO triviales.
 * Construirlo antes de aplicar el cambio aceptado.
 */
export function buildRepoHashIndex(salt: string, files: Array<{ path: string; content: string }>): Set<string> {
  const index = new Set<string>();
  for (const f of files) {
    for (const raw of splitLines(f.content)) {
      const norm = normalizeLine(raw);
      if (norm === '' || classifyLine(norm, { path: f.path }) === 'trivial') continue;
      index.add(hashLine(salt, norm));
    }
  }
  return index;
}
