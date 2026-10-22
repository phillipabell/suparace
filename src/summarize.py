#!/usr/bin/env python3
"""Aggregate race-harness JSON lines into a markdown table (mean over runs, worst-case violations)."""
import json, sys, statistics as st
from collections import defaultdict
rows = [json.loads(l) for l in open(sys.argv[1]) if l.startswith('{')]
g = defaultdict(list)
for r in rows: g[(r['op'], r['method'], r['n'])].append(r)
print("| Op | Method | N | Runs | Items | Successes (mean) | Violations mean / max | Left unclaimed max | Lost updates mean | Errors | Wall ms (mean) | Calls/s (mean) | p50 ms | p95 ms |")
print("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
for (op, m, n), rs in sorted(g.items(), key=lambda k: (k[0][0], k[0][2], k[0][1] != 'naive', k[0][1])):
    f = lambda k: st.mean(r.get(k, 0) for r in rs)
    print(f"| {op} | {m} | {n} | {len(rs)} | {rs[0]['items']} | {f('successes'):.0f} | {f('violations'):.0f} / {max(r['violations'] for r in rs)} | "
          f"{max(r.get('left_unclaimed', 0) for r in rs) if op == 'claim' else '-'} | {f('lost_updates'):.0f} | {sum(r['errors'] for r in rs)} | "
          f"{f('wall_ms'):.0f} | {f('ops_per_s'):.0f} | {f('p50_ms'):.1f} | {f('p95_ms'):.1f} |" if op == 'spend' else
          f"| {op} | {m} | {n} | {len(rs)} | {rs[0]['items']} | {f('successes'):.0f} | {f('violations'):.0f} / {max(r['violations'] for r in rs)} | "
          f"{max(r['left_unclaimed'] for r in rs)} | - | {sum(r['errors'] for r in rs)} | {f('wall_ms'):.0f} | {f('ops_per_s'):.0f} | {f('p50_ms'):.1f} | {f('p95_ms'):.1f} |")
