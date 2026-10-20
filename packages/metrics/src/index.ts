/**
 * @magicode/metrics — análisis LOCAL de cambios IA (docs/metrics-model.md).
 * Ve código, pero todo lo que devuelve son conteos, pesos y hashes: nunca contenido.
 */
export { normalizeLine, hashLine, outputHash, patchHash, round4, clamp01 } from './hash.js';
export { classifyLine, fileTier, isMechanical, languageFamily, detectLanguage, type LangFamily } from './classify.js';
export { parseUnifiedDiff, type DiffFile } from './diff.js';
export {
  analyzeChange,
  buildRepoHashIndex,
  resolveWeights,
  emptyByKind,
  DEFAULT_WEIGHTS,
  type WeightsConfig,
  type ChangeFileInput,
  type AnalyzedChange,
} from './analyze.js';
export { matchCommit, computeSurvival, type AcceptedChangeRef } from './commit.js';
