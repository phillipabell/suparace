#!/usr/bin/env bash
# Turn `supabase status -o env` output into the variables the SupaRace CLI reads, one NAME=value per line
# (for $GITHUB_ENV). Handles both key naming schemes of the Supabase CLI (SERVICE_ROLE_KEY/ANON_KEY and the newer
# SECRET_KEY/PUBLISHABLE_KEY). The caller masks the keys (workflow commands must go to stdout, and this stdout
# is a data file). Usage: stack-env.sh <status.env>
set -euo pipefail
declare -A v
while IFS= read -r line; do
  [[ $line =~ ^([A-Z_]+)=\"?([^\"]*)\"?$ ]] || continue
  v[${BASH_REMATCH[1]}]=${BASH_REMATCH[2]}
done < "$1"
url=${v[API_URL]:-}
key=${v[SERVICE_ROLE_KEY]:-${v[SECRET_KEY]:-}}
anon=${v[ANON_KEY]:-${v[PUBLISHABLE_KEY]:-}}
db=${v[DB_URL]:-}
if [ -z "$url" ] || [ -z "$key" ]; then echo "stack-env: no API_URL / service key in $1" >&2; exit 2; fi
echo "SUPABASE_URL=$url"
echo "SUPABASE_SERVICE_ROLE_KEY=$key"
[ -n "$anon" ] && echo "SUPABASE_ANON_KEY=$anon"
[ -n "$db" ] && echo "SUPARACE_DB_URL=$db"
exit 0
