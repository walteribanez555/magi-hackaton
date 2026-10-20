/**
 * Hook `prepare-commit-msg` que agrega los trailers `MagiCode-Session: <id>` y `MagiCode-Task: <KEY>`.
 * Lee la sesión activa de `<git-dir>/magicode-session` (línea 1: session id, línea 2: task key opcional),
 * archivo que la extensión escribe al iniciar sesión y borra al terminarla.
 * Puro: no importa 'vscode'.
 */
import { promises as fs } from 'node:fs';
import * as nodePath from 'node:path';

export const HOOK_MARKER = '# magicode-prepare-commit-msg v1';
export const SESSION_FILE = 'magicode-session';

export function hookScript(): string {
  return `#!/bin/sh
${HOOK_MARKER} — instalado por la extensión MagiCode.
# Agrega trailers de sesión/tarea si hay una sesión MagiCode activa. No envía nada a ningún lado.
MSG_FILE="$1"
[ -n "$MSG_FILE" ] && [ -f "$MSG_FILE" ] || exit 0
GIT_DIR="$(git rev-parse --git-dir 2>/dev/null)" || exit 0
SESSION_FILE="$GIT_DIR/${SESSION_FILE}"
[ -f "$SESSION_FILE" ] || exit 0
SID="$(sed -n '1p' "$SESSION_FILE" | tr -d '\\r\\n ')"
TASK="$(sed -n '2p' "$SESSION_FILE" | tr -d '\\r\\n ')"
[ -n "$SID" ] || exit 0
if ! grep -qi '^MagiCode-Session:' "$MSG_FILE"; then
  git interpret-trailers --in-place --trailer "MagiCode-Session: $SID" "$MSG_FILE" || exit 0
fi
if [ -n "$TASK" ] && ! grep -qi '^MagiCode-Task:' "$MSG_FILE"; then
  git interpret-trailers --in-place --trailer "MagiCode-Task: $TASK" "$MSG_FILE" || exit 0
fi
exit 0
`;
}

export function sessionFileContent(sessionId: string, taskKey?: string): string {
  return `${sessionId}\n${taskKey ?? ''}\n`;
}

export async function writeSessionFile(gitDir: string, sessionId: string, taskKey?: string): Promise<void> {
  await fs.writeFile(nodePath.join(gitDir, SESSION_FILE), sessionFileContent(sessionId, taskKey), 'utf8');
}

export async function removeSessionFile(gitDir: string): Promise<void> {
  await fs.rm(nodePath.join(gitDir, SESSION_FILE), { force: true });
}

export type HookStatus = 'absent' | 'magicode' | 'foreign';

export async function hookStatus(hooksDir: string): Promise<HookStatus> {
  try {
    const content = await fs.readFile(nodePath.join(hooksDir, 'prepare-commit-msg'), 'utf8');
    return content.includes(HOOK_MARKER) ? 'magicode' : 'foreign';
  } catch {
    return 'absent';
  }
}

/** Escribe el hook (ejecutable). Si había uno ajeno y `backup`, lo renombra a `.magicode-backup`. */
export async function installHook(hooksDir: string, opts: { backup?: boolean } = {}): Promise<string> {
  await fs.mkdir(hooksDir, { recursive: true });
  const target = nodePath.join(hooksDir, 'prepare-commit-msg');
  if (opts.backup) {
    try {
      await fs.copyFile(target, `${target}.magicode-backup`);
    } catch {
      /* no había hook */
    }
  }
  await fs.writeFile(target, hookScript(), { encoding: 'utf8', mode: 0o755 });
  await fs.chmod(target, 0o755);
  return target;
}
