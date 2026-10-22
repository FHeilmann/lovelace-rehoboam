#!/usr/bin/env node
// Turns the JSON of scripts/benchmark.mjs into the Markdown of the pull request comment.
// The JSON comes from a pull request run, so it is untrusted: only known scenario ids and
// finite numbers are used, and all text comes from this file.
//   node scripts/benchmark-comment.mjs results.json > comment.md
import { readFileSync } from 'node:fs';

const MARKER = '<!-- rehoboam-benchmark -->';
const THRESHOLD = 10; // percent; smaller changes are within the noise of a shared runner
const COUNTS = [10, 50, 100];
const STATES = { hidden: 'Hidden', monitoring: 'Monitoring', diverging: 'Diverging' };
const METRICS = { frame: 'Frame', hass: 'State update', config: 'Config change' };

const data = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const num = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e9 ? v : null);
const time = ms => {
  if (ms === null) return 'n/a';
  const us = ms * 1000;
  return us < 10 ? `${us.toFixed(1)} µs` : us < 1000 ? `${Math.round(us)} µs` : `${ms.toFixed(2)} ms`;
};
const kb = bytes => (bytes === null ? 'n/a' : `${(bytes / 1000).toFixed(1)} kB`);
const pctText = pct => (Math.abs(pct) < 0.05 ? '0.0 %' : `${pct > 0 ? '+' : ''}${pct.toFixed(1)} %`);

// One cell: "main → PR (change)"; beyond the noise the PR value and the change are bold
function cell(base, head) {
  if (base === null || head === null || base === 0) return { text: 'n/a', flag: 0 };
  const pct = ((head - base) / base) * 100;
  const flag = pct > THRESHOLD ? 1 : pct < -THRESHOLD ? -1 : 0;
  if (!flag) return { text: `${time(base)} → ${time(head)} (${pctText(pct)})`, flag };
  return { text: `${time(base)} → **${time(head)}** (**${pctText(pct)} ${flag > 0 ? 'slower' : 'faster'}**)`, flag };
}

const byId = new Map((Array.isArray(data.scenarios) ? data.scenarios : []).filter(sc => sc && typeof sc.id === 'string').map(sc => [sc.id, sc]));
const rows = [];
const slower = [];
const faster = [];
for (const count of COUNTS) {
  for (const [state, stateName] of Object.entries(STATES)) {
    const sc = byId.get(`${state}-${count}`);
    if (!sc) continue;
    const cells = Object.entries(METRICS).map(([metric, name]) => {
      const c = cell(num(sc.base && sc.base[metric]), num(sc.head && sc.head[metric]));
      if (c.flag > 0) slower.push(`${name.toLowerCase()} (${count}, ${stateName.toLowerCase()})`);
      if (c.flag < 0) faster.push(`${name.toLowerCase()} (${count}, ${stateName.toLowerCase()})`);
      return c.text;
    });
    rows.push(`| ${count} | ${stateName} | ${cells.join(' | ')} |`);
  }
}

const size = data.size || {};
const sizeCell = kind => {
  const a = num(size.base && size.base[kind]);
  const b = num(size.head && size.head[kind]);
  if (a === null || b === null || a === 0) return 'n/a';
  return `${kb(a)} → ${kb(b)} (${pctText(((b - a) / a) * 100)})`;
};

let verdict = 'No significant change.';
if (slower.length || faster.length) {
  verdict = [
    slower.length ? `**Slower:** ${slower.join(', ')}.` : '',
    faster.length ? `**Faster:** ${faster.join(', ')}.` : ''
  ].filter(Boolean).join('<br>');
}
const rounds = Number.isInteger(data.rounds) && data.rounds > 0 && data.rounds < 100 ? data.rounds : 'several';

console.log(`${MARKER}
### Performance

${verdict}

| Entities | Callouts | Frame | State update | Config change |
| ---: | --- | --- | --- | --- |
${rows.join('\n')}

File size: ${sizeCell('raw')} raw, ${sizeCell('gzip')} gzip.

<sub>CPU time per call, \`main\` → this PR, in headless Chrome on the GitHub runner; median of ${rounds} rounds that alternate between the two. Frame is the per-frame work of the waves and callouts; Callouts is the state of all entities (hidden below the monitoring threshold, monitoring, diverging). Bold values changed by more than ±${THRESHOLD} %; smaller changes are runner noise. GPU drawing is not measured: the runner has no GPU. This comment updates on every push to the pull request.</sub>`);
