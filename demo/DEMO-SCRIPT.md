# SupaRace: 3-minute demo script and recording plan

Not affiliated with or endorsed by Supabase.

For a short recorded walkthrough. Every number below is copied from `README.md` or `results/` and listed in the
Fact check table at the bottom. Measured numbers are said as fact. The census is an estimate and is said that way.
Free plan only.

## Script (about 3 minutes, about 400 words spoken)

**[0:00-0:20] Problem and framing**

"Honest note first: I have not run Supabase in production. I built this test harness to learn the platform.
supabase-js has no client-side transactions. So app code that reads a balance, checks it in JavaScript, then writes
it back can race when many clients hit it at once. SupaRace measures that."

**[0:20-0:50] Naive burst run fails**

"This is a burst test against self-hosted Supabase: 100 buyers, 50 credits, one try each. The naive code approved
all 100 spends. And the final balance is still about 47, because 97 of those writes were lost updates. Same story
for a job queue: 100 workers each got a job, but only 11 distinct jobs were handed out."

**[0:50-1:15] Response-only scoring misses it**

"Here is why normal tests pass this. In that run, all 300 HTTP calls came back 2xx, and no response showed a
negative balance. Scored on responses only, 0 of 5 runs were flagged. The harness reads the database after the run
and checks invariants: approvals against the starting balance, and whether the balance adds up. That check flagged
5 of 5."

**[1:15-1:40] The fix passes**

"The fix moves the check into Postgres. A function does a conditional decrement, 'update where balance is at least
the amount', and the client calls it with rpc. Exactly 50 approved, balance 0. For the queue, FOR UPDATE SKIP LOCKED
claims 50 of 50, each once. Zero violations in every run."

**[1:40-2:00] Hosted free tier reproduces it**

"Then I ran the same code on a free hosted project, over the internet. The naive spend overspent by 50, and the
naive claim averaged 96 double claims. The fixes had zero violations. Zero HTTP errors across 12 runs, so the free
tier did not throttle a 100-client burst."

**[2:00-2:35] RLS with real user tokens**

"Next I added row level security and two real users, A and B, each owning a wallet. RLS alone does not fix the race:
with A's own token the naive code still fails. The common mistake is a SECURITY DEFINER function with no owner
check. It is race safe, but user B spent 50 credits from A's wallet, in all 3 runs. The SECURITY INVOKER version,
or DEFINER with an owner check, held: B had no effect."

**[2:35-3:00] How common is this (estimate)**

"Last, how common is this? This part is an estimate, not a measurement. A GitHub code search gave about 12,000 file
hits. I read a sample of 30 by hand, and 13 were real money or stock races. Scaled up, my guess is somewhere around
2,000 to 4,100 public repos. Many are hobby projects. That is the demo: the harness runs in CI and checks the
database, not just the responses."

Word count of the spoken text: 419.

## Recording plan

Tools: `asciinema` for the terminal (not installed yet; `sudo apt install asciinema`, free), and a short screen
capture only if a page is shown (none planned). Render the `.cast` to video with `agg` if a file is needed.
Record each beat as its own cast, so a slow or bad take can be redone alone. Terminal: 100 columns, large font,
plain prompt with no hostname or path (`PS1='$ '`), and nothing in scrollback.

Before recording: start your self-hosted Supabase stack, apply the schema (README "How it runs"), and run every command
once untimed to warm Postgres. For a live run, set `--out -` so no new results file is written during the take.

| Beat | Command | Expected run time | Show on screen |
|---|---|---|---|
| 0:00 problem | `sed -n '/function spendNaive/,/^}/p' src/naive.ts` (the read, the JS check, the write) | instant | the select, the JS check, the update |
| 0:20 naive burst | `./run.sh 100 --mode burst --runs 1 --race spend:naive,claim:naive --out -` | estimate 5-15 s (wall per race is about 0.3 s; most of the time is client setup and warm-up; time it in rehearsal) | `successes: 100`, final balance, FAIL line |
| 0:50 scoring | `./run.sh 100 --runs 3 --score both --out -` | estimate 5-15 s (each run about 1 s wall, measured 2026-10-22) | `all_2xx: true`, `response_flag: false`, `invariant_flag: true` |
| 1:15 fix | `./run.sh 100 --mode burst --runs 3 --race spend:conditional_update,claim:skip_locked --out -` | estimate 5-15 s | 50 approved, balance 0, PASS lines |
| 1:40 hosted | Pre-recorded only: `python3 -m json.tool results/hosted-burst-2026-10-21T07-24-04-984Z.json \| less` | instant | naive violations vs fixes |
| 2:00 RLS | `SUPARACE_SCRIPT=src/rls.ts ./run.sh 100 --runs 3` | not measured; estimate 1-3 min (36 cells x 3 runs, plus creating and deleting 2 users). Too long live: record ahead, speed up or cut to the summary table | the `spend:conditional_definer:user_b` row flagged 3/3, exit 0 |
| 2:35 census | `less research/read-then-write-census-2026-10-21.md` (section 3, the HYPOTHESIS heading on screen) | instant | the word HYPOTHESIS and n = 30 |
| close (optional) | `npm test` | a few seconds, no database | 7 passing tests |

