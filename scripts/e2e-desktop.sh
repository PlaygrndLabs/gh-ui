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
# After merging the remote's trunk in: synced tracks lab/synced, which a later step adds as a remote, and trunk's
# commit goes up with the push although lab already has it. Refs for a remote not added yet change nothing before then.
L="$WORK/e2e-local"
git -C "$L" switch -q -c trunk
git -C "$L" commit -q --allow-empty -m "From trunk"
git -C "$L" update-ref refs/remotes/lab/trunk HEAD
git -C "$L" switch -q -c synced main
git -C "$L" commit -q --allow-empty -m "Synced work"
git -C "$L" update-ref refs/remotes/lab/synced HEAD
git -C "$L" config branch.synced.remote lab
git -C "$L" config branch.synced.merge refs/heads/synced
git -C "$L" merge -q --no-ff --no-edit trunk
git -C "$L" switch -q main
git -C "$L" branch -q -D trunk
# A worktree whose folder has gone, as one made from a VM looks from the host.
git -C "$WORK/e2e-local" worktree add -q -b stranded "$WORK/stranded"
rm -rf "$WORK/stranded"

# A repository for the merge scenarios: feature, conflict and rebase-base each branch off the first commit.
M="$WORK/e2e-merge"
mkdir -p "$M"
git -C "$M" init -q -b main
git -C "$M" config user.name "gh-ui e2e"
git -C "$M" config user.email "e2e@example.invalid"
commit_file() { echo "$2" > "$M/$1"; git -C "$M" add -- "$1"; git -C "$M" commit -q -m "$3"; }
commit_file shared.txt base "First"
git -C "$M" branch conflict
git -C "$M" branch rebase-base
git -C "$M" branch feature
commit_file main.txt main "Add main"
git -C "$M" switch -q conflict; commit_file shared.txt theirs "Theirs"
git -C "$M" switch -q rebase-base; commit_file other.txt other "Add other"
# For Reorder Commit: origin has reorder-demo up to "Reorder base", and the commits after it are still to push.
git -C "$M" switch -q -c reorder-demo conflict~1; commit_file reorder-base.txt base "Reorder base"
git -C "$M" update-ref refs/remotes/origin/reorder-demo HEAD
commit_file r1.txt one "Reorder one"; commit_file r2.txt two "Reorder two"; commit_file r3.txt three "Reorder three"
git -C "$M" switch -q -c reorder-clash reorder-demo~3; commit_file same.txt one "Clash one"; commit_file same.txt two "Clash two"
git -C "$M" switch -q feature; commit_file shared.txt ours "Ours"

GH_UI_USER_DATA="$WORK/profile" \
E2E_MERGE_REPO="$M" \
E2E_LOCAL_REPO="$WORK/e2e-local" \
E2E_CLONE_PARENT="$WORK/clones" \
GH_UI_E2E=e2e/desktop.e2e.cjs \
  ./node_modules/.bin/electron . 2>/dev/null | sed -n '/^{/,$p' > "$WORK/report.json"
cat "$WORK/report.json"
# Electron's own exit status is lost in the pipe, so judge the run by its report.
grep -q '"ok": true' "$WORK/report.json" && ! grep -q '"ok": false' "$WORK/report.json"
