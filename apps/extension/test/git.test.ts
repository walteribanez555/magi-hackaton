import { mkdtempSync, promises as fs, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeAcceptance, makeProposal, proposedPayload } from '../src/changes';
import { analyzeCommit, computeReference, createAnnotatedTag, listNewCommits, readCommitDiff, readCommitHeader } from '../src/commits';
import {
  COMMIT_HEADER_FORMAT,
  defaultReferenceTag,
  git,
  hasSessionTrailer,
  headSha,
  hooksDir,
  isProbablyBinary,
  isValidTagName,
  languageFromPath,
  parseCommitHeader,
  parseNulList,
  repoSlugFromRemote,
  sanitizeRemoteUrl,
  sessionTrailers,
  toRepoPath,
} from '../src/git';
import { hookStatus, installHook, writeSessionFile } from '../src/hook';
import { nullLogger } from '../src/log';
import { RepoHashIndex } from '../src/repoIndex';
import { createSession, recordCommitted, pendingForCommit, sessionAcceptedHashes } from '../src/session';
import { buildEvent, validateEvent } from '../src/telemetry';

describe('git output parsing helpers', () => {
  it('derives org/repo from remotes', () => {
    expect(repoSlugFromRemote('git@github.com:acme/shop.git')).toBe('acme/shop');
    expect(repoSlugFromRemote('https://github.com/acme/shop')).toBe('acme/shop');
    expect(repoSlugFromRemote('https://x-token:ghp_abc@github.com/acme/shop.git')).toBe('acme/shop');
    expect(repoSlugFromRemote('ssh://git@bitbucket.org:7999/team/app.git')).toBe('team/app');
    expect(repoSlugFromRemote('https://gitlab.com/group/sub/proj.git')).toBe('sub/proj');
    expect(repoSlugFromRemote('/local/path')).toBeUndefined();
    expect(repoSlugFromRemote(undefined)).toBeUndefined();
  });

  it('sanitizes credentials from remote URLs', () => {
    expect(sanitizeRemoteUrl('https://user:ghp_secret@github.com/acme/shop.git')).toBe('https://github.com/acme/shop.git');
    expect(sanitizeRemoteUrl('https://ghp_token@github.com/acme/shop.git')).toBe('https://github.com/acme/shop.git');
    expect(sanitizeRemoteUrl('ssh://git:pw@host/a/b.git')).toBe('ssh://git@host/a/b.git');
    expect(sanitizeRemoteUrl('git@github.com:acme/shop.git')).toBe('git@github.com:acme/shop.git');
  });

  it('parses NUL-separated commit headers with multi-line messages', () => {
    const out = `${'a'.repeat(40)}\0${'b'.repeat(40)} ${'c'.repeat(40)}\0` + `2026-10-20T10:00:00-04:00\0feat: x\n\nbody\n\nMagiCode-Session: s-1\n`;
    const h = parseCommitHeader(out)!;
    expect(h.parents).toHaveLength(2);
    expect(h.committedAt).toBe('2026-10-20T10:00:00-04:00');
    expect(h.message.endsWith('MagiCode-Session: s-1')).toBe(true);
    expect(hasSessionTrailer(h.message, 's-1')).toBe(true);
    expect(hasSessionTrailer(h.message, 's-2')).toBe(false);
    expect(sessionTrailers('MagiCode-Session: a\nmagicode-session: b')).toEqual(['a', 'b']);
    expect(parseCommitHeader('garbage')).toBeUndefined();
    const root = parseCommitHeader(`${'a'.repeat(40)}\0\0` + `2026-10-20T10:00:00Z\0init`)!;
    expect(root.parents).toEqual([]);
  });

  it('misc helpers', () => {
    expect(parseNulList('a\0b c\0\0')).toEqual(['a', 'b c']);
    expect(isProbablyBinary(new Uint8Array([65, 0, 66]))).toBe(true);
    expect(isProbablyBinary(Buffer.from('hello'))).toBe(false);
    expect(languageFromPath('src/a.test.ts')).toBe('typescript');
    expect(languageFromPath('Dockerfile')).toBe('dockerfile');
    expect(languageFromPath('LICENSE')).toBeUndefined();
    expect(toRepoPath('/r/repo', '/r/repo/src/a.ts')).toBe('src/a.ts');
    expect(toRepoPath('/r/repo', '/r/other/a.ts')).toBeUndefined();
    expect(defaultReferenceTag(new Date(2026, 9, 20, 9, 5))).toBe('magicode-demo-20261020-0905');
    expect(isValidTagName('magicode-demo-20261020')).toBe(true);
    expect(isValidTagName('bad..tag')).toBe(false);
    expect(isValidTagName('-x')).toBe(false);
  });
});

