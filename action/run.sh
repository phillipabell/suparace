#!/usr/bin/env bash
# Run step of the SupaRace action: build the CLI argument list from the inputs, run it, write the job summary,
# and exit with the CLI's code (0 all races matched expect, 1 a race failed, 2 bad config).
set -uo pipefail
args=(run)
read -r -a files <<< "${RACES:-suparace}"
args+=("${files[@]}")
[ -n "${RACE:-}" ] && args+=(--race "$RACE")
[ -n "${N:-}" ] && args+=(--n "$N")
[ -n "${RUNS:-}" ] && args+=(--runs "$RUNS")
[ -n "${MODE:-}" ] && args+=(--mode "$MODE")
[ -n "${SCORE:-}" ] && args+=(--score "$SCORE")
REPORT=${REPORT:-suparace-report.json}
args+=(--out "$REPORT")
rm -f "$REPORT"
if [ "${CLI:-action}" = npm ]; then
  npx --yes "suparace@${VERSION:-latest}" "${args[@]}"
else
  node "${ACTION_PATH:?}/src/bin.ts" "${args[@]}"
fi
code=$?
node "${ACTION_PATH:-$(dirname "$0")/..}/action/summary.mjs" "$REPORT" "$code" >> "${GITHUB_STEP_SUMMARY:-/dev/stdout}" || true
pass=false; [ "$code" = 0 ] && pass=true
[ -n "${GITHUB_OUTPUT:-}" ] && echo "pass=$pass" >> "$GITHUB_OUTPUT"
[ "$code" = 1 ] && echo "::error::SupaRace: a race broke an invariant (see the job summary)"
exit "$code"
