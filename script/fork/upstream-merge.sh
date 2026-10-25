#!/usr/bin/env bash
# Merges upstream OpenCode 1 (anomalyco/opencode, branch v1) into the current branch, then runs this
# fork's checks in the resource-limited Docker dev stack. Needs only git and Docker on the host.
# Upstream's dev branch is OpenCode 2, a separate product this fork doesn't follow (FORK.md).
#
#   script/fork/upstream-merge.sh          fetch, merge, then check
#   script/fork/upstream-merge.sh --check  only check (after resolving conflicts and committing)
#
# See FORK.md for the layout rules and the list of upstream files the fork edits.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"
compose=(docker compose -f docker/dev/compose.yaml)
upstream_url="https://github.com/anomalyco/opencode.git"
upstream_branch=v1
# Paths only this fork writes; everything else is upstream's.
fork_only='^(docker/|script/fork/|CLAUDE\.md|FORK\.md)|/src/(merge|operator)/|/test/(merge|operator)/|/test/fixtures/merge/|test/lib/fake-claude\.ts|merge-claude-spike\.ts|schema/src/session-merge\.ts|v1/config/(fork|merge)\.ts|session_merge_binding\.ts|merge-indicator\.|merge-summary\.tsx|styles/skins/|themes/iphi\.json|theme/iphi\.test\.ts|assets/iphi\.json|public/assets/fonts/|e2e/operator/|theme-iphi\.spec\.ts|httpapi-exercise/operator\.ts|^packages/sdk/|^packages/client/src/generated|\.gen\.ts$|core/schema\.json$'

if ! git remote get-url upstream >/dev/null 2>&1; then
  git remote add upstream "$upstream_url"
  # Fetch only: this fork never pushes to upstream.
  git remote set-url --push upstream no-push
fi

if [[ "${1:-}" != "--check" ]]; then
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "Commit or stash your changes before merging upstream." >&2
    exit 1
  fi
  git fetch upstream "$upstream_branch"
  if ! git merge --no-edit "upstream/$upstream_branch"; then
    echo >&2
    echo "Merge stopped on conflicts. Resolve them (FORK.md lists the fork's edits), commit, then run:" >&2
    echo "  script/fork/upstream-merge.sh --check" >&2
    exit 1
  fi
fi

# The image's Bun must be the one upstream pins (packageManager), or the checks run on another Bun.
want_bun="$(sed -n 's/.*"packageManager": "bun@\([^"]*\)".*/\1/p' package.json)"
image_bun="$(sed -n 's/^ARG BUN_VERSION=//p' docker/dev/Dockerfile)"
if [[ "$want_bun" != "$image_bun" ]]; then
  echo "package.json pins Bun $want_bun, docker/dev/Dockerfile installs $image_bun: set BUN_VERSION to $want_bun." >&2
  exit 1
fi

echo "== Building the dev image"
"${compose[@]}" build tools

echo "== Regenerating the SDKs and checking migrations"
"${compose[@]}" run --rm -T tools bash -c '
  set -e
  ./script/generate.ts >/dev/null
  (cd packages/client && bun run generate >/dev/null)
  (cd packages/core && bun run migration --check >&2)
  tar -cf - packages/sdk/openapi.json packages/sdk/js/src packages/client/src/generated packages/client/src/generated-effect
' | tar -xf - -C "$root"
"${compose[@]}" build tools

# Each step runs in its own container with a time limit, so a hung step fails instead of stalling.
step() {
  echo "-- $1"
  "${compose[@]}" run --rm -T tools timeout "$2" bash -c "$3"
}

# The HttpApi gate can hang on an upstream race (FORK.md, "Upstream's worktree race"): when it hits
# its time limit, it runs once more, and says so. Any other failure fails the check.
step_retry() {
  echo "-- $1"
  local status=0
  "${compose[@]}" run --rm -T tools timeout "$2" bash -c "$3" || status=$?
  if [[ $status == 124 ]]; then
    echo "   timed out after $2s (upstream's worktree race, see FORK.md); running it once more"
    "${compose[@]}" run --rm -T tools timeout "$2" bash -c "$3"
  elif [[ $status != 0 ]]; then
    return "$status"
  fi
}

echo "== Typechecking and testing"
for pkg in schema core opencode app session-ui ui tui; do
  step "typecheck $pkg" 600 "cd packages/$pkg && bun typecheck"
done
step "merge and operator tests" 900 "cd packages/opencode && bun run test test/merge test/operator"
step_retry "HttpApi coverage gate" 600 "cd packages/opencode && bun run test:httpapi"
step "app unit tests" 600 "cd packages/app && bun run test:unit"

echo "== Upstream files the fork edits that FORK.md does not mention"
missing=0
while read -r file; do
  if ! grep -qF "$(basename "$file")" FORK.md; then
    echo "  $file"
    missing=1
  fi
done < <(git diff --name-only "$(git merge-base HEAD "upstream/$upstream_branch" 2>/dev/null || git merge-base HEAD dev)" HEAD | grep -vE "$fork_only" || true)
[[ $missing == 0 ]] && echo "  none"

if ! git diff --quiet; then
  echo
  echo "Generated files changed; review and commit them:"
  git status --short
fi
echo
echo "Next: docker compose -f docker/dev/compose.yaml run --rm e2e npx playwright test e2e/operator e2e/regression e2e/smoke"
