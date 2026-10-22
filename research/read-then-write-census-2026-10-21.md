# Read-then-write census: supabase-js on balance/stock columns (2026-10-21)

Read-only GitHub code search (`gh api search/code`, legacy code-search API, default branches, forks excluded).

**Pattern looked for:** `.from(t).select(col)` read into JS, new value computed in JS, then `.from(t).update({ col: newValue })`, with no RPC / atomic SQL / version check. Two concurrent requests both read the same old value; one write is lost (double spend, oversell, lost credit).

## 1. Raw counts (GitHub's approximate `total_count`, files not repos)

Note: the legacy code-search API ignores punctuation inside quotes, so `".update({ credits:"` effectively matches "update credits" near each other. Counts are noisy upper bounds.

| # | Query | total_count | unique repos in first 100 hits |
|---|---|---|---|
| 1 | `supabase ".update({ credits:" language:TypeScript` | 1,110 | 86 |
| 2 | `supabase ".update({ credits:" language:JavaScript` | 355 | 75 |
| 3 | `supabase ".update({ balance:" language:TypeScript` | 2,464 | 95 |
| 4 | `supabase ".update({ balance:" language:JavaScript` | 1,232 | 80 |
| 5 | `supabase ".update({ stock:" language:TypeScript` | 1,496 | 92 |
| 6 | `supabase ".update({ stock:" language:JavaScript` | 1,142 | 78 |
| 7 | `supabase ".update({ quantity:" language:TypeScript` | 2,420 | 97 |
| 8 | `supabase ".update({ quantity:" language:JavaScript` | 1,692 | 90 |
| 9 | `supabase ".update({ inventory:" language:TypeScript` | 48 | 34 (of 48) |
| 10 | `supabase ".update({ inventory:" language:JavaScript` | 31 | 26 (of 31) |
| | **Sum** | **11,990 files** | 725 unique repos across the 879 hits fetched |

Cross-query repo overlap was small (725 unique of 879 hits), so roughly 0.8 repos per file hit.

## 2. Hand-classified sample (n = 30, 3 per query, spread across the top 100, one file per repo)

Every sampled file did contain a literal `update({ <col>` call, so precision of the top-ranked hits is high.

| Class | Count | Files |
|---|---|---|
| **True read-then-write race, money / stock** (credits, wallet balance, product stock) | **13** | 1,2,6,7,8,10,11,13,14,16,17,25,29 |
| True race, virtual-goods inventory (game items in JSON column) | 4 | 26,27,28,30 |
| True race, shopping-cart line quantity (low stakes) | 4 | 19,21,23,24 |
| Unclear: race only in a fallback path when an RPC is missing/errors | 2 | 3,18 |
| Unclear: plain setter (`update({ col: arg })`), caller may compute the value elsewhere | 4 | 4,9,12,15 |
| Safe / not the pattern (form setter, no counter semantics, or update via RPC) | 3 | 5,20,22 |

None of the 30 used optimistic concurrency (`.eq(col, oldValue)` guard) on the write.

Strict (money/stock) rate: 13/30 = 43%. Broad (any lost-update counter): 21/30 = 70%.

## 3. Extrapolation (HYPOTHESIS, not measured)

- ~11,990 file hits x ~0.8 repos/file = ~9,600 repos.
- Precision is measured only on top-ranked hits; assume it may fall by up to half deeper in the result list.
- **Strict money/stock races: roughly 2,000 to 4,100 public repos.**
- **Any read-then-write counter race (incl. carts, game inventory): roughly 3,400 to 6,700 public repos.**
- Not covered (would raise the number): other column names (`points`, `coins`, `tokens`, `wallet_balance`, `seats`, `remaining`), Python/Dart clients, Edge Functions with different formatting, private repos.
- Many hits are hobby/demo projects; the count says "this mistake is common", not "this many production systems are exploitable".

## 4. Five anonymized examples (no repo or owner names)

1. **Credit purchase and spend, service-role client** (`utils/supabase/<billing>.ts`): add-credits and deduct-credits helpers each `select("credits")`, compute `client.credits +/- n` in JS, then `update({ credits: newCredits })`. Deduct checks `credits < n` first, so two parallel spends both pass the check: double spend.
2. **Ride-hailing wallet** (`shared/supabase.js`): `debitWallet()` reads the wallet row, checks `balance < amount`, writes `balance - amount`, then inserts a transaction row. Ledger and balance can diverge under concurrency; credit path has the same shape.
3. **Checkout stock decrement in `Promise.all`** (`src/<db>.js`): `decrementStock(items)` maps each cart line to select-stock / `Math.max(0, stock - qty)` / update. `Math.max(0, ...)` hides oversell instead of preventing it; two orders for the last unit both succeed.
4. **Pay-per-call API credits** (`api/<consume>.js`, serverless): `maybeSingle()` read, `if (credits <= 0) 403`, then `update({ credits: credits - 1 })`. A burst of N parallel calls at credits=1 gets N successful responses for one credit. This is the SupaRace naive-burst case exactly.
5. **RPC with a racy fallback** (`lib/supabase.ts`): calls `rpc("deduct_credits")` first, but on any error falls back to select / check / update in JS. The safe path exists, yet any RPC error (missing function, timeout) silently drops back to the race.

## Method notes

- Queries run 2026-10-21 ~03:40 EDT, 7 s apart (code-search limit 10/min).
- Sample: from each query's first 100 hits, every ~16th item, skipping repos already sampled; file fetched via `repos/{o}/{r}/contents/{path}` and the ~18 lines before each `update({ col` call read by hand.
- Raw query JSON and fetched files were scratch-only and not committed (they contain repo names).
