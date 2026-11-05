# Case studies: the read-then-write race in 30 real public Supabase apps

Every number here is **measured** unless it is marked **hypothesis**. Repos are anonymised as repo-NN. No repo, owner,
file path or code excerpt is given, and no maintainer has been contacted.

## How the sample was picked

The rule was fixed and committed before any repo was run:

1. GitHub code search for supabase-js calls that update a `credits`, `balance` or `stock` column (TypeScript and
   JavaScript, forks excluded).
2. Keep only repos with at least one `supabase/migrations/*.sql` file, so the schema can be rebuilt from the repo itself.
3. Shuffle with a fixed seed. Walk the list in order and count a repo only if its code really reads the value, computes
   the new value in JavaScript and writes it back, with no RPC, version column or `.eq(column, oldValue)` guard.
4. For each counted repo, apply its own migrations to a throwaway local Postgres + PostgREST, seed the minimum rows, and
   replay the same read-compute-write through the Data API: 100 concurrent requests, 3 runs. The check is the final
   value in the database against the value the requests should have produced.

49 repos had to be counted to reach 30 runnable ones. The others mostly create the race column outside their migrations
folder (in the dashboard), so their schema cannot be rebuilt from the repo.

## Results

| Count | Reproduced | 95% Wilson interval |
|---|---|---|
| Every migration file applied cleanly, race reproduced | 14 / 30 | 30% - 64% |
| Race table and column built by the repo's own migrations, race reproduced | 30 / 30 | 89% - 100% |
| Same two counts, one repo per shared template or owner | 12 / 26 and 26 / 26 | 29% - 65% and 87% - 100% |

- All 90 runs returned **100 successful responses and zero errors**, and lost **94 to 99 of 100** updates.
- Columns: credits 15, balance 8, stock 7. Direction: 20 deduct (spend, redeem, sell), 10 add (top-up, reward, restock).
- 4 of the 30 clamp at zero in JavaScript (`Math.max(0, ...)`). That stops a negative value; it does not stop a lost
  update.
- Where a repo's other migration files failed on a fresh database, those files were searched for a trigger, policy,
  check or row lock that could have prevented the lost update on the replayed path. None was found. Two repos have a
  correct atomic function elsewhere (a row-locking transfer function, an atomic increment RPC) that the replayed code
  path does not call.

## Three patterns, paraphrased

**Spend credits before a paid action (most common).** Read the user's credits, check `credits >= cost`, run the action,
write `credits - cost`. A burst of 100 requests against 50 credits: all 100 pass the check, and the final value reflects
only a handful of the deductions.

**Sell or reserve stock.** Read `stock`, write `stock - quantity`. The order rows are all created, the stock count drops
by a few units. Overselling happens with no error anywhere.

**Top-up or reward.** Read `balance`, write `balance + amount`. Concurrent top-ups overwrite each other, so money a user
paid for disappears from the balance.

## The fix in each case

Move the arithmetic into one SQL statement so the database does the read and the write together, for example a
function called through `.rpc()`:

```sql
update profiles set credits = credits - $cost
where id = auth.uid() and credits >= $cost
returning credits;
```

No row returned means not enough credits. SupaRace's spend and claim scenarios measure this fix at 0 violations
(see the README).

## What this does not show

- **Hypothesis, not measured:** how often this happens under real traffic. A 100-wide burst from one host is a stress
  shape; real loss rates depend on how often two requests for the same row overlap, and are probably much lower.
- It does not show that these apps have users or that anyone has lost money.
- It does not measure whether developers would adopt a tool for this.
