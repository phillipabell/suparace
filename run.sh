#!/bin/bash
# Runs the race harness. Set the target and keys in your environment (never commit them):
#   export SUPARACE_URL=http://127.0.0.1:8000        # your Supabase API URL (self-hosted default shown)
#   export SUPARACE_KEY=<service_role key>
#   export SUPARACE_ANON_KEY=<anon key>              # only needed for the RLS matrix
# SUPARACE_SCRIPT=src/rls.ts ./run.sh 100  runs the RLS matrix instead of the default races.
cd "$(dirname "$0")"
: "${SUPARACE_KEY:?set SUPARACE_KEY (service_role key)}"
export SUPARACE_URL=${SUPARACE_URL:-http://127.0.0.1:8000}
exec node "${SUPARACE_SCRIPT:-src/race.ts}" "$@"