Hosted beat: do not rerun live against the earlier hosted project; its `suparace_` objects were dropped after the run. If a live hosted run is wanted, create a fresh Free plan
project, apply `sql/hosted_free_tier.sql`, run `src/hosted.ts`, then `sql/hosted_drop.sql`. Hide the project URL and
key: export them in a shell that is not recorded, and never echo them.

Fallback for any slow live run: play the rehearsal cast for that beat, or show the saved results file for it
(`results/v02-burst-2026-10-22.json`, `results/v02-score-both-2026-10-22.json`,
`results/rls-burst-2026-10-22T19-03-47-963Z.json`). Say "this is the recorded run from the same harness" if so.

Rehearse checklist:
- [ ] Read the script aloud with a timer; total under 3:00, each beat within about 5 s of its mark.
- [ ] Every number spoken matches the Fact check table.
- [ ] Screen shows no hostname, IP, home path, project URL, key, token or real name. Check `run.sh` output and the prompt.
- [ ] No key is echoed. `run.sh` reads it at run time; do not `cat` it or print env.
- [ ] Each command's real run time noted next to the estimate above; switch any beat over 20 s to its fallback.
- [ ] Self-hosted stack stopped after recording.
- [ ] Re-check numbers if a newer run lands before the round (README tables are the source).

## Fact check

| Claim | Number | Source | Measured or hypothesis |
|---|---|---|---|
| Author has no production Supabase use | n/a | author's own statement | fact (framing) |
| supabase-js has no client-side transactions | n/a | README intro | fact (stated in README) |
| Naive burst spend approvals | 100 approved vs 50 credits | README Headline (5 runs, N=100, self-hosted) | measured |
| Final balance after naive burst spend | ~47 | README Headline | measured |
| Lost updates, naive burst spend | 97 | README Headline | measured |
| Naive burst claim | 100 "got a job", 11 distinct jobs | README Headline | measured |
| HTTP calls, response-only run | 300 calls, all 2xx (0 non-2xx) | README Response-only vs invariant scoring | measured |
| Response-only flagged | 0 of 5 runs | same section | measured |
| Invariant flagged | 5 of 5 runs | same section | measured |
| Conditional decrement fix | exactly 50 approved, balance 0 | README Headline; Fix (a) spend table | measured |
| SKIP LOCKED claim | 50/50 claimed once, 0 double claims | README Headline; Fix (b) claim table | measured |
| Fixes 0 violations every run | 0 | README v0.2 port check | measured |
| Hosted naive spend | 50 overspent | README Hosted free-tier reproduction | measured (3 runs) |
| Hosted naive claim | 96 double claims mean | same section | measured (3 runs) |
| Hosted fixes | 0 violations | same section | measured |
| Hosted HTTP errors | 0 in 12 runs | same section | measured |
| RLS: naive still fails with owner's JWT | race fails 3/3 | README RLS matrix, user A spend naive | measured (self-hosted only) |
| Unchecked DEFINER: B spent from A's wallet | 50 spent, 3/3 runs | README RLS matrix | measured (self-hosted only) |
| INVOKER and checked DEFINER: B no effect | 0, no effect | README RLS matrix | measured (self-hosted only) |
| Code-search hits | ~11,990 files (said "about 12,000") | research/read-then-write-census section 1 | measured (GitHub's approximate count) |
| Hand-read sample | 13 of 30 money/stock races | census section 2 | measured (n = 30) |
| Public repos with money/stock races | ~2,000 to 4,100 | census section 3 | hypothesis |
| v0.2 scoring run wall time | ~1 s per run | results/v02-score-both-2026-10-22.json (`wall_ms` 1024, run 1) | measured |
| Command run times in the plan | 5-15 s, 1-3 min | none | estimate, time in rehearsal |
| Unit tests | 7 | README v0.2 section | measured (count) |
