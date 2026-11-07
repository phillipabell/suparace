# Your supabase-js tests pass and the balance is still wrong

supabase-js has no client-side transactions. Code that reads a row, decides in JavaScript, then writes it back
(spend a credit, sell a unit of stock, add a top-up) loses updates when requests overlap. Every request returns 2xx, so
ordinary tests stay green.

## What we measured

All numbers are measured, with the setup stated. Hypotheses are marked.

- **The bug, in a 50-client burst** (local self-hosted Supabase): a wallet holds 25 credits and 50 clients each spend 1.
  The read-then-write version approved all 50 spends in 3 of 3 runs. A one-statement SQL function called with `.rpc()`
  approved exactly 25 in 3 of 3 runs.
- **How common it is in public code** (see [case-studies.md](case-studies.md)): from a sample picked by a rule fixed
  before any repo was run, 30 public apps had a read-compute-write on a credits, balance or stock column. Replaying that
  code against each repo's own migrations, 100 concurrent requests, 3 runs each: the race reproduced in 30 of 30 (14 of
  30 when every migration file also had to apply cleanly). Every run returned 100 successes and no errors, and lost 94
  to 99 of 100 updates.
- **The fix**: do the arithmetic in the database.

```sql
update profiles set credits = credits - $cost
where id = auth.uid() and credits >= $cost
returning credits;
```

  No row returned means not enough credits. In SupaRace's spend and claim scenarios this measured 0 violations.

## What this does not show

- **Hypothesis, not measured:** how often it happens under real traffic. A 100-wide burst from one host is a stress
  shape, and real loss rates are probably much lower.
- It does not show that any of these apps has users, or that anyone lost money.
- It does not show that developers want a tool for this. That is what we are trying to find out.

## Try it on your own project

```sh
npm install --save-dev github:phillipabell/suparace
npx suparace init                       # writes suparace/quickstart.sql, run it in your project
npx suparace run --race spend:naive     # FAIL, exit 1
npx suparace run --race spend:atomic    # PASS, exit 0
```

Needs Node 22+ and a Supabase project you are allowed to break (a new Free project or a local stack). The quickstart
creates only `suparace_`-prefixed objects. Full instructions and every measurement: the [README](../README.md).

Not affiliated with or endorsed by Supabase. SupaRace is early (v0.3), not yet on npm, and feedback or a failing case is
welcome as a GitHub issue.
