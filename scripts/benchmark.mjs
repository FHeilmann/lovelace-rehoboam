#!/usr/bin/env node
// Measures the CPU cost of the card in headless Chrome and writes the results as JSON.
// It runs two card files (for example the main branch and a pull request) in alternating rounds,
// so both see the same machine load.
//   node scripts/benchmark.mjs --base <card.js> --head <card.js> [--rounds 5] [--out results.json]
// Chrome: $CHROME_BIN, else google-chrome, google-chrome-stable, chromium or chromium-browser.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const files = { base: opt('base'), head: opt('head') };
const ROUNDS = Number(opt('rounds', 5));
const OUT = opt('out', null);
if (!files.base || !files.head) {
  console.error('Usage: node scripts/benchmark.mjs --base <card.js> --head <card.js> [--rounds 5] [--out results.json]');
  process.exit(2);
}

// Scenarios: entity count times callout state. The benchmark card shows MONITORING from a
// divergence of 0.3 and DIVERGENCE from 0.6; each state sits well inside its band.
const COUNTS = [10, 50, 100];
const STATES = { hidden: 0.1, monitoring: 0.45, diverging: 0.85 };
const SCENARIOS = COUNTS.flatMap(entities =>
  Object.entries(STATES).map(([state, divergence]) => ({ id: `${state}-${entities}`, entities, state, divergence })));

