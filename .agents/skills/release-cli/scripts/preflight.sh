#!/usr/bin/env bash
# Release pre-flight gates for the ytstats CLI.
#
# Usage:  bash preflight.sh [full|ledger]
#
#   full    Modes A/B — all three gates are hard. Default.
#   ledger  Mode C    — clean-tree gate relaxed; only CHANGELOG.md conflict is checked.
#
# Exits 0 when every applicable gate passes, non-zero on the first hard failure.
# Run from the project root.

set -uo pipefail

MODE="${1:-full}"

case "$MODE" in
  full|ledger) ;;
  *) printf 'preflight: unknown mode %s (expected full or ledger)\n' "$MODE" >&2; exit 64 ;;
esac

fail() { printf '\nFAIL  %s\n' "$1" >&2; exit 1; }
pass() { printf 'PASS  %s\n' "$1"; }

# --- environment ------------------------------------------------------------

command -v git >/dev/null 2>&1 || fail "git is not installed."
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "Not inside a git repository."

[ -f package.json ] || fail "No package.json here. Run this from the project root."
[ -f CHANGELOG.md ] || fail "No CHANGELOG.md here. Run this from the project root."

VERSION="$(node -p "require('./package.json').version" 2>/dev/null)" \
  || fail "Could not read the version from package.json (is node installed?)."
printf 'Current version: %s\n\n' "$VERSION"

# --- gate 1: clean working directory ---------------------------------------

DIRTY="$(git status --porcelain)"

if [ "$MODE" = "full" ]; then
  if [ -n "$DIRTY" ]; then
    printf 'FAIL  Working directory is not clean.\n\n' >&2
    printf '%s\n\n' "$DIRTY" >&2
    cat >&2 <<'EOF'
The release commits only package.json and CHANGELOG.md. It does NOT commit
your feature or fix code, so releasing now would produce a tag whose commit
does not contain the changes it ships.

Commit your changes first, then re-run the release.
EOF
    exit 1
  fi
  pass "Working directory is clean."
else
  # Mode C: uncommitted work is expected. Only an unstaged CHANGELOG.md is a problem,
  # since the ledger append would collide with it.
  if printf '%s\n' "$DIRTY" | grep -qE '^( M|\?\?| D) CHANGELOG\.md$'; then
    fail "CHANGELOG.md has uncommitted changes that the ledger append would collide with. Commit or stash it first."
  fi
  pass "CHANGELOG.md is safe to amend."
  if [ -n "$DIRTY" ]; then
    printf 'NOTE  Uncommitted work present (expected in ledger mode).\n'
    printf '      Consider committing the code first — a ledger entry for uncommitted code is misleading.\n'
  fi
fi

# --- gate 2: test suite (full mode only) ------------------------------------

if [ "$MODE" = "full" ]; then
  printf '\nRunning npm test ...\n'
  if npm test --silent >/tmp/ytstats-preflight-test.log 2>&1; then
    SUMMARY="$(grep -Eo 'Tests +[0-9]+ passed \([0-9]+\)' /tmp/ytstats-preflight-test.log | tail -1)"
    pass "npm test passed. ${SUMMARY:-all tests green}"
  else
    printf '\nFAIL  npm test failed. Last 30 lines:\n\n' >&2
    tail -30 /tmp/ytstats-preflight-test.log >&2
    printf '\nFull log: /tmp/ytstats-preflight-test.log\n' >&2
    exit 1
  fi
fi

# --- gate 3: [Unreleased] is non-empty (full mode only) ---------------------

if [ "$MODE" = "full" ]; then
  # Everything between the [Unreleased] heading and the next ## heading.
  UNRELEASED="$(awk '
    /^## \[Unreleased\]/ { capture = 1; next }
    /^## / { capture = 0 }
    capture { print }
  ' CHANGELOG.md | tr -d '[:space:]')"

  if [ -z "$UNRELEASED" ]; then
    cat >&2 <<'EOF'

FAIL  The [Unreleased] section of CHANGELOG.md is empty.

There is nothing recorded to ship. Either record what changed first
(run this skill with the `unreleased` action), or pass a note describing
the release so the changelog entry can be written.
EOF
    exit 1
  fi
  pass "[Unreleased] has content."
fi

# --- context ----------------------------------------------------------------

printf '\n--- context ---\n'

LAST_TAG="$(git tag -l 'v*' --sort=-v:refname | head -1)"
if [ -n "$LAST_TAG" ]; then
  printf 'Last release tag: %s\n' "$LAST_TAG"
  printf 'Commits since:    %s\n' "$(git rev-list --count "${LAST_TAG}..HEAD")"
else
  printf 'Last release tag: none — diff across all history\n'
  printf 'Commits total:    %s\n' "$(git rev-list --count HEAD)"
fi

if [ -z "$(git remote)" ]; then
  printf 'Remote:           none configured — push would fail\n'
else
  printf 'Remote:           %s\n' "$(git remote | tr '\n' ' ')"
fi

printf '\nAll applicable gates passed.\n'
