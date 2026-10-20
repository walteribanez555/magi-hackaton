#!/usr/bin/env bash
# Crea el repo de demo de MagiCode como un repositorio Git REAL e independiente del monorepo.
#
#   scripts/init-demo-repo.sh [destino] [--branch feature/MAG-1-demo] [--remote <url>]
#
# destino por defecto: ~/magicode-demo
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/../examples/demo-repo"
TARGET="${HOME}/magicode-demo"
BRANCH="main"
REMOTE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --branch) BRANCH="$2"; shift 2 ;;
    --remote) REMOTE="$2"; shift 2 ;;
    -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
    *) TARGET="$1"; shift ;;
  esac
done

if [ ! -d "$SRC" ]; then
  echo "No encuentro la semilla en $SRC" >&2
  exit 1
fi
if [ -e "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ]; then
  echo "El destino $TARGET ya existe y no está vacío. Bórralo o elige otro." >&2
  exit 1
fi

mkdir -p "$TARGET"
# copia la semilla (incluye dotfiles) sin node_modules
( cd "$SRC" && COPYFILE_DISABLE=1 tar --exclude node_modules -cf - . ) | ( cd "$TARGET" && tar -xf - )

cd "$TARGET"
git init -q
git checkout -q -b "$BRANCH" 2>/dev/null || git symbolic-ref HEAD "refs/heads/$BRANCH"
git add -A
git -c user.name="${GIT_AUTHOR_NAME:-$(git config user.name || echo 'MagiCode Demo')}" \
    -c user.email="${GIT_AUTHOR_EMAIL:-$(git config user.email || echo 'demo@magicode.local')}" \
    commit -q -m "chore: app semilla para la demo de MagiCode"

if [ -n "$REMOTE" ]; then
  git remote add origin "$REMOTE"
  echo "Remoto origin → $REMOTE (publica con: git push -u origin $BRANCH)"
fi

echo "Repo de demo listo en $TARGET"
echo "  rama:   $(git rev-parse --abbrev-ref HEAD)"
echo "  commit: $(git rev-parse HEAD)"
echo
echo "Siguiente: abre la carpeta en VS Code con la extensión MagiCode (F5 en apps/extension)."
