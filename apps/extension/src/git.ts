/**
 * Git vía `execFile` (sin shell) + helpers de parsing. Puro: no importa 'vscode'.
 */
import { execFile } from 'node:child_process';
import { extractTaskKeys } from '@magicode/contracts';

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Ejecuta git y devuelve stdout/stderr/código sin lanzar. */
export function runGit(cwd: string, args: string[], maxBuffer = 64 * 1024 * 1024): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code });
      },
    );
  });
}

/** Ejecuta git y lanza si falla. */
export async function git(cwd: string, args: string[], maxBuffer?: number): Promise<string> {
  const r = await runGit(cwd, args, maxBuffer);
  if (r.code !== 0) throw new Error(`git ${args[0]} falló (${r.code}): ${r.stderr.trim().slice(0, 300)}`);
  return r.stdout;
}

export async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  return (await runGit(cwd, args)).code === 0;
}

export async function repoRoot(cwd: string): Promise<string | undefined> {
  const r = await runGit(cwd, ['rev-parse', '--show-toplevel']);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

export async function headSha(root: string): Promise<string | undefined> {
  const r = await runGit(root, ['rev-parse', '--verify', '-q', 'HEAD']);
  const sha = r.stdout.trim();
  return r.code === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : undefined;
}

/** Rama actual; undefined si HEAD está detached o no hay commits aún sin rama. */
export async function currentBranch(root: string): Promise<string | undefined> {
  const r = await runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const b = r.stdout.trim();
  return r.code === 0 && b ? b : undefined;
}

export async function absoluteGitDir(root: string): Promise<string | undefined> {
  const r = await runGit(root, ['rev-parse', '--absolute-git-dir']);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

/** Ruta de hooks real (respeta core.hooksPath y worktrees). */
export async function hooksDir(root: string): Promise<string | undefined> {
  const r = await runGit(root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
  if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
  // git < 2.31 no soporta --path-format: la ruta viene relativa a root
  const legacy = await runGit(root, ['rev-parse', '--git-path', 'hooks']);
  if (legacy.code !== 0 || !legacy.stdout.trim()) return undefined;
  const p = legacy.stdout.trim();
  return /^([a-zA-Z]:)?[\\/]/.test(p) ? p : `${root.replace(/[\\/]+$/, '')}/${p}`;
}

export async function remoteUrl(root: string, remote = 'origin'): Promise<string | undefined> {
  const r = await runGit(root, ['remote', 'get-url', remote]);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
}

// ───────────────────────── parsing helpers (puros) ─────────────────────────

/** Quita credenciales de una URL remota (https://user:token@host → https://host). */
export function sanitizeRemoteUrl(url: string): string {
  const u = url.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    try {
      const parsed = new URL(u);
      // en ssh:// el usuario ("git") no es secreto; en http(s) cualquier userinfo puede ser un token
      if (parsed.protocol.startsWith('http')) parsed.username = '';
      parsed.password = '';
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString().replace(/\/$/, '');
    } catch {
      return u.replace(/\/\/[^@/]*@/, '//');
    }
  }
  return u; // scp-like: git@github.com:org/repo.git (sin secreto)
}

/** "org/repo" a partir de la URL remota (GitHub, Bitbucket, GitLab, ssh o https). */
export function repoSlugFromRemote(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const u = url.trim();
  let path: string | undefined;
  const scp = /^[^@/\s]+@[^:/\s]+:(.+)$/.exec(u);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) path = scp[1];
  else {
    try {
      path = new URL(u).pathname;
    } catch {
      return undefined;
    }
  }
  const segs = path!
    .replace(/\.git\/?$/, '')
    .split('/')
    .filter(Boolean);
  if (segs.length < 2) return undefined;
  return `${segs[segs.length - 2]}/${segs[segs.length - 1]}`;
}

export interface CommitHeader {
  sha: string;
  parents: string[];
  committedAt: string;
  message: string;
}

/** Formato para `git log -1 --format=...`; separadores NUL para que el mensaje no rompa el parsing. */
export const COMMIT_HEADER_FORMAT = '%H%x00%P%x00%cI%x00%B';

export function parseCommitHeader(out: string): CommitHeader | undefined {
  const parts = out.split('\0');
  if (parts.length < 4) return undefined;
  const sha = parts[0]!.trim();
  if (!/^[0-9a-f]{7,64}$/.test(sha)) return undefined;
  return {
    sha,
    parents: parts[1]!.trim().split(/\s+/).filter(Boolean),
    committedAt: parts[2]!.trim(),
    message: parts.slice(3).join('\0').replace(/\s+$/, ''),
  };
}

export const SESSION_TRAILER = 'MagiCode-Session';
export const TASK_TRAILER = 'MagiCode-Task';

/** Valores del trailer `MagiCode-Session:` en un mensaje de commit. */
export function sessionTrailers(message: string): string[] {
  const out: string[] = [];
  for (const m of message.matchAll(/^MagiCode-Session:\s*(\S+)\s*$/gim)) out.push(m[1]!);
  return out;
}

export function hasSessionTrailer(message: string, sessionId: string): boolean {
  return sessionTrailers(message).includes(sessionId);
}

/** Claves de tarea del commit: trailer MagiCode-Task y claves en el mensaje. */
export function commitTaskKeys(message: string): string[] {
  return extractTaskKeys(message);
}

/** Salida de `git ls-files -z`. */
export function parseNulList(out: string): string[] {
  return out.split('\0').filter((s) => s.length > 0);
}

/** Heurística de binario: byte NUL en los primeros 8000 bytes. */
export function isProbablyBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescriptreact',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascriptreact',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  java: 'java',
  kt: 'kotlin',
  go: 'go',
  rs: 'rust',
  rb: 'ruby',
  php: 'php',
  cs: 'csharp',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  swift: 'swift',
  scala: 'scala',
  sh: 'shellscript',
  bash: 'shellscript',
  json: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  html: 'html',
  css: 'css',
  scss: 'scss',
  sql: 'sql',
  tf: 'terraform',
  vue: 'vue',
  svelte: 'svelte',
};

export function languageFromPath(path: string): string | undefined {
  const base = path.split('/').pop() ?? path;
  if (/^Dockerfile/i.test(base)) return 'dockerfile';
  const ext = base.includes('.') ? base.split('.').pop()!.toLowerCase() : '';
  return LANG_BY_EXT[ext];
}

/** Normaliza una ruta a separadores POSIX y relativa al repo. */
export function toRepoPath(root: string, absPath: string): string | undefined {
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const p = absPath.replace(/\\/g, '/');
  if (p === r) return undefined;
  const prefix = `${r}/`;
  const cmp = process.platform === 'win32' || process.platform === 'darwin';
  const starts = cmp ? p.toLowerCase().startsWith(prefix.toLowerCase()) : p.startsWith(prefix);
  return starts ? p.slice(prefix.length) : undefined;
}

/** Tag por defecto: magicode-demo-YYYYMMDD-HHmm. */
export function defaultReferenceTag(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `magicode-demo-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Validación mínima de nombre de tag (subset seguro de git check-ref-format). */
export function isValidTagName(tag: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(tag) && !tag.includes('..') && !tag.endsWith('.lock') && !tag.endsWith('/') && !tag.endsWith('.');
}
