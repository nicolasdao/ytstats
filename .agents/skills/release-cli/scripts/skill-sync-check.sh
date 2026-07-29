#!/usr/bin/env bash
# Check that the ytstats agent skill covers the CLI's current surface.
#
# The skill (.agents/skills/ytstats/) pilots the CLI on a user's behalf, so it is
# a second consumer of the same contracts as docs/ — commands, flags, diagnostic
# codes, env vars. Nothing else detects drift between them: doc-manifest.json's
# --affects map covers README.md and docs/** only, so a CLI change updates the
# docs and silently leaves the skill describing the old behaviour. That is worse
# than a stale doc, because an agent acts on it.
#
# This is a coverage check, not a correctness check. It proves each identifier is
# mentioned somewhere in the skill; it cannot tell whether what the skill says
# about it is still true. Treat a clean run as "nothing obviously missing", and
# still read the diff for behaviour changes.
#
# Exit 0 always — this warns, it never blocks a release. Only a human knows
# whether a given change is observable to a caller or purely internal.

set -uo pipefail

ROOT="${1:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
SKILL="$ROOT/.agents/skills/ytstats"
SRC="$ROOT/src"

if [ ! -d "$SKILL" ]; then
  echo "SKIP  No agent skill at .agents/skills/ytstats — nothing to check."
  exit 0
fi

missing=0

check() {
  local label="$1" value="$2"
  if ! grep -qr -- "$value" "$SKILL" 2>/dev/null; then
    echo "  MISSING  $label: $value"
    missing=$((missing + 1))
  fi
}

echo "Checking agent skill coverage of the CLI surface..."

# Commands — both .command('x') and the simple('x') helper define them.
commands=$(
  { grep -ohE "\.command\('[a-z-]+" "$SRC/cli.js" | sed "s/.*command('//"
    grep -ohE "simple\('[a-z-]+"    "$SRC/cli.js" | sed "s/simple('//"
  } | sort -u
)
for c in $commands; do check "command" "$c"; done

# Diagnostic codes — public API, callers branch on these.
codes=$(grep -ohE "code: '[A-Z_]+'" "$SRC/diagnostics.js" | sed "s/code: '//;s/'//" | sort -u)
for c in $codes; do check "diagnostic" "$c"; done

# Environment variables the CLI reads.
envs=$(grep -rhoE "YTSTATS_[A-Z_]+|XDG_CONFIG_HOME|HTTPS_PROXY" "$SRC" | sort -u)
for e in $envs; do check "env var" "$e"; done

n_cmd=$(echo "$commands" | grep -c .)
n_code=$(echo "$codes" | grep -c .)
n_env=$(echo "$envs" | grep -c .)

echo
if [ "$missing" -eq 0 ]; then
  echo "PASS  Skill mentions all $n_cmd commands, $n_code diagnostics, $n_env env vars."
  echo "      Coverage only — still check the diff for changed behaviour:"
  echo "        - a diagnostic whose recoverable/retryable flipped"
  echo "        - a command whose data shape changed"
  echo "        - a flag default that moved"
  echo "      Any of those needs a skill edit and a systemDependencies.ytstats.version bump."
else
  echo "WARN  $missing identifier(s) absent from the skill (see above)."
  echo "      Add them to .agents/skills/ytstats/references/, then bump the skill"
  echo "      version and republish. This does not block the release."
fi

exit 0
