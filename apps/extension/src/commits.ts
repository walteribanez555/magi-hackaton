/**
 * Detección de commits y versión de referencia. Cruza hashes de líneas aceptadas con el diff real
 * del commit (git local) y con el contenido del SHA del tag. Puro: no importa 'vscode'.
 */
import { computeSurvival, matchCommit, parseUnifiedDiff } from '@magicode/metrics';
import {
  COMMIT_HEADER_FORMAT,
  git,
  gitOk,
  hasSessionTrailer,
  languageFromPath,
  parseCommitHeader,
  runGit,
  type CommitHeader,
} from './git';
import { acceptedForMatching, pendingForCommit, round2, touchedPaths, type SessionState } from './session';
import type { PayloadOf } from './telemetry';

const MAX_NEW_COMMITS = 50;

/**
 * Commits nuevos entre `lastHead` y `newHead` (más viejo primero). Si `lastHead` no es ancestro
 * (checkout de otra rama, amend, rebase) git devuelve igual los alcanzables desde `newHead`
 * que no lo son desde `lastHead`; el llamador filtra por fecha de sesión y procesados.
 */
export async function listNewCommits(root: string, lastHead: string | undefined, newHead: string): Promise<string[]> {
  const args = ['rev-list', '--reverse', `--max-count=${MAX_NEW_COMMITS}`, newHead];
  if (lastHead && lastHead !== newHead && (await gitOk(root, ['cat-file', '-e', `${lastHead}^{commit}`]))) args.push(`^${lastHead}`);
  else if (lastHead === newHead) return [];
  const out = await git(root, args);
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

export async function readCommitHeader(root: string, sha: string): Promise<CommitHeader | undefined> {
  const out = await git(root, ['log', '-1', `--format=${COMMIT_HEADER_FORMAT}`, sha]);
  return parseCommitHeader(out);
}

/** Diff unificado del commit contra su primer padre (o contra vacío si es el commit raíz). */
export async function readCommitDiff(root: string, header: CommitHeader): Promise<string> {
  const common = ['-U0', '--no-color', '--no-ext-diff', '--no-textconv', '-M'];
  const parent = header.parents[0];
  if (parent) return git(root, ['diff', ...common, parent, header.sha]);
  return git(root, ['diff-tree', '-p', '-r', '--root', '--no-commit-id', ...common, header.sha]);
}

export interface CommitAnalysis {
  payload: PayloadOf<'git.committed'>;
  matched: boolean;
  aiMatchedLines: number;
  matchedHashes: string[];
}

/** Analiza un commit; `payload` listo para `git.committed` (sin remote_url/branch). */
export function analyzeCommit(session: SessionState, header: CommitHeader, diffText: string): CommitAnalysis {
  const commitFiles = parseUnifiedDiff(diffText).map((f) => ({
    path: f.path,
    language: languageFromPath(f.path),
    addedLines: f.addedLines,
    deletedLines: f.deletedLines,
  }));
  const m = matchCommit({ salt: session.salt, commitFiles, acceptedChanges: pendingForCommit(session) });
  const trailer = hasSessionTrailer(header.message, session.id);
  return {
    matched: m.change_ids.length > 0 || trailer,
    aiMatchedLines: m.automation.ai_matched_lines,
    matchedHashes: m.matchedHashes,
    payload: {
      sha: header.sha,
      ...(header.parents[0] ? { parent_sha: header.parents[0] } : {}),
      committed_at: header.committedAt,
      files: m.files.slice(0, 500),
      change_ids: m.change_ids.slice(0, 500),
      automation: { ...m.automation, effective_lines: round2(m.automation.effective_lines) },
      has_session_trailer: trailer,
      source: 'git-local',
    },
  };
}

// ───────────────────────── versión de referencia ─────────────────────────

export async function tagExists(root: string, tag: string): Promise<boolean> {
  return gitOk(root, ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]);
}

export async function createAnnotatedTag(root: string, tag: string, message: string): Promise<void> {
  await git(root, ['tag', '-a', tag, '-m', message]);
}

export async function tagCommitSha(root: string, tag: string): Promise<string> {
  return (await git(root, ['rev-parse', `refs/tags/${tag}^{commit}`])).trim();
}

export async function isAncestor(root: string, sha: string, of: string): Promise<boolean> {
  return gitOk(root, ['merge-base', '--is-ancestor', sha, of]);
}

/** Líneas de `path` en `sha` (undefined si no existe en ese SHA). */
export async function fileLinesAt(root: string, sha: string, path: string): Promise<string[] | undefined> {
  const r = await runGit(root, ['show', `${sha}:${path}`]);
  if (r.code !== 0) return undefined;
  const lines = r.stdout.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export async function computeReference(
  root: string,
  session: SessionState,
  tag: string,
): Promise<{ sha: string; payload: PayloadOf<'reference.marked'> }> {
  const sha = await tagCommitSha(root, tag);
  const included: string[] = [];
  for (const c of session.commits) {
    if (c.sha === sha || (await isAncestor(root, c.sha, sha))) included.push(c.sha);
  }
  const filesAtRef: Array<{ path: string; lines: string[] }> = [];
  for (const path of touchedPaths(session)) {
    const lines = await fileLinesAt(root, sha, path);
    if (lines) filesAtRef.push({ path, lines });
  }
  const s = computeSurvival({ salt: session.salt, filesAtRef, acceptedChanges: acceptedForMatching(session) });
  return {
    sha,
    payload: {
      tag,
      sha,
      kind: 'demo-reference', // "deployment" solo con evidencia real (no lo emite la extensión)
      included_shas: [...new Set(included)].slice(0, 500),
      surviving_lines: s.surviving_lines,
      surviving_effective_lines: round2(s.surviving_effective_lines),
    },
  };
}