// ---- the page that runs inside Chrome ----
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;background:#000"><div id="host" style="width:960px;height:600px"></div>
<script src="/card.js"></script>
<script>
window.runBenchmark = async (scenario) => {
  const now = () => performance.now();
  const median = list => { const s = [...list].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const entities = Array.from({ length: scenario.entities }, (_, i) => ({
    entity: 'sensor.bench_' + i, name: 'Sensor ' + i, category: 'CATEGORY ' + i, baseline: 0, critical: 100, unit: '%'
  }));
  const config = { type: 'custom:lovelace-rehoboam', title: 'Benchmark', entities, fps_idle: 1, fps_active: 1,
    monitoring_threshold: 0.3, divergence_threshold: 0.6 };
  const hassAt = offset => ({
    states: Object.fromEntries(entities.map((e, i) => [e.entity, {
      // Values vary a little per entity and per update, but stay inside the state's band
      state: String(Math.round((scenario.divergence * 100 + (i % 5) * 0.5 + offset * 0.3) * 10) / 10),
      attributes: { unit_of_measurement: '%', friendly_name: e.name }
    }])),
    themes: { darkMode: true }, language: 'en', locale: { language: 'en' }
  });
  const card = document.createElement('lovelace-rehoboam');
  card.setConfig(config);
  document.getElementById('host').appendChild(card);
  card.hass = hassAt(0);
  // Stop the card's own frame loop; the benchmark drives the frames itself
  await new Promise(r => setTimeout(r, 300));
  if (card._rafId) cancelAnimationFrame(card._rafId);
  card._isVisible = false;

  // Frame: the per-frame CPU work (wave data and callout positions) with simulated time at 45 fps
  let t = 1;
  const frame = () => {
    t += 1 / 45;
    card._updatePolarLUT(t);
    if (card._updateCalloutTipPositions) card._updateCalloutTipPositions();
  };
  // Each batch repeats a call until it takes at least 25 ms, so small and large scenarios are
  // both well above the browser's timer resolution
  const timeIt = (fn, batches = 15) => {
    let n = 1;
    for (;;) {
      const t0 = now();
      for (let i = 0; i < n; i++) fn(i);
      if (now() - t0 >= 25 || n >= 1 << 20) break;
      n *= 2;
    }
    const samples = [];
    for (let b = 0; b < batches; b++) {
      const t0 = now();
      for (let i = 0; i < n; i++) fn(i);
      samples.push((now() - t0) / n);
    }
    return median(samples);
  };
  for (let i = 0; i < 1500; i++) frame(); // warm-up, and lets the waves reach their targets
  const frameTime = timeIt(frame);

  // State update: a Home Assistant state change with new values for every entity
  const hassA = hassAt(0), hassB = hassAt(1);
  const hassTime = timeIt(i => { card.hass = i % 2 ? hassA : hassB; });

  // Config change: what the visual editor does on every edit (the card rebuilds its callouts)
  const configB = { ...config, peak_width: 1.2 };
  const configTime = timeIt(i => { card.setConfig(i % 2 ? config : configB); card.hass = hassA; }, 8);
  // Callout states, to confirm that the scenario shows what it claims
  const visible = card._entities.filter(e => e.isVisible).length;
  const diverging = card._entities.filter(e => e.isVisible && e.wasDiverging).length;
  return { frame: frameTime, hass: hassTime, config: configTime, visible, diverging };
};
window.benchReady = !!customElements.get('lovelace-rehoboam');
</script></body></html>`;

// ---- a small server for the page and the card file under test ----
let currentCard = '';
const server = createServer((req, res) => {
  if (req.url.startsWith('/card.js')) {
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
    res.end(currentCard);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.end(PAGE);
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PAGE_URL = `http://127.0.0.1:${server.address().port}/`;

// ---- Chrome over the DevTools protocol ----
function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try { return execFileSync('which', [name], { encoding: 'utf8' }).trim(); } catch (err) { /* next */ }
  }
  throw new Error('No Chrome found; set CHROME_BIN');
}
const profile = mkdtempSync(join(tmpdir(), 'rehoboam-bench-'));
const PORT = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(findChrome(), [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', `--user-data-dir=${profile}`,
  // CI runners on Ubuntu 24.04 block the namespaces Chrome's sandbox needs; the runner VM isolates
  ...(process.env.CI ? ['--no-sandbox'] : []),
  'about:blank'
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, nextId = 1;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
async function connect() {
  for (let i = 0; i < 100; i++) {
    try {
      const page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page');
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise(r => ws.addEventListener('open', r));
        ws.addEventListener('message', ev => {
          const msg = JSON.parse(ev.data);
          const p = msg.id && pending.get(msg.id);
          if (!p) return;
          pending.delete(msg.id);
          msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
        });
        return;
      }
    } catch (err) { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('Chrome did not start');
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
  return r.result.value;
}

// One measurement: a fresh page with one card file, so the two versions never share state
async function measure(which, scenario) {
  currentCard = readFileSync(resolve(files[which]), 'utf8');
  await send('Page.navigate', { url: `${PAGE_URL}?${which}-${scenario.id}-${Date.now()}` });
  for (let i = 0; i < 50 && !(await evaluate('window.benchReady === true').catch(() => false)); i++) await sleep(100);
  return evaluate(`runBenchmark(${JSON.stringify(scenario)})`);
}

const median = list => { const s = [...list].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const results = { version: 1, rounds: ROUNDS, metrics: ['frame', 'hass', 'config'], scenarios: [], size: {} };
try {
  await connect();
  await send('Page.enable');
  for (const scenario of SCENARIOS) {
    const runs = { base: [], head: [] };
    for (let round = 0; round < ROUNDS; round++) {
      // Alternate the order, so neither version always runs first
      const order = round % 2 ? ['head', 'base'] : ['base', 'head'];
      for (const which of order) runs[which].push(await measure(which, scenario));
    }
    const summary = which => Object.fromEntries(results.metrics.map(m => [m, median(runs[which].map(r => r[m]))]));
    const check = runs.head[0];
    console.log(`${scenario.id}: ${check.visible} of ${scenario.entities} callouts visible, ${check.diverging} diverging`);
    results.scenarios.push({ id: scenario.id, entities: scenario.entities, state: scenario.state, base: summary('base'), head: summary('head') });
    console.log(scenario.id, JSON.stringify(results.scenarios.at(-1).head));
  }
  for (const which of ['base', 'head']) {
    const code = readFileSync(resolve(files[which]));
    results.size[which] = { raw: code.length, gzip: gzipSync(code, { level: 9 }).length };
  }
  console.log('size', JSON.stringify(results.size));
  if (OUT) writeFileSync(OUT, JSON.stringify(results, null, 2));
} finally {
  // Wait until Chrome has exited before its profile folder goes
  const exited = new Promise(r => chrome.once('exit', r));
  chrome.kill();
  await Promise.race([exited, sleep(5000)]);
  server.close();
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
