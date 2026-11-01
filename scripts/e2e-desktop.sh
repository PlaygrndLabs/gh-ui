#!/bin/sh
# Runs the desktop end-to-end scenario (e2e/desktop.e2e.cjs) against a fresh,
# throwaway profile and fixture repo. Needs a built dist/ (npm run build) and a
# signed-in `gh` CLI; clones the public tmux wiki from GitHub.
set -e
cd "$(dirname "$0")/.."
# Resolve symlinks (macOS's /var -> /private/var): repos are stored by git's resolved toplevel.
WORK=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/gh-ui-e2e.XXXXXX")" && pwd -P)
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/e2e-local" "$WORK/clones"
git -C "$WORK/e2e-local" init -q -b main
git -C "$WORK/e2e-local" -c user.name=e2e -c user.email=e2e@example.invalid commit -q --allow-empty -m "Initial commit"
git -C "$WORK/e2e-local" config user.name "gh-ui e2e"
git -C "$WORK/e2e-local" config user.email "e2e@example.invalid"
echo "# Notes" > "$WORK/e2e-local/notes.md"
echo "hello from scratch" > "$WORK/e2e-local/scratch.txt"

GH_UI_USER_DATA="$WORK/profile" \
E2E_LOCAL_REPO="$WORK/e2e-local" \
E2E_CLONE_PARENT="$WORK/clones" \
GH_UI_E2E=e2e/desktop.e2e.cjs \
  ./node_modules/.bin/electron . 2>/dev/null | sed -n '/^{/,$p'
