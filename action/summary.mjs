// Markdown job summary from a SupaRace JSON report (`suparace run --out FILE`).
// Usage: node summary.mjs <report.json> [exit code]
import { existsSync, readFileSync } from 'node:fs';

export function summary(report, code) {
  if (!report) return `## SupaRace\n\nNo report was written (exit code ${code}: ${code === 2 ? 'bad config or the target was unreachable, see the log' : 'see the log'}).\n`;
  const lines = [`## SupaRace ${report.pass ? 'PASS' : 'FAIL'}`, '',
    '| race | result | expect | N | mode | flagged runs | failed checks | successes per run |',
    '|---|---|---|---|---|---|---|---|'];
  for (const r of report.reports ?? []) {
    const bad = new Set();
    for (const row of r.rows ?? []) for (const [k, v] of Object.entries({ ...row.invariants, ...row.response })) if (!v) bad.add(k);
    lines.push(`| ${r.race} | ${r.pass ? 'PASS' : '**FAIL**'} | ${r.expect} | ${r.n} | ${r.mode} | ${r.flagged_runs}/${r.runs} | ` +
      `${[...bad].join(', ') || '-'} | ${(r.rows ?? []).map((x) => x.successes).join(', ')} |`);
  }
  lines.push('', `suparace ${report.suparace}. A clean race fails when any run breaks an invariant; a \`violation\` control fails when a run does not.`, '');
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [file, code] = process.argv.slice(2);
  const rep = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  process.stdout.write(summary(rep, Number(code ?? 0)));
}