/** Flujo completo sin VS Code: aceptar → hook con trailer → commit → match → tag → supervivencia. */
describe('end-to-end against a real temporary git repo', () => {
  let dir: string;
  const env = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' };
  const original = 'export function sum(a: number, b: number): number {\n  return a + b;\n}\n';

  beforeAll(async () => {
    Object.assign(process.env, env);
    dir = mkdtempSync(path.join(tmpdir(), 'magicode-test-'));
    await git(dir, ['init', '-q', '-b', 'feature/mag-42-clamp']);
    await git(dir, ['config', 'commit.gpgsign', 'false']);
    await git(dir, ['config', 'core.hooksPath', '.git/hooks']);
    await fs.mkdir(path.join(dir, 'src'));
    await fs.writeFile(path.join(dir, 'src/math.ts'), original);
    await fs.writeFile(path.join(dir, 'src/util.ts'), 'export const clampMin = 0;\nexport function noop() {}\n');
    await fs.writeFile(path.join(dir, 'logo.bin'), Buffer.from([0, 1, 2, 3]));
    await git(dir, ['add', '.']);
    await git(dir, ['commit', '-q', '-m', 'initial']);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('accepts a change, commits it with the trailer and measures survival at the tag', async () => {
    const head0 = await headSha(dir);
    expect(head0).toMatch(/^[0-9a-f]{40}$/);
    const session = createSession(dir, new Date(Date.now() - 1000), head0);

    // índice del repo antes de aplicar
    const index = new RepoHashIndex(session.salt, dir, nullLogger);
    await index.ensureBuilt();
    expect(index.fileCount).toBe(2); // el binario se omite
    expect(index.skipped).toBe(1);

    const proposedText =
      original +
      '\nexport function clamp(x: number, min: number, max: number): number {\n  if (min > max) throw new Error("min > max");\n  return Math.min(Math.max(x, min), max);\n}\nexport const clampMin = 0;\n';
    const proposal = makeProposal({ change_id: 'c-1', ai_request_id: 'req-1', path: 'src/math.ts', language: 'typescript', originalText: original, proposedText });
    const proposed = proposedPayload(session.salt, proposal);
    expect(validateEvent(buildEvent({ session_id: session.id, project_id: 'p', repository: 'org/r' }, 'code.proposed', proposed)).ok).toBe(true);
    expect(proposed.files[0]).toMatchObject({ path: 'src/math.ts', added: 5, deleted: 0 });

    const acc = analyzeAcceptance({
      salt: session.salt,
      proposal,
      finalText: proposedText,
      baseText: original,
      edited: false,
      existingRepoHashes: index.snapshot(),
      sessionAcceptedHashes: sessionAcceptedHashes(session),
    });
    const accEvent = buildEvent({ session_id: session.id, project_id: 'p', repository: 'org/r', task_key: 'MAG-42' }, 'code.accepted', acc.payload);
    const v = validateEvent(accEvent);
    expect(v.ok, v.ok ? '' : v.issues).toBe(true);
    expect(acc.payload.dimensions.redundancy.existing_in_repo).toBeGreaterThanOrEqual(1); // clampMin ya existía
    expect(JSON.stringify(accEvent)).not.toContain('Math.min'); // sin código en la telemetría
    session.changes.push(acc.stored);
    await fs.writeFile(path.join(dir, 'src/math.ts'), proposedText);

    // hook + archivo de sesión → trailers en el commit
    const hooks = (await hooksDir(dir))!;
    expect(await hookStatus(hooks)).toBe('absent');
    await installHook(hooks);
    expect(await hookStatus(hooks)).toBe('magicode');
    const gitDir = (await git(dir, ['rev-parse', '--absolute-git-dir'])).trim();
    await writeSessionFile(gitDir, session.id, 'MAG-42');
    // el humano agrega una línea propia además del cambio IA
    await fs.appendFile(path.join(dir, 'src/math.ts'), 'export const human = 1;\n');
    await git(dir, ['commit', '-q', '-am', 'feat: clamp']);

    const head1 = (await headSha(dir))!;
    const shas = await listNewCommits(dir, head0, head1);
    expect(shas).toEqual([head1]);
    const header = (await readCommitHeader(dir, head1))!;
    expect(header.message).toContain(`MagiCode-Session: ${session.id}`);
    expect(header.message).toContain('MagiCode-Task: MAG-42');
    const raw = await git(dir, ['log', '-1', `--format=${COMMIT_HEADER_FORMAT}`, head1]);
    expect(parseCommitHeader(raw)!.sha).toBe(head1);

    const a = analyzeCommit(session, header, await readCommitDiff(dir, header));
    expect(a.matched).toBe(true);
    expect(a.payload.change_ids).toEqual(['c-1']);
    expect(a.payload.has_session_trailer).toBe(true);
    expect(a.payload.automation.ai_matched_lines).toBeGreaterThan(0);
    expect(a.payload.automation.ai_share).toBeLessThan(1); // la línea humana no es IA
    const gitEvent = buildEvent({ session_id: session.id, project_id: 'p', repository: 'org/r', branch: 'feature/mag-42-clamp' }, 'git.committed', a.payload);
    const gv = validateEvent(gitEvent);
    expect(gv.ok, gv.ok ? '' : gv.issues).toBe(true);
    recordCommitted(session, a.payload.change_ids, a.matchedHashes);
    session.commits.push({ sha: head1, committed_at: header.committedAt, change_ids: a.payload.change_ids, ai_share: a.payload.automation.ai_share, ai_matched_lines: a.aiMatchedLines, has_session_trailer: true });
    expect(pendingForCommit(session).length).toBeLessThanOrEqual(1);

    // commit raíz también se puede leer (diff-tree --root)
    const rootHeader = (await readCommitHeader(dir, head0!))!;
    expect(await readCommitDiff(dir, rootHeader)).toContain('src/math.ts');

    // versión de referencia
    await createAnnotatedTag(dir, 'magicode-demo-test', 'demo');
    const ref = await computeReference(dir, session, 'magicode-demo-test');
    expect(ref.sha).toBe(head1);
    expect(ref.payload.included_shas).toEqual([head1]);
    expect(ref.payload.surviving_lines).toBeGreaterThan(0);
    expect(ref.payload.kind).toBe('demo-reference');
    const rv = validateEvent(buildEvent({ session_id: session.id, project_id: 'p', repository: 'org/r' }, 'reference.marked', ref.payload));
    expect(rv.ok, rv.ok ? '' : rv.issues).toBe(true);
  });
});
