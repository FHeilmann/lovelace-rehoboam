// Captures the README screenshots of the playground with headless Chromium (DevTools protocol).
// Serve the repository on port 8766 first (python3 -m http.server 8766 --bind 127.0.0.1), then:
//   node scripts/screenshots.mjs <tmp dir> && python3 scripts/build-images.py <tmp dir> images
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.argv[2];
const BASE = 'http://127.0.0.1:8766/harness.html';
const PORT = 9333;
mkdirSync(OUT, { recursive: true });
mkdirSync(join(OUT, 'frames'), { recursive: true });

const chrome = spawn('chromium', [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--hide-scrollbars', '--mute-audio',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
  `--user-data-dir=${join(OUT, '..', 'profile')}`, 'about:blank'
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, nextId = 1;
const pending = new Map();
function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find(t => t.type === 'page');
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise(r => ws.addEventListener('open', r));
        ws.addEventListener('message', ev => {
          const msg = JSON.parse(ev.data);
          if (msg.id && pending.has(msg.id)) {
            const p = pending.get(msg.id); pending.delete(msg.id);
            msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
          }
        });
        return;
      }
    } catch (err) { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('Chromium did not start');
}
const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const evaluate = expr => send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then(r => r.result.value);

async function open(url, width, height, { scale = 1, header = true } = {}) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
  await send('Page.navigate', { url });
  await sleep(1500);
  // The card shots show the card only, without the page header
  if (!header) await evaluate("document.querySelector('header').style.display = 'none'; window.dispatchEvent(new Event('resize')); true");
}
async function shot(name, clip) {
  const params = { format: 'png', captureBeyondViewport: Boolean(clip) };
  if (clip) params.clip = { ...clip, scale: 1 };
  const { data } = await send('Page.captureScreenshot', params);
  writeFileSync(join(OUT, name), Buffer.from(data, 'base64'));
  console.log('wrote', name);
}

// The card area below the page header
const DEMO = {
  title: 'Rehoboam',
  subtitle: "Indoor {{ states('sensor.temperature') }} °C · Alex: {{ states('person.alex') }}",
  ring_scale: 0.5,
  entities: [
    { entity: 'sensor.pm25', name: 'PM2.5', category: 'AIR QUALITY', baseline: 5, critical: 60, unit: 'µg/m³', angle: 180, monitoring_threshold: 15, divergence_threshold: 35, _div: 0.85 },
    { entity: 'sensor.temperature', name: 'Temperature', category: 'THERMAL VARIANCE', baseline: 20, critical: 35, unit: '°C', angle: 50, _div: 0.53 },
    { entity: 'sensor.humidity', name: 'Humidity', category: 'HUMIDITY', baseline: 40, critical: 80, unit: '%', angle: 20, _div: 0.45 },
    { entity: 'sensor.commute', name: 'Commute', category: 'COMMUTE', baseline: 20, critical: 90, unit: 'min', angle: 335, monitoring_threshold: 40, divergence_threshold: 60, always_visible: true, _div: 0.36 },
    { entity: 'sensor.battery', name: 'Battery', category: 'BATTERY', baseline: 100, critical: 20, unit: '%', angle: 205, _div: 0.5 },
    { entity: 'person.alex', name: 'Alex', category: 'PRESENCE', angle: 115, state_map: { home: 0, work: 0.3, not_home: 1 }, divergence_threshold: 0.5, _state: 'work', _div: 0.5 }
  ]
};
let shotNo = 0;
// A new query per shot, so the page reloads (a change after # alone does not)
const url = (cfg, extra = '') => `${BASE}?panel=0&n=${++shotNo}${extra}#cfg=${b64(cfg)}`;

try {
  await connect();
  await send('Page.enable');
  await send('Runtime.enable');

  // Hero, dark: one still and frames for an animation
  await open(url({ ...DEMO, _lang: 'en' }), 960, 600, { header: false });
  await sleep(9000);
  await shot('hero-dark.png');
  for (let i = 0; i < 48; i++) {
    const t0 = Date.now();
    await shot(`frames/f${String(i).padStart(3, '0')}.png`);
    await sleep(Math.max(0, 125 - (Date.now() - t0)));
  }

  // Light theme
  await open(url({ ...DEMO, theme_mode: 'light', _lang: 'en' }), 960, 600, { header: false });
  await sleep(9000);
  await shot('light.png');

  // German callouts and title
  await open(url({ ...DEMO, title: 'Zuhause', subtitle: "Innen {{ states('sensor.temperature') }} °C · Alex: {{ states('person.alex') }}", _lang: 'de',
    entities: DEMO.entities.map(e => ({ ...e, category: { 'AIR QUALITY': 'LUFTQUALITÄT', 'THERMAL VARIANCE': 'TEMPERATUR', HUMIDITY: 'FEUCHTE', COMMUTE: 'PENDELN', BATTERY: 'AKKU', PRESENCE: 'ANWESENHEIT' }[e.category] })) }), 960, 600, { header: false });
  await sleep(9000);
  await shot('german.png');

  // Playground with the panel
  await open(`${BASE}?lang=en&n=90`, 1280, 780, { header: false });
  await sleep(8000);
  await shot('playground.png');

  // Visual editor, rendered on a Home Assistant-like dark page, one entity section open
  await open(`${BASE}?lang=en&panel=0&n=91`, 1200, 1400);
  await evaluate(`(async () => {
    document.body.innerHTML = '';
    document.body.style.cssText = 'margin:0;background:#111113;display:block;height:auto';
    const wrap = document.createElement('div');
    wrap.style.cssText = 'width:640px;margin:0 auto;padding:20px;background:#1c1c1f;color:#e1e1e1;--primary-color:#03a9f4;--card-background-color:#202024;--secondary-text-color:#9b9b9b;--primary-text-color:#e1e1e1;--divider-color:rgba(255,255,255,0.12)';
    document.body.appendChild(wrap);
    const ed = document.createElement('lovelace-rehoboam-editor');
    wrap.appendChild(ed);
    ed.setConfig({ type: 'custom:lovelace-rehoboam', title: 'Rehoboam', subtitle: "{{ states('sensor.outside_temperature') }} °C",
      entities: [{ entity: 'person.alex', name: 'Alex', category: 'PRESENCE', state_map: { home: 0, work: 0.3, not_home: 1 }, divergence_threshold: 0.5 }, { entity: 'sensor.temperature', name: 'Temperature', category: 'THERMAL VARIANCE', baseline: 20, critical: 35 }] });
    await new Promise(r => setTimeout(r, 300));
    ed.shadowRoot.querySelector('details.entity-card').open = true;
    await new Promise(r => setTimeout(r, 300));
    return wrap.getBoundingClientRect().height;
  })()`);
  // Title section and the first sections
  await shot('editor.png', { x: 280, y: 0, width: 640, height: 1060 });
  // Open entity section
  const [entTop, entHeight] = await evaluate(`(() => { const d = document.querySelector('lovelace-rehoboam-editor').shadowRoot.querySelector('details.entity-card'); const r = d.getBoundingClientRect(); return [r.top + window.scrollY, r.height]; })()`);
  await shot('editor-entity.png', { x: 280, y: Math.floor(entTop) - 16, width: 640, height: Math.ceil(entHeight) + 32 });
} finally {
  chrome.kill();
}
