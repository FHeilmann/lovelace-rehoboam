/**
 * Rehoboam Custom Lovelace Card v9 (Home Assistant Production Build)
 * 1. Directional baseline-to-critical clamping: (val - baseline) / (critical - baseline) clamped to [0, 1]
 *    Automatically detects low=good/high=bad (critical > baseline) vs high=good/low=bad (critical < baseline).
 * 2. Cusp-envelope divergence spikes: needle apex, concave flanks, ridged notches on the skirt, and
 *    slope-corrected 1 px edges so steep flanks stay crisp. Small divergences get a rounder tip.
 * 3. Full Lovelace Visual Configuration Editor (`lovelace-rehoboam-editor` via `getConfigElement()`).
 */

const LUT_SIZE = 1024;
const LUT_MASK = LUT_SIZE - 1;
const TWO_PI = Math.PI * 2;
const DEG_TO_RAD = Math.PI / 180;

// Each spike is a stack of 7 strata, after the show's skyline look: a peak (layer 0) on an
// upper hill (layer 1) on a broad stratum with outward-curving sides (layer 2), with smaller strata on
// its flanks (layers 3-6). Heights step down gradually, so the peak is part of the strata.
// Envelope: cusp (1 - x)^pow, or with flat: true, 1 - x^pow (flat top, steep sides); x = d / cutoff.
// lobe/lobeFreq give the strata rounded bumps along their tops; jag/jagFreq add small notches.
// lean stretches one flank and shortens the other (cutoff * (1 +/- lean)).
// sway (bins) moves each layer of a spike sideways and breathe (fraction of its height) pulls it in
// and out over time. Callouts stay at the full, unmoved peak.
const BAND_SPEED = 0.9; // rad/s of the inward-outward slide of the shading rings
const LAYER_CONFIG = [
  { cutoff: 10.0,  pow: 2.3, flat: true,  height: 0.70, lobe: 0.08, lobeFreq: 0.55, jag: 0.03, jagFreq: 0.90, lean: 0.15, sway: 1.6, breathe: 0.08, baseAmp: 0.008, freq1: 13, freq2: 29, speed: 0.95, phase: 0.0, offsetBins: 0   },
  { cutoff: 19.0, pow: 2.0, flat: true,  height: 0.76, lobe: 0.10, lobeFreq: 0.45, jag: 0.03, jagFreq: 0.90, lean: 0.20, sway: 1.8, breathe: 0.10, baseAmp: 0.014, freq1: 11, freq2: 23, speed: 0.80, phase: 0.9, offsetBins: 2   },
  { cutoff: 46.0, pow: 1.6, flat: true,  height: 0.60, lobe: 0.10, lobeFreq: 0.35, jag: 0.03, jagFreq: 0.80, lean: 0.25, sway: 2.4, breathe: 0.12, baseAmp: 0.020, freq1: 9,  freq2: 19, speed: 0.68, phase: 2.1, offsetBins: -2  },
  { cutoff: 28.0, pow: 2.5, flat: true,  height: 0.46, lobe: 0.15, lobeFreq: 0.42, jag: 0.03, jagFreq: 0.80, lean: 0.30, sway: 2.8, breathe: 0.13, baseAmp: 0.026, freq1: 7,  freq2: 17, speed: 0.58, phase: 3.4, offsetBins: 9   },
  { cutoff: 34.0, pow: 2.5, flat: true,  height: 0.38, lobe: 0.15, lobeFreq: 0.38, jag: 0.03, jagFreq: 0.70, lean: 0.35, sway: 3.0, breathe: 0.14, baseAmp: 0.032, freq1: 6,  freq2: 13, speed: 0.48, phase: 4.2, offsetBins: -13 },
  { cutoff: 60.0, pow: 3.0, flat: true,  height: 0.26, lobe: 0.16, lobeFreq: 0.26, jag: 0.03, jagFreq: 0.55, lean: 0.38, sway: 3.6, breathe: 0.15, baseAmp: 0.038, freq1: 5,  freq2: 11, speed: 0.40, phase: 1.5, offsetBins: 16  },
  { cutoff: 90.0, pow: 2.4, flat: true,  height: 0.16, lobe: 0.14, lobeFreq: 0.20, jag: 0.03, jagFreq: 0.45, lean: 0.30, sway: 4.0, breathe: 0.15, baseAmp: 0.042, freq1: 4,  freq2: 9,  speed: 0.30, phase: 2.8, offsetBins: -18 }
];

// Precomputed 4096-entry periodic sine LUT (fits in 16 KB L1 cache on Cortex-A53)
const SIN_LUT_SIZE = 4096;
const SIN_LUT_MASK = SIN_LUT_SIZE - 1;
const COS_LUT_OFFSET = SIN_LUT_SIZE >> 2;
const RAD_TO_SIN_IDX = SIN_LUT_SIZE / TWO_PI;
const FAST_SIN_LUT = new Float32Array(SIN_LUT_SIZE);
for (let i = 0; i < SIN_LUT_SIZE; i++) {
  FAST_SIN_LUT[i] = Math.sin((i / SIN_LUT_SIZE) * TWO_PI);
}

// Per-layer envelopes & flank weights, indexed by d + left[k] for a signed bin offset d in
// [-left[k], right[k]]. strataWidth scales the width, offset and bump spacing of the lower strata (layers 2-6),
// peakWidth those of the peak (layers 0-1). peakSharpness (0-1) blends the peak from
// its flat-topped dome toward a pointed cusp, and peakHeight scales how far it stands out.
const FIRST_STRATA_LAYER = 2;
const PEAK_CUSP_POW = 2.4;
function buildLayerEnvelopes(strataWidth, peakWidth, peakSharpness, peakHeight) {
  const env = { base: [], mod: [], left: [], right: [], offset: [], freqScale: [] };
  for (let k = 0; k < LAYER_CONFIG.length; k++) {
    const cfg = LAYER_CONFIG[k];
    const isPeak = k < FIRST_STRATA_LAYER;
    const widthScale = isPeak ? peakWidth : strataWidth;
    const height = cfg.height * (isPeak ? peakHeight : 1.0);
    const cutoff = cfg.cutoff * widthScale;
    const cutL = cutoff * (1.0 - cfg.lean);
    const cutR = cutoff * (1.0 + cfg.lean);
    const nL = Math.max(1, Math.ceil(cutL) - 1);
    const nR = Math.max(1, Math.ceil(cutR) - 1);
    const baseArr = new Float32Array(nL + nR + 1);
    const modArr = new Float32Array(nL + nR + 1);
    for (let d = -nL; d <= nR; d++) {
      const dAbs = d < 0 ? -d : d;
      const cut = d < 0 ? cutL : cutR;
      const x = Math.min(1.0, dAbs / cut);
      let e = cfg.flat ? 1.0 - Math.pow(x, cfg.pow) : Math.pow(1.0 - x, cfg.pow);
      if (isPeak && peakSharpness > 0.0) {
        e += (Math.pow(1.0 - x, PEAK_CUSP_POW) - e) * peakSharpness;
      }
      // The peak keeps its full height on average (it carries the callout) with lighter bumps;
      // the other layers sit a quarter lower and take the full bumps
      const baseScale = k === 0 ? 1.0 : 0.74;
      const modScale = k === 0 ? 0.4 : 1.0;
      baseArr[d + nL] = height * e * baseScale;
      modArr[d + nL] = height * e * modScale;
    }
    env.base.push(baseArr);
    env.mod.push(modArr);
    env.left.push(nL);
    env.right.push(nR);
    env.offset.push(Math.round(cfg.offsetBins * widthScale));
    env.freqScale.push(1.0 / widthScale);
  }
  // Scratch rows with one zero on each side, so a sub-bin shift can read one entry past the window
  env.profile = env.base.map(row => new Float32Array(row.length + 2));
  return env;
}

const VERTEX_SHADER = `
  attribute vec2 a_pos;
  varying vec2 v_uv;
  uniform vec2 u_aspect;
  void main() {
    v_uv = a_pos * u_aspect;
    gl_Position = vec4(a_pos, 0.0, 1.0);
  }
`;

const FRAGMENT_SHADER = `
  precision mediump float;
  varying vec2 v_uv;

  uniform sampler2D u_lut;
  uniform float u_eclipse;
  uniform vec2 u_eclipse_dir;
  uniform float u_light_mode;
  uniform float u_amp_scale;
  uniform float u_ray_intensity;
  uniform float u_px_size;
  uniform float u_facet;
  uniform float u_ring_shade;
  uniform float u_band_phase;
  uniform vec2 u_wobble;

  // Set per pixel in main() before the ribbons are evaluated
  float g_band;

  float fastAtan01(vec2 p) {
    vec2 a = abs(p);
    float mn = min(a.x, a.y);
    float mx = max(a.x, a.y);
    float s = mn / (mx + 1e-5);
    float s2 = s * s;
    float r = s * (0.15915494 + s2 * (-0.04559861 + 0.01144367 * s2));
    if (a.y > a.x) r = 0.25 - r;
    if (p.x < 0.0) r = 0.5 - r;
    if (p.y < 0.0) r = 1.0 - r;
    return r;
  }

  // dispNext is the same layer one LUT texel further round; invArc converts its difference to a
  // tangential slope. Dividing by the gradient length turns (r - rTop) into a true signed distance,
  // so steep spike flanks get the same 1 px edge and outline as the flat rim.
  float evalRibbon(float r, float rBase, float innerStep, float disp, float dispNext, float invArc, float fillAlpha, float edgeAlpha, float px) {
    float rTop = rBase + disp;
    float vis = step(0.0012, disp);
    float slope = (dispNext - disp) * invArc;
    float invLen = inversesqrt(1.0 + slope * slope);
    float sd = (r - rTop) * invLen;
    float body = innerStep * clamp(0.5 - sd / px, 0.0, 1.0);
    float grad = 0.58 + 0.42 * clamp((r - rBase) / (disp + 0.0001), 0.0, 1.0);
    // Ring shading (g_band, set once per pixel in main): lighter and darker rings round the whole
    // circle show through the strata's fill
    float facet = 1.0 + u_facet * (g_band - 0.5);
    // Fold shadow: densest at the layer's own edge, fading out 6 px below it, so stacked layers
    // read as folded sheets
    float fold = clamp(1.0 + sd / (6.0 * px), 0.0, 1.0);
    fold *= fold;
    float rim = innerStep * clamp(1.0 - abs(sd + 0.6 * px) / (1.1 * px), 0.0, 1.0);
    return min(1.0, body * (fillAlpha * grad * facet + 0.5 * u_facet * fold) + rim * edgeAlpha) * vis;
  }

  void main() {
    float r = length(v_uv);
    float angle01 = fastAtan01(v_uv);

    vec4 L4_7 = texture2D(u_lut, vec2(angle01, 0.75));
    float rayStriation = L4_7.a;
    // Decode sqrt-compressed LUT channels for 8x finer low-amplitude precision
    vec3 L4_6 = L4_7.rgb * L4_7.rgb;

    vec2 dir = v_uv / (r + 1e-5);
    float align01 = clamp(dot(dir, u_eclipse_dir) * 0.5 + 0.5, 0.0, 1.0);
    float align2 = align01 * align01;
    float align4 = align2 * align2;
    float align6 = align4 * align2;

    vec2 innerCenter = -u_eclipse_dir * (0.032 * u_eclipse);
    float rInner = length(v_uv - innerCenter);

    float innerErode = (L4_6.g + L4_6.b) * 0.010;
    float innerRadius = 0.992 - 0.014 * u_eclipse - innerErode;
    float dInner = rInner - innerRadius;
    float maxRange = 0.58 * u_amp_scale;

    // Only evaluate the 7 wave strata within the active radial ring band (skips ~75% of screen pixels)
    float strataDensity = 0.0;
    if (dInner > -0.004 && r < innerRadius + maxRange + 0.015) {
      vec4 L0_3 = texture2D(u_lut, vec2(angle01, 0.25));
      L0_3 *= L0_3;
      // One texel further round, for the flank slope of each layer
      float nextU = angle01 + ${(1 / LUT_SIZE).toFixed(8)};
      vec4 N0_3 = texture2D(u_lut, vec2(nextU, 0.25));
      vec4 N4_7 = texture2D(u_lut, vec2(nextU, 0.75));
      N0_3 *= N0_3;
      vec3 N4_6 = N4_7.rgb * N4_7.rgb;

      vec4 dA = L0_3 * maxRange;
      vec3 dB = L4_6 * maxRange;
      vec4 nA = N0_3 * maxRange;
      vec3 nB = N4_6 * maxRange;
      float invArc = ${(LUT_SIZE / (2 * Math.PI)).toFixed(4)} / max(r, 0.5);

      // Toward the eclipse side the strata turn into solid corona teeth
      float fillBoost = 1.0 + 2.2 * u_eclipse * align4;


      // Concentric rings every 0.08 ring radii, wobbling round the circle and sliding in and out.
      // A triangle wave with a smoothstep is a cheap stand-in for a cosine.
      // u_ring_shade = 0 turns the rings off (g_band = 0.5 leaves the fill unchanged).
      g_band = 0.5;
      if (u_ring_shade > 0.5) {
        float wobble = 0.30 * sin(angle01 * ${(6 * Math.PI).toFixed(6)} + u_wobble.x) +
                       0.18 * sin(angle01 * ${(10 * Math.PI).toFixed(6)} - u_wobble.y);
        float tri = abs(fract(r * 12.5 + wobble + u_band_phase) - 0.5) * 2.0;
        g_band = tri * tri * (3.0 - 2.0 * tri);
      }

      float innerStep = smoothstep(innerRadius - u_px_size, innerRadius + u_px_size, r);
      float trans = 1.0;
      trans *= (1.0 - evalRibbon(r, innerRadius, innerStep, dA.r, nA.r, invArc, 0.30 * fillBoost, 0.40, u_px_size));
      trans *= (1.0 - evalRibbon(r, innerRadius, innerStep, dA.g, nA.g, invArc, 0.28 * fillBoost, 0.38, u_px_size));
      trans *= (1.0 - evalRibbon(r, innerRadius, innerStep, dA.b, nA.b, invArc, 0.30 * fillBoost, 0.36, u_px_size));
      trans *= (1.0 - evalRibbon(r, innerRadius, innerStep, dA.a, nA.a, invArc, 0.26 * fillBoost, 0.32, u_px_size));
      trans *= (1.0 - evalRibbon(r, innerRadius, innerStep, dB.r, nB.r, invArc, 0.22 * fillBoost, 0.28, u_px_size));
      trans *= (1.0 - evalRibbon(r, innerRadius, innerStep, dB.g, nB.g, invArc, 0.18 * fillBoost, 0.25, u_px_size));
      trans *= (1.0 - evalRibbon(r, innerRadius, innerStep, dB.b, nB.b, invArc, 0.15 * fillBoost, 0.22, u_px_size));

      float dRim = (r - innerRadius) * 180.0;
      float baseRim = (1.0 / (1.0 + dRim * dRim)) * 0.72;
      trans *= (1.0 - baseRim);

      // Solid core band of the resting ring; its outer edge follows the widest stratum a little
      float bandTop = innerRadius + 0.020 + 0.30 * min(dB.b, 0.05);
      float band = innerStep * clamp((bandTop - r) / u_px_size + 0.5, 0.0, 1.0);
      trans *= (1.0 - 0.80 * band);

      strataDensity = 1.0 - trans;
    }

    float coreCrescent = 0.0;
    float smoothHalo = 0.0;
    float outerRays = 0.0;
    float eclipseBloom = 0.0;

    if (dInner > -0.015 && u_eclipse > 0.001) {
      float dLimb = max(0.0, dInner);

      float coreWidth = 0.005 + u_eclipse * (0.012 + 0.092 * align6);
      float cCore = dLimb / coreWidth;
      float cCore2 = cCore * cCore;
      coreCrescent = (1.0 / (1.0 + cCore2 * 1.15 + cCore2 * cCore2 * 0.42))
                   * u_eclipse * (0.38 + 1.90 * align4);

      float haloWidth = 0.022 + u_eclipse * (0.040 + 0.20 * align4);
      float cHalo = dLimb / haloWidth;
      float cHalo2 = cHalo * cHalo;
      smoothHalo = (1.0 / (1.0 + cHalo2 * 1.8 + cHalo2 * cHalo2 * 0.6))
                 * u_eclipse * (0.08 + 0.36 * align4);

      float rayStretch = 1.0 + (0.48 * rayStriation) * u_ray_intensity;
      float rayWidth = (0.016 + u_eclipse * (0.028 + 0.19 * align4)) * rayStretch;
      float cRay = dLimb / rayWidth;
      float cRay2 = cRay * cRay;
      outerRays = (1.0 / (1.0 + cRay2 * 1.8 + cRay2 * cRay2 * 0.85))
                * u_eclipse * (0.10 + 0.52 * align4) * rayStriation * u_ray_intensity;

      eclipseBloom = (coreCrescent + smoothHalo + outerRays) * smoothstep(-0.015, 0.008, dInner);
    }

    float diskMask = smoothstep(-0.0035, 0.0035, dInner);
    float innerRadialFade = smoothstep(0.75, 0.98, rInner);
    float innerWrap = 0.0;
    if (dInner < 0.0035 && rInner > 0.75) {
      float wrapWidth = 0.006 + u_eclipse * (0.012 + 0.065 * align6);
      float dWrap = max(0.0, -dInner) / wrapWidth;
      innerWrap = (1.0 / (1.0 + dWrap * dWrap * 2.2))
                * (0.08 + u_eclipse * (0.45 + 1.15 * align6))
                * innerRadialFade;
    }

    // Interleaved gradient noise dither (+/- 0.5 LSB) eliminates 8-bit Mach banding on tablet panels
    float dither = (fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5) * (1.0 / 255.0);

    if (u_light_mode < 0.5) {
      vec3 bgCol = vec3(0.024, 0.024, 0.030);
      vec3 diskCol = vec3(0.016, 0.016, 0.022);

      float energy = (strataDensity * 1.30 + eclipseBloom) * diskMask + innerWrap * (1.0 - diskMask);
      vec3 mapped = vec3(0.975, 0.985, 1.0) * (1.0 - exp(-energy * 1.35));
      vec3 finalDark = mix(diskCol, bgCol, diskMask) + mapped + dither;
      gl_FragColor = vec4(clamp(finalDark, 0.0, 1.0), 1.0);
    } else {
      float vig = clamp((r - 0.85) * 0.38, 0.0, 1.0);
      vec3 bgLight = mix(vec3(0.985, 0.985, 0.990), vec3(0.905, 0.908, 0.920), vig * vig);

      float innerBevel = smoothstep(-0.10, -0.003, dInner) * (1.0 - diskMask) * innerRadialFade;
      vec3 coreLight = mix(vec3(1.0, 1.0, 1.0), vec3(0.84, 0.845, 0.86), innerBevel * (0.22 + 0.40 * u_eclipse));
      vec3 baseCanvas = mix(coreLight, bgLight, diskMask);

      float inkCorona = clamp((coreCrescent * 0.82 + (smoothHalo + outerRays) * 0.48), 0.0, 0.95);
      float inkWrap = clamp(innerWrap * 0.62, 0.0, 0.88) * (1.0 - diskMask);

      float combinedInk = 1.0 - (1.0 - strataDensity) * (1.0 - inkCorona);
      float totalInk = clamp(combinedInk * diskMask + inkWrap, 0.0, 0.97);

      vec3 inkColor = vec3(0.04, 0.04, 0.05);
      vec3 shaded = mix(baseCanvas, inkColor, totalInk) + dither;

      gl_FragColor = vec4(clamp(shaded, 0.0, 1.0), 1.0);
    }
  }
`;

function hexPoints(r) {
  const pts = [];
  for (let k = 0; k < 6; k++) {
    const a = k * 60 * DEG_TO_RAD;
    pts.push(`${(Math.cos(a) * r).toFixed(1)},${(Math.sin(a) * r).toFixed(1)}`);
  }
  return pts.join(' ');
}

const DEFAULT_HEIGHT = '500px';
// Condensed DIN-style face like the show's labels. Barlow Condensed loads from Google Fonts once
// per page; set font_family to a local font to avoid the request.
const DEFAULT_FONT = "'Barlow Condensed', 'Roboto Condensed', 'Arial Narrow', sans-serif";
const GOOGLE_FONT_URL = 'https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;500;600&display=swap';
function ensureLabelFont(family) {
  if (!family.includes('Barlow Condensed') || document.getElementById('rehoboam-label-font')) return;
  const link = document.createElement('link');
  link.id = 'rehoboam-label-font';
  link.rel = 'stylesheet';
  link.href = GOOGLE_FONT_URL;
  document.head.appendChild(link);
}
const DEFAULT_HOLD_MS = 500;
const TAP_MOVE_TOLERANCE_PX = 12;
const NO_ACTION = { action: 'none' };
const LABEL_GAP_EXTRA = 8; // px between stacked callout labels, on top of the label height
const DEFAULT_FONT_SIZE = 13;

// Label line positions above the shelf, all derived from the header font size (px)
function labelMetrics(fontSize) {
  const sub = Math.round(fontSize * 0.92 * 10) / 10;
  const subY = 5;                          // sub-line baseline above the shelf
  const headerY = subY + sub + 1;          // header baseline above the shelf
  const top = headerY + fontSize * 0.8;    // top of the header glyphs above the shelf
  return { header: fontSize, sub, subY, headerY, top, gap: top + LABEL_GAP_EXTRA };
}
const EDGE_MARGIN = 4;  // px kept free at the card edges where possible
const EDGE_MAX_X = 40;  // px the corner may slide past the marker toward the ring
const EDGE_MAX_Y = 80;  // px a label may move back from the top or bottom edge
const SHELF_PAD = 14;  // px the shelf runs past the label text (6 px inset + 8 px overhang)
// Leader draw-on timing (must match the .callout.visible .leader rule)
const LEADER_DELAY_S = 0.2;
const LEADER_DRAW_S = 1.1;
const LEADER_EASE = [0.45, 0.05, 0.55, 0.95];

// Time fraction at which a CSS cubic-bezier easing reaches the given progress (bisection)
function easeTimeForProgress(progress, [x1, y1, x2, y2]) {
  const bez = (s, a, b) => 3 * a * s * (1 - s) * (1 - s) + 3 * b * s * s * (1 - s) + s * s * s;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) * 0.5;
    if (bez(mid, y1, y2) < progress) lo = mid; else hi = mid;
  }
  return bez((lo + hi) * 0.5, x1, x2);
}
const CARD_VERSION = '0.18.0';

console.info(
  `%c LOVELACE-REHOBOAM %c v${CARD_VERSION} `,
  'color: #fff; background: #181820; font-weight: 700; padding: 2px 6px; border-radius: 4px 0 0 4px;',
  'color: #181820; background: #EAEAF0; font-weight: 700; padding: 2px 6px; border-radius: 0 4px 4px 0;'
);

// Escape user-provided config values before interpolating into innerHTML
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Directional normalization & clamping between baseline and critical:
 * - If critical > baseline (e.g. baseline 10, critical 50): values <= 10 clamp to 0.0; values >= 50 clamp to 1.0.
 * - If critical < baseline (e.g. baseline 100, critical 20): values >= 100 clamp to 0.0; values <= 20 clamp to 1.0.
 */
function computeDirectionalDivergence(val, baseline, critical) {
  const span = critical - baseline;
  if (Math.abs(span) < 1e-6) return 0.0;
  const raw = (val - baseline) / span;
  return Math.max(0.0, Math.min(1.0, raw));
}

function roundToStep(value, step) {
  if (!Number.isFinite(value) || !(step > 0)) return value;
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  return Number(value.toFixed(Math.min(decimals, 10)));
}

// One list of settings, read by the card (defaults and limits), the visual editor, the playground
// page and the README generator (scripts/readme-options.mjs). Types: number (slider and number
// box), select, text, bool, entity, action. An empty nullable number means "not set"; its slider
// then rests at unsetAt (a number, or a function of the config).
const SETTING_SECTIONS = [
  { id: 'title', title: 'Title', hint: 'The subtitle accepts Home Assistant templates, for example {{ states("sensor.temperature") }} °C.' },
  { id: 'appearance', title: 'Appearance' },
  { id: 'eclipse', title: 'Eclipse' },
  { id: 'peak', title: 'Peak' },
  { id: 'strata', title: 'Strata and waves' },
  { id: 'ambient', title: 'Ambient strata' },
  { id: 'divergence', title: 'Divergence' },
  { id: 'text', title: 'Callout text' },
  { id: 'interaction', title: 'Interaction', hint: 'Tap or hold the centre of the ring or a callout. For a browser_mod popup use the action "fire-dom-event" with a browser_mod block in YAML.' },
  { id: 'performance', title: 'Performance' }
];
const CARD_SETTINGS = [
  { key: 'title', section: 'title', type: 'text', label: 'Title', placeholder: 'Rehoboam',
    tip: 'Text in the top left corner of the card. Empty shows no title.' },
  { key: 'subtitle', section: 'title', type: 'template', label: 'Subtitle',
    tip: 'Text below the title. Accepts Home Assistant templates, for example {{ states("sensor.outside_temperature") }}; the card updates it when the result changes.' },

  { key: 'theme_mode', section: 'appearance', type: 'select', label: 'Theme', default: 'dark',
    options: [['dark', 'Dark'], ['light', 'Light'], ['auto', 'Auto']],
    tip: 'Dark shows a night eclipse, light shows ink on paper. Auto follows the dark mode setting of Home Assistant.' },
  { key: 'height', section: 'appearance', type: 'text', label: 'Card height (CSS)', default: DEFAULT_HEIGHT, placeholder: '500px, 60vh, ...',
    tip: 'Card height in CSS units, for example 500px, or 100vh for a full-screen panel view.' },
  { key: 'ring_scale', section: 'appearance', type: 'number', label: 'Ring scale', min: 0.2, max: 0.9, step: 0.01, default: 0.42,
    tip: 'Ring radius relative to the card size.' },

  { key: 'eclipse_angle', section: 'eclipse', type: 'number', label: 'Eclipse angle (°, empty = follow)', min: 0, max: 360, step: 1,
    nullable: true, unsetAt: 180, placeholder: 'Follow', yamlType: 'number or auto', defaultText: 'auto',
    tip: 'Direction of the eclipse glow in degrees (0 = right, counter-clockwise). Leave empty to turn the glow toward the entity with the most divergence.' },
  { key: 'eclipse_intensity', section: 'eclipse', type: 'number', label: 'Eclipse intensity', min: 0, max: 2, step: 0.05, default: 1,
    tip: 'Brightness of the eclipse crescent and its corona.' },
  { key: 'ray_intensity', section: 'eclipse', type: 'number', label: 'Corona rays', min: 0, max: 1, step: 0.05, default: 0.35,
    tip: 'Strength of the thin rays that shimmer outward from the ring.' },
  { key: 'test_divergence', section: 'eclipse', type: 'number', label: 'Test divergence (empty = live)', min: 0, max: 1, step: 0.01,
    nullable: true, unsetAt: 0, placeholder: 'Live', defaultText: 'none',
    tip: 'Preview only: forces the eclipse glow to this divergence. Leave empty to use the live values.' },

  { key: 'peak_width', section: 'peak', type: 'number', label: 'Peak width', min: 0.4, max: 3, step: 0.05, default: 1,
    tip: 'Width of the peak that rises above a diverging entity.' },
  { key: 'peak_sharpness', section: 'peak', type: 'number', label: 'Peak sharpness (0 = dome, 1 = point)', min: 0, max: 1, step: 0.05, default: 0,
    tip: 'Shape of the peak: 0 is a flat-topped dome, 1 is a pointed tip.' },
  { key: 'peak_height', section: 'peak', type: 'number', label: 'Peak prominence', min: 0.3, max: 1.43, step: 0.01, default: 1,
    tip: 'How far the peak stands out above the strata below it.' },

  { key: 'amplitude_scale', section: 'strata', type: 'number', label: 'Wave amplitude scale', min: 0.1, max: 3, step: 0.05, default: 1.25,
    tip: 'Height multiplier for all waves and strata.' },
  { key: 'strata_width', section: 'strata', type: 'number', label: 'Strata width', min: 0.3, max: 2.5, step: 0.05, default: 1,
    tip: 'Width of the strata below each peak.' },
  { key: 'baseline_height', section: 'strata', type: 'number', label: 'Baseline wave height (0 = flat ring)', min: 0, max: 5, step: 0.1, default: 1,
    tip: 'Height of the thin band of waves around the full ring. 0 gives a flat ring.' },
  { key: 'facet_shading', section: 'strata', type: 'number', label: 'Fold shading', min: 0, max: 1, step: 0.05, default: 0.6,
    tip: 'Strength of the fold shadows that make the strata look 3D.' },
  { key: 'ring_shading', section: 'strata', type: 'bool', label: 'Wobbling ring shading', default: true,
    tip: 'Concentric shading rings that wobble inward and outward across the strata.' },

  { key: 'ambient_count', section: 'ambient', type: 'number', label: 'Ambient strata count', min: 0, max: 12, step: 1, default: 3,
    tip: 'Maximum number of small ambient strata that rise and fall at random places in the calm parts of the ring. 0 turns them off.' },
  { key: 'ambient_size', section: 'ambient', type: 'number', label: 'Ambient stratum size', min: 0, max: 1, step: 0.01, default: 0.3,
    tip: 'Maximum height of one ambient stratum.' },
  { key: 'ambient_width', section: 'ambient', type: 'number', label: 'Ambient stratum width', min: 0.3, max: 2.5, step: 0.05, default: 1,
    tip: 'Width of one ambient stratum.' },
  { key: 'ambient_lifetime', section: 'ambient', type: 'number', label: 'Ambient stratum lifetime (s)', min: 4, max: 300, step: 1, default: 25,
    tip: 'Seconds one ambient stratum takes to rise and fall again.' },

  { key: 'divergence_threshold', section: 'divergence', type: 'number', label: 'Divergence threshold (0–1)', min: 0, max: 1, step: 0.01, default: 0.15,
    tip: 'Fraction (0-1) of the way from baseline to critical where a callout changes to DIVERGENCE.' },
  { key: 'monitoring_threshold', section: 'divergence', type: 'number', label: 'Monitoring threshold (0–1, empty = none)', min: 0, max: 1, step: 0.01,
    nullable: true, unsetAt: c => c.divergence_threshold ?? 0.15, placeholder: 'None', defaultText: 'none',
    tip: 'Fraction (0-1) of the way from baseline to critical where a callout appears as MONITORING. Leave empty for no monitoring state.' },
  { key: 'transition_tau', section: 'divergence', type: 'number', label: 'Transition smoothing (s)', min: 0.2, max: 20, step: 0.1, default: 2.2,
    tip: 'Time constant in seconds of the smooth change when a value changes. Higher values give slower, calmer motion.' },

  { key: 'language', section: 'text', type: 'select', label: 'Language', default: '', defaultText: 'auto',
    options: [['', 'Auto (Home Assistant)'], ['en', 'English'], ['de', 'Deutsch'], ['fr', 'Français'], ['es', 'Español'], ['nl', 'Nederlands'], ['it', 'Italiano']],
    tip: 'Language of the callout text and the value format. Auto follows the Home Assistant language.' },
  { key: 'monitoring_label', section: 'text', type: 'text', label: 'Monitoring text', defaultText: 'MONITORING, translated',
    tip: 'Text before the category on a monitoring callout. Empty uses the translation for the card language.' },
  { key: 'divergence_label', section: 'text', type: 'text', label: 'Divergence text', defaultText: 'DIVERGENCE, translated',
    tip: 'Text before the category on a diverging callout. Empty uses the translation for the card language.' },
  { key: 'font_family', section: 'text', type: 'text', label: 'Label font (CSS font-family)', placeholder: 'Barlow Condensed (default)', defaultText: 'Barlow Condensed',
    tip: 'CSS font family of the callout labels. The default Barlow Condensed loads from Google Fonts. Set a local font to keep the card offline.' },
  { key: 'font_size', section: 'text', type: 'number', label: 'Label font size (px)', min: 8, max: 32, step: 0.5, default: DEFAULT_FONT_SIZE,
    tip: 'Size of the callout label text in px. The leader lines and label spacing scale with it.' },

  { key: 'hold_time', section: 'interaction', type: 'number', label: 'Hold duration (ms)', min: 150, max: 5000, step: 50, default: DEFAULT_HOLD_MS,
    tip: 'Milliseconds a press must last to count as a hold. Applies to the centre and to the callouts.' },
  { key: 'center_entity', section: 'interaction', type: 'entity', label: 'Centre entity', placeholder: 'sensor.anything', defaultText: 'none',
    tip: 'Entity that the centre actions use, for example for more-info or toggle.' },
  { key: 'center_tap_action', section: 'interaction', type: 'action', label: 'Centre tap action', defaultText: 'none',
    tip: 'Action when you tap the centre of the ring. For a browser_mod popup use fire-dom-event with a browser_mod block in YAML.' },
  { key: 'center_hold_action', section: 'interaction', type: 'action', label: 'Centre hold action', defaultText: 'none',
    tip: 'Action when you press and hold the centre of the ring.' },

  { key: 'resolution_scale', section: 'performance', type: 'number', label: 'Resolution scale', min: 0.25, max: 1, step: 0.05, default: 0.65,
    tip: 'Render resolution relative to the screen. Lower values save GPU time on slow tablets.' },
  { key: 'fps_idle', section: 'performance', type: 'number', label: 'Idle FPS', min: 5, max: 60, step: 1, default: 24,
    tip: 'Frame rate while all entities are calm.' },
  { key: 'fps_active', section: 'performance', type: 'number', label: 'Active FPS', min: 10, max: 120, step: 1, default: 45,
    tip: 'Frame rate while an entity diverges or a value changes.' }
];
// Groups of the entity settings, in editor order
const ENTITY_GROUPS = [
  { id: 'source', title: 'Entity' },
  { id: 'range', title: 'Value range' },
  { id: 'callout', title: 'Callout' },
  { id: 'actions', title: 'Actions' }
];
// Entity settings, in editor order. 'plain' is a number box without a slider (no fixed range);
// 'threshold' is a slider that spans baseline to critical (0-1 with a state map); 'map' is a list
// of state -> divergence rows.
const ENTITY_SETTINGS = [
  { key: 'entity', group: 'source', type: 'entity', label: 'Entity ID', required: true, placeholder: 'sensor.living_room_temperature',
    tip: 'Home Assistant entity that drives this callout.' },
  { key: 'name', group: 'source', type: 'text', label: 'Name', placeholder: 'Friendly name of the entity', defaultText: 'Friendly name',
    tip: 'Label text on the callout. Empty uses the friendly name of the entity.' },
  { key: 'category', group: 'source', type: 'text', label: 'Category', placeholder: 'SYSTEM ANOMALY', defaultText: 'SYSTEM ANOMALY, translated',
    tip: 'Header text above the label, for example THERMAL VARIANCE.' },
  { key: 'unit', group: 'source', type: 'text', label: 'Unit', placeholder: 'Unit of the entity', defaultText: 'Entity unit',
    tip: 'Unit shown after the value. Empty uses the unit of the entity.' },
  { key: 'baseline', group: 'range', type: 'plain', label: 'Baseline (divergence 0)', default: 0,
    tip: 'Value at which the entity is calm (divergence 0).' },
  { key: 'critical', group: 'range', type: 'plain', label: 'Critical (divergence 1)', default: 100,
    tip: 'Value at which the entity is fully diverged (divergence 1). If it is below the baseline, lower values diverge.' },
  { key: 'state_map', group: 'range', type: 'map', label: 'State map', defaultText: 'none',
    tip: 'Divergence (0-1) for each listed state, for example home 0 and not_home 1. A listed state ignores baseline and critical. With a map, the entity thresholds are divergence values (0-1).' },
  { key: 'angle', group: 'callout', type: 'number', label: 'Angle (°, empty = auto)', min: 0, max: 360, step: 1, nullable: true, placeholder: 'Auto', defaultText: 'auto-spaced',
    tip: 'Position of the callout on the ring in degrees (0 = right, counter-clockwise). Leave empty to space the callouts evenly.' },
  { key: 'monitoring_threshold', group: 'callout', type: 'threshold', label: 'Monitoring threshold (sensor value)', mapLabel: 'Monitoring threshold (0–1)',
    nullable: true, placeholder: 'Card', defaultText: 'card setting',
    tip: 'Sensor value where this callout appears as MONITORING; with a state map, a divergence value (0-1). Leave empty to use the card setting.' },
  { key: 'divergence_threshold', group: 'callout', type: 'threshold', label: 'Divergence threshold (sensor value)', mapLabel: 'Divergence threshold (0–1)',
    nullable: true, placeholder: 'Card', defaultText: 'card setting',
    tip: 'Sensor value where this callout changes to DIVERGENCE; with a state map, a divergence value (0-1). Leave empty to use the card setting.' },
  { key: 'always_visible', group: 'callout', type: 'bool', label: 'Always visible callout', default: false,
    tip: 'Show the callout as MONITORING also when it would be hidden.' },
  { key: 'tap_action', group: 'actions', type: 'action', label: 'Tap action', defaultText: 'more-info',
    tip: 'Action when you tap this callout. The default opens more-info.' },
  { key: 'hold_action', group: 'actions', type: 'action', label: 'Hold action', defaultText: 'none',
    tip: 'Action when you press and hold this callout.' }
];
// ---- Localization ----
// English lives in the settings list above. Each translation gives, per setting key,
// [label, tooltip, placeholder, label with a state map]; missing entries fall back to English.
// To add a language: copy one block, translate it, and add the language to LANGUAGES.
const LANGUAGES = [['en', 'English'], ['de', 'Deutsch'], ['fr', 'Français'], ['es', 'Español'], ['nl', 'Nederlands'], ['it', 'Italiano']];
// Text the card itself shows
const CARD_TEXT = { monitoring: 'MONITORING', divergence: 'DIVERGENCE', category: 'SYSTEM ANOMALY', unavailable: 'UNAVAILABLE' };
// Text of the visual editor outside the settings list
const UI_TEXT = {
  entities: 'Entities',
  expandAll: 'Expand all',
  collapseAll: 'Collapse all',
  addEntity: '+ Add entity',
  remove: 'Remove',
  addState: '+ Add state',
  unconfigured: 'Unconfigured',
  yamlOnly: 'Set {key} in the YAML editor.',
  entitiesHint: 'If critical is above baseline, high values diverge. If critical is below baseline (for example battery: baseline 100, critical 20), low values diverge. Below the monitoring threshold a callout is hidden ({monitoring} if always visible), from the monitoring threshold it shows {monitoring}, from the divergence threshold {divergence}.',
  state: 'State',
  divergenceOf: 'Divergence of {state}',
  removeState: 'Remove {state}'
};
const TRANSLATIONS = {
  de: {
    card: { monitoring: 'ÜBERWACHUNG', divergence: 'DIVERGENZ', category: 'SYSTEMANOMALIE', unavailable: 'NICHT VERFÜGBAR' },
    ui: {
      entities: 'Entitäten', expandAll: 'Alle aufklappen', collapseAll: 'Alle zuklappen', addEntity: '+ Entität hinzufügen',
      remove: 'Entfernen', addState: '+ Zustand hinzufügen', unconfigured: 'Nicht konfiguriert', yamlOnly: 'Lege {key} im YAML-Editor fest.',
      entitiesHint: 'Liegt der kritische Wert über dem Grundwert, divergieren hohe Werte. Liegt er darunter (zum Beispiel Akku: Grundwert 100, kritisch 20), divergieren niedrige Werte. Unter der Überwachungsschwelle ist eine Beschriftung verborgen ({monitoring}, wenn immer sichtbar), ab der Überwachungsschwelle zeigt sie {monitoring}, ab der Divergenzschwelle {divergence}.',
      state: 'Zustand', divergenceOf: 'Divergenz von {state}', removeState: '{state} entfernen'
    },
    sections: {
      title: "Titel", title_hint: "Der Untertitel unterstützt Home-Assistant-Templates, zum Beispiel {{ states(\"sensor.temperatur\") }} °C.",
      appearance: "Darstellung", eclipse: "Eklipse", peak: "Gipfel", strata: "Schichten und Wellen", ambient: "Umgebungsschichten",
      divergence: "Divergenz", text: "Beschriftungstext", interaction: "Bedienung", performance: "Leistung",
      interaction_hint: "Tippe auf die Mitte des Rings oder auf eine Beschriftung oder halte sie gedrückt. Für ein browser_mod-Popup nutze die Aktion „fire-dom-event“ mit einem browser_mod-Block in YAML."
    },
    entityGroups: { source: "Entität", range: "Wertebereich", callout: "Beschriftung", actions: "Aktionen" },
    options: { theme_mode: { dark: 'Dunkel', light: 'Hell', auto: 'Auto' }, language: { '': 'Auto (Home Assistant)' } },
    settings: {
      title: ["Titel", "Text in der linken oberen Ecke der Karte. Leer zeigt keinen Titel."],
      subtitle: ["Untertitel", "Text unter dem Titel. Unterstützt Home-Assistant-Templates, zum Beispiel {{ states(\"sensor.aussentemperatur\") }}; die Karte aktualisiert ihn, wenn sich das Ergebnis ändert."],
      theme_mode: ['Design', 'Dunkel zeigt eine nächtliche Eklipse, hell zeigt Tinte auf Papier. Auto folgt dem Dunkelmodus von Home Assistant.'],
      eclipse_angle: ['Eklipsenwinkel (°, leer = folgen)', 'Richtung des Eklipsenleuchtens in Grad (0 = rechts, gegen den Uhrzeigersinn). Leer lassen, damit sich das Leuchten zur Entität mit der größten Divergenz dreht.', 'Folgen'],
      eclipse_intensity: ['Eklipsenintensität', 'Helligkeit der Eklipsensichel und ihrer Korona.'],
      ray_intensity: ['Koronastrahlen', 'Stärke der feinen Strahlen, die vom Ring nach außen schimmern.'],
      test_divergence: ['Testdivergenz (leer = live)', 'Nur zur Vorschau: setzt das Eklipsenleuchten auf diese Divergenz. Leer lassen, um die Live-Werte zu nutzen.', 'Live'],
      amplitude_scale: ['Wellenamplitude', 'Höhenfaktor für alle Wellen und Schichten.'],
      peak_width: ['Gipfelbreite', 'Breite des Gipfels, der über einer divergierenden Entität aufsteigt.'],
      peak_sharpness: ['Gipfelschärfe (0 = Kuppel, 1 = Spitze)', 'Form des Gipfels: 0 ist eine abgeflachte Kuppel, 1 eine scharfe Spitze.'],
      peak_height: ['Gipfelhöhe', 'Wie weit der Gipfel über die Schichten darunter hinausragt.'],
      strata_width: ['Schichtbreite', 'Breite der Schichten unter jedem Gipfel.'],
      baseline_height: ['Grundwellenhöhe (0 = glatter Ring)', 'Höhe des schmalen Wellenbands um den ganzen Ring. 0 ergibt einen glatten Ring.'],
      facet_shading: ['Faltenschattierung', 'Stärke der Faltenschatten, die die Schichten plastisch wirken lassen.'],
      ring_shading: ['Wogende Ringschattierung', 'Konzentrische Schattierungsringe, die über die Schichten nach innen und außen wogen.'],
      ambient_count: ['Anzahl Umgebungsschichten', 'Höchstzahl kleiner Umgebungsschichten, die an zufälligen Stellen in ruhigen Teilen des Rings auf- und absteigen. 0 schaltet sie ab.'],
      ambient_size: ['Größe Umgebungsschicht', 'Maximale Höhe einer Umgebungsschicht.'],
      ambient_width: ['Breite Umgebungsschicht', 'Breite einer Umgebungsschicht.'],
      ambient_lifetime: ['Lebensdauer Umgebungsschicht (s)', 'Sekunden, die eine Umgebungsschicht zum Auf- und Absteigen braucht.'],
      divergence_threshold: ['Divergenzschwelle (0–1)', 'Anteil (0-1) des Wegs vom Grundwert zum kritischen Wert, ab dem eine Beschriftung zu DIVERGENZ wechselt.'],
      monitoring_threshold: ['Überwachungsschwelle (0–1, leer = keine)', 'Anteil (0-1) des Wegs vom Grundwert zum kritischen Wert, ab dem eine Beschriftung als ÜBERWACHUNG erscheint. Leer lassen für keinen Überwachungszustand.', 'Keine'],
      transition_tau: ['Übergangsglättung (s)', 'Zeitkonstante in Sekunden für den weichen Übergang, wenn sich ein Wert ändert. Höhere Werte ergeben langsamere, ruhigere Bewegung.'],
      language: ['Sprache', 'Sprache der Beschriftungstexte und der Wertformatierung. Auto folgt der Sprache von Home Assistant.'],
      monitoring_label: ['Text für Überwachung', 'Text vor der Kategorie einer Beschriftung im Überwachungszustand. Leer nutzt die Übersetzung der Kartensprache.'],
      divergence_label: ['Text für Divergenz', 'Text vor der Kategorie einer Beschriftung im Divergenzzustand. Leer nutzt die Übersetzung der Kartensprache.'],
      font_family: ['Beschriftungsschrift (CSS font-family)', 'CSS-Schriftfamilie der Beschriftungen. Die Standardschrift Barlow Condensed lädt von Google Fonts. Setze eine lokale Schrift, damit die Karte offline bleibt.', 'Barlow Condensed (Standard)'],
      font_size: ['Schriftgröße (px)', 'Größe des Beschriftungstexts in px. Führungslinien und Abstände skalieren mit.'],
      hold_time: ['Haltedauer (ms)', 'Millisekunden, die ein Druck dauern muss, um als Halten zu gelten. Gilt für die Mitte und die Beschriftungen.'],
      center_entity: ['Entität der Mitte', 'Entität, die die Aktionen der Mitte nutzen, zum Beispiel für Mehr-Info oder Umschalten.'],
      center_tap_action: ['Tippaktion der Mitte', 'Aktion beim Tippen auf die Mitte des Rings. Für ein browser_mod-Popup nutze fire-dom-event mit einem browser_mod-Block in YAML.'],
      center_hold_action: ['Halteaktion der Mitte', 'Aktion beim Drücken und Halten der Ringmitte.'],
      height: ['Kartenhöhe (CSS)', 'Kartenhöhe in CSS-Einheiten, zum Beispiel 500px oder 100vh für eine Vollbild-Panelansicht.'],
      ring_scale: ['Ringgröße', 'Ringradius relativ zur Kartengröße.'],
      resolution_scale: ['Auflösungsfaktor', 'Renderauflösung relativ zum Bildschirm. Kleinere Werte sparen GPU-Zeit auf langsamen Tablets.'],
      fps_idle: ['FPS im Ruhezustand', 'Bildrate, solange alle Entitäten ruhig sind.'],
      fps_active: ['FPS bei Aktivität', 'Bildrate, solange eine Entität divergiert oder sich ein Wert ändert.']
    },
    entity: {
      entity: ['Entitäts-ID', 'Home-Assistant-Entität, die diese Beschriftung steuert.'],
      name: ['Name', 'Text der Beschriftung. Leer nutzt den Anzeigenamen der Entität.', 'Anzeigename der Entität'],
      category: ['Kategorie', 'Kopfzeile über dem Namen, zum Beispiel THERMISCHE ABWEICHUNG.'],
      baseline: ['Grundwert (Divergenz 0)', 'Wert, bei dem die Entität ruhig ist (Divergenz 0).'],
      critical: ['Kritischer Wert (Divergenz 1)', 'Wert, bei dem die Entität voll divergiert (Divergenz 1). Liegt er unter dem Grundwert, divergieren niedrigere Werte.'],
      state_map: ['Zustandszuordnung', 'Divergenz (0-1) für jeden aufgeführten Zustand, zum Beispiel home 0 und not_home 1. Ein aufgeführter Zustand ignoriert Grundwert und kritischen Wert. Mit einer Zuordnung sind die Entitätsschwellen Divergenzwerte (0-1).'],
      unit: ['Einheit', 'Einheit hinter dem Wert. Leer nutzt die Einheit der Entität.', 'Einheit der Entität'],
      angle: ['Winkel (°, leer = auto)', 'Position der Beschriftung auf dem Ring in Grad (0 = rechts, gegen den Uhrzeigersinn). Leer lassen, um die Beschriftungen gleichmäßig zu verteilen.', 'Auto'],
      monitoring_threshold: ['Überwachungsschwelle (Sensorwert)', 'Sensorwert, ab dem diese Beschriftung als ÜBERWACHUNG erscheint; mit einer Zustandszuordnung ein Divergenzwert (0-1). Leer nutzt die Karteneinstellung.', 'Karte', 'Überwachungsschwelle (0–1)'],
      divergence_threshold: ['Divergenzschwelle (Sensorwert)', 'Sensorwert, ab dem diese Beschriftung zu DIVERGENZ wechselt; mit einer Zustandszuordnung ein Divergenzwert (0-1). Leer nutzt die Karteneinstellung.', 'Karte', 'Divergenzschwelle (0–1)'],
      always_visible: ['Beschriftung immer sichtbar', 'Zeigt die Beschriftung als ÜBERWACHUNG, auch wenn sie sonst verborgen wäre.'],
      tap_action: ['Tippaktion', 'Aktion beim Tippen auf diese Beschriftung. Standard öffnet Mehr-Info.'],
      hold_action: ['Halteaktion', 'Aktion beim Drücken und Halten dieser Beschriftung.']
    }
  },
  fr: {
    card: { monitoring: 'SURVEILLANCE', divergence: 'DIVERGENCE', category: 'ANOMALIE SYSTÈME', unavailable: 'INDISPONIBLE' },
    ui: {
      entities: 'Entités', expandAll: 'Tout déplier', collapseAll: 'Tout replier', addEntity: '+ Ajouter une entité',
      remove: 'Supprimer', addState: '+ Ajouter un état', unconfigured: 'Non configurée', yamlOnly: "Définissez {key} dans l'éditeur YAML.",
      entitiesHint: 'Si la valeur critique est au-dessus de la valeur de base, les valeurs hautes divergent. Si elle est en dessous (par exemple batterie : base 100, critique 20), les valeurs basses divergent. Sous le seuil de surveillance, une étiquette est masquée ({monitoring} si toujours visible) ; à partir du seuil de surveillance elle affiche {monitoring}, à partir du seuil de divergence {divergence}.',
      state: 'État', divergenceOf: 'Divergence de {state}', removeState: 'Supprimer {state}'
    },
    sections: {
      title: "Titre", title_hint: "Le sous-titre accepte les modèles Home Assistant, par exemple {{ states(\"sensor.temperature\") }} °C.",
      appearance: "Apparence", eclipse: "Éclipse", peak: "Pic", strata: "Strates et vagues", ambient: "Strates ambiantes",
      divergence: "Divergence", text: "Texte des étiquettes", interaction: "Interaction", performance: "Performances",
      interaction_hint: "Appuyez ou maintenez le centre de l'anneau ou une étiquette. Pour une fenêtre browser_mod, utilisez l'action « fire-dom-event » avec un bloc browser_mod en YAML."
    },
    entityGroups: { source: "Entité", range: "Plage de valeurs", callout: "Étiquette", actions: "Actions" },
    options: { theme_mode: { dark: 'Sombre', light: 'Clair', auto: 'Auto' }, language: { '': 'Auto (Home Assistant)' } },
    settings: {
      title: ["Titre", "Texte dans le coin supérieur gauche de la carte. Vide n'affiche aucun titre."],
      subtitle: ["Sous-titre", "Texte sous le titre. Accepte les modèles Home Assistant, par exemple {{ states(\"sensor.outside_temperature\") }} ; la carte le met à jour quand le résultat change."],
      theme_mode: ['Thème', "Sombre affiche une éclipse de nuit, clair de l'encre sur papier. Auto suit le mode sombre de Home Assistant."],
      eclipse_angle: ["Angle de l'éclipse (°, vide = suivre)", "Direction de la lueur de l'éclipse en degrés (0 = droite, sens antihoraire). Laissez vide pour tourner la lueur vers l'entité la plus divergente.", 'Suivre'],
      eclipse_intensity: ["Intensité de l'éclipse", "Luminosité du croissant de l'éclipse et de sa couronne."],
      ray_intensity: ['Rayons de la couronne', "Force des fins rayons qui scintillent vers l'extérieur de l'anneau."],
      test_divergence: ['Divergence de test (vide = direct)', "Aperçu uniquement : force la lueur de l'éclipse à cette divergence. Laissez vide pour utiliser les valeurs en direct.", 'Direct'],
      amplitude_scale: ['Amplitude des vagues', 'Multiplicateur de hauteur pour toutes les vagues et strates.'],
      peak_width: ['Largeur du pic', "Largeur du pic qui s'élève au-dessus d'une entité divergente."],
      peak_sharpness: ['Netteté du pic (0 = dôme, 1 = pointe)', 'Forme du pic : 0 est un dôme aplati, 1 une pointe aiguë.'],
      peak_height: ['Proéminence du pic', 'À quel point le pic dépasse les strates en dessous.'],
      strata_width: ['Largeur des strates', 'Largeur des strates sous chaque pic.'],
      baseline_height: ['Hauteur des vagues de base (0 = anneau lisse)', "Hauteur de la fine bande de vagues autour de tout l'anneau. 0 donne un anneau lisse."],
      facet_shading: ['Ombrage des plis', 'Force des ombres de plis qui donnent du relief aux strates.'],
      ring_shading: ["Ombrage d'anneaux ondulants", "Anneaux d'ombrage concentriques qui ondulent vers l'intérieur et l'extérieur sur les strates."],
      ambient_count: ['Nombre de strates ambiantes', "Nombre maximal de petites strates ambiantes qui montent et descendent à des endroits aléatoires des zones calmes de l'anneau. 0 les désactive."],
      ambient_size: ["Taille d'une strate ambiante", "Hauteur maximale d'une strate ambiante."],
      ambient_width: ["Largeur d'une strate ambiante", "Largeur d'une strate ambiante."],
      ambient_lifetime: ["Durée d'une strate ambiante (s)", 'Secondes nécessaires à une strate ambiante pour monter et redescendre.'],
      divergence_threshold: ['Seuil de divergence (0–1)', 'Fraction (0-1) du chemin entre la valeur de base et la valeur critique à partir de laquelle une étiquette passe à DIVERGENCE.'],
      monitoring_threshold: ['Seuil de surveillance (0–1, vide = aucun)', "Fraction (0-1) du chemin entre la valeur de base et la valeur critique à partir de laquelle une étiquette apparaît en SURVEILLANCE. Laissez vide pour aucun état de surveillance.", 'Aucun'],
      transition_tau: ['Lissage des transitions (s)', "Constante de temps en secondes du changement progressif d'une valeur. Des valeurs plus élevées donnent un mouvement plus lent et plus calme."],
      language: ['Langue', 'Langue des textes des étiquettes et du format des valeurs. Auto suit la langue de Home Assistant.'],
      monitoring_label: ['Texte de surveillance', "Texte avant la catégorie d'une étiquette en surveillance. Vide utilise la traduction de la langue de la carte."],
      divergence_label: ['Texte de divergence', "Texte avant la catégorie d'une étiquette en divergence. Vide utilise la traduction de la langue de la carte."],
      font_family: ['Police des étiquettes (CSS font-family)', 'Famille de polices CSS des étiquettes. La police par défaut Barlow Condensed se charge depuis Google Fonts. Choisissez une police locale pour garder la carte hors ligne.', 'Barlow Condensed (par défaut)'],
      font_size: ['Taille de police (px)', 'Taille du texte des étiquettes en px. Les lignes de rappel et les espacements suivent.'],
      hold_time: ["Durée d'appui (ms)", "Millisecondes qu'un appui doit durer pour compter comme maintien. S'applique au centre et aux étiquettes."],
      center_entity: ['Entité du centre', "Entité utilisée par les actions du centre, par exemple pour plus d'infos ou basculer."],
      center_tap_action: ["Action d'appui du centre", "Action lors d'un appui sur le centre de l'anneau. Pour une fenêtre browser_mod, utilisez fire-dom-event avec un bloc browser_mod en YAML."],
      center_hold_action: ['Action de maintien du centre', "Action lors d'un appui long sur le centre de l'anneau."],
      height: ['Hauteur de la carte (CSS)', 'Hauteur de la carte en unités CSS, par exemple 500px, ou 100vh pour une vue panneau plein écran.'],
      ring_scale: ["Taille de l'anneau", "Rayon de l'anneau par rapport à la taille de la carte."],
      resolution_scale: ['Échelle de résolution', "Résolution de rendu par rapport à l'écran. Des valeurs plus faibles économisent du temps GPU sur les tablettes lentes."],
      fps_idle: ['FPS au repos', "Fréquence d'images quand toutes les entités sont calmes."],
      fps_active: ['FPS en activité', "Fréquence d'images quand une entité diverge ou qu'une valeur change."]
    },
    entity: {
      entity: ["ID d'entité", 'Entité Home Assistant qui pilote cette étiquette.'],
      name: ['Nom', "Texte de l'étiquette. Vide utilise le nom convivial de l'entité.", "Nom convivial de l'entité"],
      category: ['Catégorie', 'En-tête au-dessus du nom, par exemple VARIATION THERMIQUE.'],
      baseline: ['Valeur de base (divergence 0)', "Valeur à laquelle l'entité est calme (divergence 0)."],
      critical: ['Valeur critique (divergence 1)', "Valeur à laquelle l'entité diverge complètement (divergence 1). Si elle est inférieure à la valeur de base, les valeurs plus basses divergent."],
      state_map: ["Correspondance d'états", "Divergence (0-1) de chaque état listé, par exemple home 0 et not_home 1. Un état listé ignore la valeur de base et la valeur critique. Avec une correspondance, les seuils de l'entité sont des valeurs de divergence (0-1)."],
      unit: ['Unité', "Unité affichée après la valeur. Vide utilise l'unité de l'entité.", "Unité de l'entité"],
      angle: ['Angle (°, vide = auto)', "Position de l'étiquette sur l'anneau en degrés (0 = droite, sens antihoraire). Laissez vide pour répartir les étiquettes régulièrement.", 'Auto'],
      monitoring_threshold: ['Seuil de surveillance (valeur du capteur)', "Valeur du capteur à partir de laquelle cette étiquette apparaît en SURVEILLANCE ; avec une correspondance d'états, une valeur de divergence (0-1). Vide utilise le réglage de la carte.", 'Carte', 'Seuil de surveillance (0–1)'],
      divergence_threshold: ['Seuil de divergence (valeur du capteur)', "Valeur du capteur à partir de laquelle cette étiquette passe à DIVERGENCE ; avec une correspondance d'états, une valeur de divergence (0-1). Vide utilise le réglage de la carte.", 'Carte', 'Seuil de divergence (0–1)'],
      always_visible: ['Étiquette toujours visible', "Affiche l'étiquette en SURVEILLANCE même quand elle serait masquée."],
      tap_action: ["Action d'appui", "Action lors d'un appui sur cette étiquette. Par défaut, ouvre plus d'infos."],
      hold_action: ['Action de maintien', "Action lors d'un appui long sur cette étiquette."]
    }
  },
  es: {
    card: { monitoring: 'MONITORIZACIÓN', divergence: 'DIVERGENCIA', category: 'ANOMALÍA DEL SISTEMA', unavailable: 'NO DISPONIBLE' },
    ui: {
      entities: 'Entidades', expandAll: 'Desplegar todo', collapseAll: 'Plegar todo', addEntity: '+ Añadir entidad',
      remove: 'Eliminar', addState: '+ Añadir estado', unconfigured: 'Sin configurar', yamlOnly: 'Define {key} en el editor YAML.',
      entitiesHint: 'Si el valor crítico está por encima del valor base, divergen los valores altos. Si está por debajo (por ejemplo batería: base 100, crítico 20), divergen los valores bajos. Por debajo del umbral de monitorización la etiqueta está oculta ({monitoring} si es siempre visible); desde el umbral de monitorización muestra {monitoring} y desde el umbral de divergencia {divergence}.',
      state: 'Estado', divergenceOf: 'Divergencia de {state}', removeState: 'Eliminar {state}'
    },
    sections: {
      title: "Título", title_hint: "El subtítulo admite plantillas de Home Assistant, por ejemplo {{ states(\"sensor.temperature\") }} °C.",
      appearance: "Apariencia", eclipse: "Eclipse", peak: "Pico", strata: "Estratos y ondas", ambient: "Estratos ambientales",
      divergence: "Divergencia", text: "Texto de las etiquetas", interaction: "Interacción", performance: "Rendimiento",
      interaction_hint: "Toca o mantén pulsado el centro del anillo o una etiqueta. Para una ventana de browser_mod usa la acción \"fire-dom-event\" con un bloque browser_mod en YAML."
    },
    entityGroups: { source: "Entidad", range: "Rango de valores", callout: "Etiqueta", actions: "Acciones" },
    options: { theme_mode: { dark: 'Oscuro', light: 'Claro', auto: 'Auto' }, language: { '': 'Auto (Home Assistant)' } },
    settings: {
      title: ["Título", "Texto en la esquina superior izquierda de la tarjeta. Vacío no muestra título."],
      subtitle: ["Subtítulo", "Texto bajo el título. Admite plantillas de Home Assistant, por ejemplo {{ states(\"sensor.outside_temperature\") }}; la tarjeta lo actualiza cuando cambia el resultado."],
      theme_mode: ['Tema', 'Oscuro muestra un eclipse nocturno, claro muestra tinta sobre papel. Auto sigue el modo oscuro de Home Assistant.'],
      eclipse_angle: ['Ángulo del eclipse (°, vacío = seguir)', 'Dirección del brillo del eclipse en grados (0 = derecha, sentido antihorario). Déjalo vacío para girar el brillo hacia la entidad con más divergencia.', 'Seguir'],
      eclipse_intensity: ['Intensidad del eclipse', 'Brillo de la media luna del eclipse y de su corona.'],
      ray_intensity: ['Rayos de la corona', 'Intensidad de los finos rayos que brillan hacia fuera del anillo.'],
      test_divergence: ['Divergencia de prueba (vacío = en vivo)', 'Solo vista previa: fija el brillo del eclipse en esta divergencia. Déjalo vacío para usar los valores en vivo.', 'En vivo'],
      amplitude_scale: ['Amplitud de las ondas', 'Multiplicador de altura para todas las ondas y estratos.'],
      peak_width: ['Anchura del pico', 'Anchura del pico que se eleva sobre una entidad divergente.'],
      peak_sharpness: ['Agudeza del pico (0 = cúpula, 1 = punta)', 'Forma del pico: 0 es una cúpula achatada, 1 una punta afilada.'],
      peak_height: ['Prominencia del pico', 'Cuánto sobresale el pico de los estratos que tiene debajo.'],
      strata_width: ['Anchura de los estratos', 'Anchura de los estratos bajo cada pico.'],
      baseline_height: ['Altura de las ondas base (0 = anillo liso)', 'Altura de la fina banda de ondas alrededor de todo el anillo. 0 da un anillo liso.'],
      facet_shading: ['Sombreado de pliegues', 'Intensidad de las sombras de pliegues que dan relieve a los estratos.'],
      ring_shading: ['Sombreado de anillos ondulantes', 'Anillos de sombreado concéntricos que ondulan hacia dentro y hacia fuera sobre los estratos.'],
      ambient_count: ['Número de estratos ambientales', 'Número máximo de pequeños estratos ambientales que suben y bajan en lugares aleatorios de las zonas tranquilas del anillo. 0 los desactiva.'],
      ambient_size: ['Tamaño de un estrato ambiental', 'Altura máxima de un estrato ambiental.'],
      ambient_width: ['Anchura de un estrato ambiental', 'Anchura de un estrato ambiental.'],
      ambient_lifetime: ['Duración de un estrato ambiental (s)', 'Segundos que tarda un estrato ambiental en subir y volver a bajar.'],
      divergence_threshold: ['Umbral de divergencia (0–1)', 'Fracción (0-1) del camino entre el valor base y el crítico a partir de la cual una etiqueta pasa a DIVERGENCIA.'],
      monitoring_threshold: ['Umbral de monitorización (0–1, vacío = ninguno)', 'Fracción (0-1) del camino entre el valor base y el crítico a partir de la cual una etiqueta aparece como MONITORIZACIÓN. Déjalo vacío para no tener estado de monitorización.', 'Ninguno'],
      transition_tau: ['Suavizado de transiciones (s)', 'Constante de tiempo en segundos del cambio suave cuando cambia un valor. Valores más altos dan un movimiento más lento y tranquilo.'],
      language: ['Idioma', 'Idioma de los textos de las etiquetas y del formato de los valores. Auto sigue el idioma de Home Assistant.'],
      monitoring_label: ['Texto de monitorización', 'Texto antes de la categoría en una etiqueta en monitorización. Vacío usa la traducción del idioma de la tarjeta.'],
      divergence_label: ['Texto de divergencia', 'Texto antes de la categoría en una etiqueta en divergencia. Vacío usa la traducción del idioma de la tarjeta.'],
      font_family: ['Fuente de las etiquetas (CSS font-family)', 'Familia de fuentes CSS de las etiquetas. La fuente predeterminada Barlow Condensed se carga desde Google Fonts. Usa una fuente local para que la tarjeta funcione sin conexión.', 'Barlow Condensed (predeterminada)'],
      font_size: ['Tamaño de fuente (px)', 'Tamaño del texto de las etiquetas en px. Las líneas guía y los espacios se ajustan con él.'],
      hold_time: ['Duración de pulsación (ms)', 'Milisegundos que debe durar una pulsación para contar como mantener. Se aplica al centro y a las etiquetas.'],
      center_entity: ['Entidad del centro', 'Entidad que usan las acciones del centro, por ejemplo para más información o alternar.'],
      center_tap_action: ['Acción al tocar el centro', 'Acción al tocar el centro del anillo. Para una ventana de browser_mod usa fire-dom-event con un bloque browser_mod en YAML.'],
      center_hold_action: ['Acción al mantener el centro', 'Acción al mantener pulsado el centro del anillo.'],
      height: ['Altura de la tarjeta (CSS)', 'Altura de la tarjeta en unidades CSS, por ejemplo 500px, o 100vh para una vista de panel a pantalla completa.'],
      ring_scale: ['Tamaño del anillo', 'Radio del anillo en relación con el tamaño de la tarjeta.'],
      resolution_scale: ['Escala de resolución', 'Resolución de renderizado en relación con la pantalla. Valores más bajos ahorran tiempo de GPU en tabletas lentas.'],
      fps_idle: ['FPS en reposo', 'Fotogramas por segundo mientras todas las entidades están tranquilas.'],
      fps_active: ['FPS en actividad', 'Fotogramas por segundo mientras una entidad diverge o cambia un valor.']
    },
    entity: {
      entity: ['ID de entidad', 'Entidad de Home Assistant que controla esta etiqueta.'],
      name: ['Nombre', 'Texto de la etiqueta. Vacío usa el nombre descriptivo de la entidad.', 'Nombre descriptivo de la entidad'],
      category: ['Categoría', 'Encabezado sobre el nombre, por ejemplo VARIACIÓN TÉRMICA.'],
      baseline: ['Valor base (divergencia 0)', 'Valor en el que la entidad está tranquila (divergencia 0).'],
      critical: ['Valor crítico (divergencia 1)', 'Valor en el que la entidad diverge por completo (divergencia 1). Si está por debajo del valor base, divergen los valores más bajos.'],
      state_map: ['Asignación de estados', 'Divergencia (0-1) de cada estado de la lista, por ejemplo home 0 y not_home 1. Un estado de la lista ignora el valor base y el crítico. Con una asignación, los umbrales de la entidad son valores de divergencia (0-1).'],
      unit: ['Unidad', 'Unidad que se muestra tras el valor. Vacío usa la unidad de la entidad.', 'Unidad de la entidad'],
      angle: ['Ángulo (°, vacío = auto)', 'Posición de la etiqueta en el anillo en grados (0 = derecha, sentido antihorario). Déjalo vacío para repartir las etiquetas de forma uniforme.', 'Auto'],
      monitoring_threshold: ['Umbral de monitorización (valor del sensor)', 'Valor del sensor a partir del cual esta etiqueta aparece como MONITORIZACIÓN; con una asignación de estados, un valor de divergencia (0-1). Vacío usa el ajuste de la tarjeta.', 'Tarjeta', 'Umbral de monitorización (0–1)'],
      divergence_threshold: ['Umbral de divergencia (valor del sensor)', 'Valor del sensor a partir del cual esta etiqueta pasa a DIVERGENCIA; con una asignación de estados, un valor de divergencia (0-1). Vacío usa el ajuste de la tarjeta.', 'Tarjeta', 'Umbral de divergencia (0–1)'],
      always_visible: ['Etiqueta siempre visible', 'Muestra la etiqueta como MONITORIZACIÓN también cuando estaría oculta.'],
      tap_action: ['Acción al tocar', 'Acción al tocar esta etiqueta. Por defecto abre más información.'],
      hold_action: ['Acción al mantener', 'Acción al mantener pulsada esta etiqueta.']
    }
  },
  nl: {
    card: { monitoring: 'BEWAKING', divergence: 'DIVERGENTIE', category: 'SYSTEEMAFWIJKING', unavailable: 'NIET BESCHIKBAAR' },
    ui: {
      entities: 'Entiteiten', expandAll: 'Alles uitklappen', collapseAll: 'Alles inklappen', addEntity: '+ Entiteit toevoegen',
      remove: 'Verwijderen', addState: '+ Status toevoegen', unconfigured: 'Niet ingesteld', yamlOnly: 'Stel {key} in via de YAML-editor.',
      entitiesHint: 'Ligt de kritieke waarde boven de basiswaarde, dan divergeren hoge waarden. Ligt die eronder (bijvoorbeeld batterij: basis 100, kritiek 20), dan divergeren lage waarden. Onder de bewakingsdrempel is een label verborgen ({monitoring} als altijd zichtbaar), vanaf de bewakingsdrempel toont het {monitoring} en vanaf de divergentiedrempel {divergence}.',
      state: 'Status', divergenceOf: 'Divergentie van {state}', removeState: '{state} verwijderen'
    },
    sections: {
      title: "Titel", title_hint: "De ondertitel ondersteunt Home Assistant-sjablonen, bijvoorbeeld {{ states(\"sensor.temperature\") }} °C.",
      appearance: "Weergave", eclipse: "Eclips", peak: "Piek", strata: "Lagen en golven", ambient: "Omgevingslagen",
      divergence: "Divergentie", text: "Labeltekst", interaction: "Bediening", performance: "Prestaties",
      interaction_hint: "Tik op het midden van de ring of op een label, of houd het ingedrukt. Gebruik voor een browser_mod-pop-up de actie \"fire-dom-event\" met een browser_mod-blok in YAML."
    },
    entityGroups: { source: "Entiteit", range: "Waardebereik", callout: "Label", actions: "Acties" },
    options: { theme_mode: { dark: 'Donker', light: 'Licht', auto: 'Auto' }, language: { '': 'Auto (Home Assistant)' } },
    settings: {
      title: ["Titel", "Tekst in de linkerbovenhoek van de kaart. Leeg toont geen titel."],
      subtitle: ["Ondertitel", "Tekst onder de titel. Ondersteunt Home Assistant-sjablonen, bijvoorbeeld {{ states(\"sensor.outside_temperature\") }}; de kaart werkt hem bij als het resultaat verandert."],
      theme_mode: ['Thema', 'Donker toont een nachtelijke eclips, licht toont inkt op papier. Auto volgt de donkere modus van Home Assistant.'],
      eclipse_angle: ['Eclipshoek (°, leeg = volgen)', 'Richting van de eclipsgloed in graden (0 = rechts, tegen de klok in). Laat leeg om de gloed naar de entiteit met de meeste divergentie te draaien.', 'Volgen'],
      eclipse_intensity: ['Eclipsintensiteit', 'Helderheid van de eclipssikkel en zijn corona.'],
      ray_intensity: ['Coronastralen', 'Sterkte van de dunne stralen die vanaf de ring naar buiten glinsteren.'],
      test_divergence: ['Testdivergentie (leeg = live)', 'Alleen voorbeeld: zet de eclipsgloed op deze divergentie. Laat leeg om de live waarden te gebruiken.', 'Live'],
      amplitude_scale: ['Golfamplitude', 'Hoogtefactor voor alle golven en lagen.'],
      peak_width: ['Piekbreedte', 'Breedte van de piek die boven een divergerende entiteit uitsteekt.'],
      peak_sharpness: ['Piekscherpte (0 = koepel, 1 = punt)', 'Vorm van de piek: 0 is een afgeplatte koepel, 1 een scherpe punt.'],
      peak_height: ['Piekhoogte', 'Hoe ver de piek boven de lagen eronder uitsteekt.'],
      strata_width: ['Laagbreedte', 'Breedte van de lagen onder elke piek.'],
      baseline_height: ['Basisgolfhoogte (0 = gladde ring)', 'Hoogte van de smalle golfband rond de hele ring. 0 geeft een gladde ring.'],
      facet_shading: ['Plooischaduw', 'Sterkte van de plooischaduwen die de lagen diepte geven.'],
      ring_shading: ['Golvende ringschaduw', 'Concentrische schaduwringen die over de lagen naar binnen en buiten golven.'],
      ambient_count: ['Aantal omgevingslagen', 'Maximaal aantal kleine omgevingslagen die op willekeurige plekken in rustige delen van de ring opkomen en wegzakken. 0 schakelt ze uit.'],
      ambient_size: ['Grootte omgevingslaag', 'Maximale hoogte van één omgevingslaag.'],
      ambient_width: ['Breedte omgevingslaag', 'Breedte van één omgevingslaag.'],
      ambient_lifetime: ['Levensduur omgevingslaag (s)', 'Seconden die één omgevingslaag nodig heeft om op te komen en weer weg te zakken.'],
      divergence_threshold: ['Divergentiedrempel (0–1)', 'Fractie (0-1) van de weg van basiswaarde naar kritieke waarde waarbij een label naar DIVERGENTIE gaat.'],
      monitoring_threshold: ['Bewakingsdrempel (0–1, leeg = geen)', 'Fractie (0-1) van de weg van basiswaarde naar kritieke waarde waarbij een label als BEWAKING verschijnt. Laat leeg voor geen bewakingsstatus.', 'Geen'],
      transition_tau: ['Overgangsdemping (s)', 'Tijdconstante in seconden van de vloeiende overgang als een waarde verandert. Hogere waarden geven een tragere, rustigere beweging.'],
      language: ['Taal', 'Taal van de labelteksten en de opmaak van waarden. Auto volgt de taal van Home Assistant.'],
      monitoring_label: ['Tekst voor bewaking', 'Tekst voor de categorie op een label in bewaking. Leeg gebruikt de vertaling voor de taal van de kaart.'],
      divergence_label: ['Tekst voor divergentie', 'Tekst voor de categorie op een label in divergentie. Leeg gebruikt de vertaling voor de taal van de kaart.'],
      font_family: ['Lettertype labels (CSS font-family)', 'CSS-lettertypefamilie van de labels. Het standaardlettertype Barlow Condensed laadt van Google Fonts. Kies een lokaal lettertype om de kaart offline te houden.', 'Barlow Condensed (standaard)'],
      font_size: ['Lettergrootte (px)', 'Grootte van de labeltekst in px. Verbindingslijnen en afstanden schalen mee.'],
      hold_time: ['Vasthoudduur (ms)', 'Milliseconden die een druk moet duren om als vasthouden te tellen. Geldt voor het midden en de labels.'],
      center_entity: ['Entiteit van het midden', 'Entiteit die de acties van het midden gebruiken, bijvoorbeeld voor meer info of schakelen.'],
      center_tap_action: ['Tikactie midden', 'Actie bij tikken op het midden van de ring. Gebruik voor een browser_mod-pop-up fire-dom-event met een browser_mod-blok in YAML.'],
      center_hold_action: ['Vasthoudactie midden', 'Actie bij ingedrukt houden van het midden van de ring.'],
      height: ['Kaarthoogte (CSS)', 'Kaarthoogte in CSS-eenheden, bijvoorbeeld 500px, of 100vh voor een paneelweergave op volledig scherm.'],
      ring_scale: ['Ringgrootte', 'Ringstraal ten opzichte van de kaartgrootte.'],
      resolution_scale: ['Resolutieschaal', 'Renderresolutie ten opzichte van het scherm. Lagere waarden besparen GPU-tijd op trage tablets.'],
      fps_idle: ['FPS in rust', 'Beeldsnelheid zolang alle entiteiten rustig zijn.'],
      fps_active: ['FPS bij activiteit', 'Beeldsnelheid zolang een entiteit divergeert of een waarde verandert.']
    },
    entity: {
      entity: ['Entiteit-ID', 'Home Assistant-entiteit die dit label aanstuurt.'],
      name: ['Naam', 'Tekst van het label. Leeg gebruikt de weergavenaam van de entiteit.', 'Weergavenaam van de entiteit'],
      category: ['Categorie', 'Kop boven de naam, bijvoorbeeld THERMISCHE AFWIJKING.'],
      baseline: ['Basiswaarde (divergentie 0)', 'Waarde waarbij de entiteit rustig is (divergentie 0).'],
      critical: ['Kritieke waarde (divergentie 1)', 'Waarde waarbij de entiteit volledig divergeert (divergentie 1). Ligt die onder de basiswaarde, dan divergeren lagere waarden.'],
      state_map: ['Statustoewijzing', 'Divergentie (0-1) voor elke vermelde status, bijvoorbeeld home 0 en not_home 1. Een vermelde status negeert basiswaarde en kritieke waarde. Met een toewijzing zijn de drempels van de entiteit divergentiewaarden (0-1).'],
      unit: ['Eenheid', 'Eenheid achter de waarde. Leeg gebruikt de eenheid van de entiteit.', 'Eenheid van de entiteit'],
      angle: ['Hoek (°, leeg = auto)', 'Positie van het label op de ring in graden (0 = rechts, tegen de klok in). Laat leeg om de labels gelijkmatig te verdelen.', 'Auto'],
      monitoring_threshold: ['Bewakingsdrempel (sensorwaarde)', 'Sensorwaarde waarbij dit label als BEWAKING verschijnt; met een statustoewijzing een divergentiewaarde (0-1). Leeg gebruikt de kaartinstelling.', 'Kaart', 'Bewakingsdrempel (0–1)'],
      divergence_threshold: ['Divergentiedrempel (sensorwaarde)', 'Sensorwaarde waarbij dit label naar DIVERGENTIE gaat; met een statustoewijzing een divergentiewaarde (0-1). Leeg gebruikt de kaartinstelling.', 'Kaart', 'Divergentiedrempel (0–1)'],
      always_visible: ['Label altijd zichtbaar', 'Toont het label als BEWAKING, ook als het anders verborgen zou zijn.'],
      tap_action: ['Tikactie', 'Actie bij tikken op dit label. Standaard opent meer info.'],
      hold_action: ['Vasthoudactie', 'Actie bij ingedrukt houden van dit label.']
    }
  },
  it: {
    card: { monitoring: 'MONITORAGGIO', divergence: 'DIVERGENZA', category: 'ANOMALIA DI SISTEMA', unavailable: 'NON DISPONIBILE' },
    ui: {
      entities: 'Entità', expandAll: 'Espandi tutto', collapseAll: 'Comprimi tutto', addEntity: '+ Aggiungi entità',
      remove: 'Rimuovi', addState: '+ Aggiungi stato', unconfigured: 'Non configurata', yamlOnly: "Imposta {key} nell'editor YAML.",
      entitiesHint: "Se il valore critico è sopra il valore base, divergono i valori alti. Se è sotto (per esempio batteria: base 100, critico 20), divergono i valori bassi. Sotto la soglia di monitoraggio un'etichetta è nascosta ({monitoring} se sempre visibile); dalla soglia di monitoraggio mostra {monitoring} e dalla soglia di divergenza {divergence}.",
      state: 'Stato', divergenceOf: 'Divergenza di {state}', removeState: 'Rimuovi {state}'
    },
    sections: {
      title: "Titolo", title_hint: "Il sottotitolo supporta i template di Home Assistant, per esempio {{ states(\"sensor.temperature\") }} °C.",
      appearance: "Aspetto", eclipse: "Eclissi", peak: "Picco", strata: "Strati e onde", ambient: "Strati ambientali",
      divergence: "Divergenza", text: "Testo delle etichette", interaction: "Interazione", performance: "Prestazioni",
      interaction_hint: "Tocca o tieni premuto il centro dell'anello o un'etichetta. Per un popup browser_mod usa l'azione \"fire-dom-event\" con un blocco browser_mod in YAML."
    },
    entityGroups: { source: "Entità", range: "Intervallo di valori", callout: "Etichetta", actions: "Azioni" },
    options: { theme_mode: { dark: 'Scuro', light: 'Chiaro', auto: 'Auto' }, language: { '': 'Auto (Home Assistant)' } },
    settings: {
      title: ["Titolo", "Testo nell'angolo in alto a sinistra della scheda. Vuoto non mostra alcun titolo."],
      subtitle: ["Sottotitolo", "Testo sotto il titolo. Supporta i template di Home Assistant, per esempio {{ states(\"sensor.outside_temperature\") }}; la scheda lo aggiorna quando il risultato cambia."],
      theme_mode: ['Tema', "Scuro mostra un'eclissi notturna, chiaro mostra inchiostro su carta. Auto segue la modalità scura di Home Assistant."],
      eclipse_angle: ["Angolo dell'eclissi (°, vuoto = segui)", "Direzione del bagliore dell'eclissi in gradi (0 = destra, senso antiorario). Lascia vuoto per girare il bagliore verso l'entità con la divergenza maggiore.", 'Segui'],
      eclipse_intensity: ["Intensità dell'eclissi", "Luminosità della falce dell'eclissi e della sua corona."],
      ray_intensity: ['Raggi della corona', "Intensità dei sottili raggi che brillano verso l'esterno dell'anello."],
      test_divergence: ['Divergenza di prova (vuoto = dal vivo)', "Solo anteprima: forza il bagliore dell'eclissi a questa divergenza. Lascia vuoto per usare i valori dal vivo.", 'Dal vivo'],
      amplitude_scale: ['Ampiezza delle onde', 'Moltiplicatore di altezza per tutte le onde e gli strati.'],
      peak_width: ['Larghezza del picco', "Larghezza del picco che si alza sopra un'entità divergente."],
      peak_sharpness: ['Nitidezza del picco (0 = cupola, 1 = punta)', 'Forma del picco: 0 è una cupola appiattita, 1 una punta acuta.'],
      peak_height: ['Prominenza del picco', 'Quanto il picco sporge sopra gli strati sottostanti.'],
      strata_width: ['Larghezza degli strati', 'Larghezza degli strati sotto ogni picco.'],
      baseline_height: ['Altezza onde di base (0 = anello liscio)', "Altezza della sottile fascia di onde intorno a tutto l'anello. 0 dà un anello liscio."],
      facet_shading: ['Ombreggiatura delle pieghe', 'Intensità delle ombre delle pieghe che danno rilievo agli strati.'],
      ring_shading: ['Ombreggiatura ad anelli ondulanti', "Anelli di ombreggiatura concentrici che ondeggiano verso l'interno e l'esterno sugli strati."],
      ambient_count: ['Numero di strati ambientali', "Numero massimo di piccoli strati ambientali che salgono e scendono in punti casuali delle zone calme dell'anello. 0 li disattiva."],
      ambient_size: ['Dimensione strato ambientale', 'Altezza massima di uno strato ambientale.'],
      ambient_width: ['Larghezza strato ambientale', 'Larghezza di uno strato ambientale.'],
      ambient_lifetime: ['Durata strato ambientale (s)', 'Secondi che uno strato ambientale impiega per salire e scendere di nuovo.'],
      divergence_threshold: ['Soglia di divergenza (0–1)', "Frazione (0-1) del percorso tra valore base e valore critico da cui un'etichetta passa a DIVERGENZA."],
      monitoring_threshold: ['Soglia di monitoraggio (0–1, vuoto = nessuna)', "Frazione (0-1) del percorso tra valore base e valore critico da cui un'etichetta appare come MONITORAGGIO. Lascia vuoto per nessuno stato di monitoraggio.", 'Nessuna'],
      transition_tau: ['Smorzamento transizioni (s)', 'Costante di tempo in secondi del cambio graduale quando un valore cambia. Valori più alti danno un movimento più lento e calmo.'],
      language: ['Lingua', 'Lingua dei testi delle etichette e del formato dei valori. Auto segue la lingua di Home Assistant.'],
      monitoring_label: ['Testo di monitoraggio', "Testo prima della categoria in un'etichetta in monitoraggio. Vuoto usa la traduzione della lingua della scheda."],
      divergence_label: ['Testo di divergenza', "Testo prima della categoria in un'etichetta in divergenza. Vuoto usa la traduzione della lingua della scheda."],
      font_family: ['Carattere delle etichette (CSS font-family)', 'Famiglia di caratteri CSS delle etichette. Il carattere predefinito Barlow Condensed si carica da Google Fonts. Imposta un carattere locale per tenere la scheda offline.', 'Barlow Condensed (predefinito)'],
      font_size: ['Dimensione carattere (px)', 'Dimensione del testo delle etichette in px. Linee guida e spaziature si adattano.'],
      hold_time: ['Durata pressione (ms)', 'Millisecondi che una pressione deve durare per contare come tenuta. Vale per il centro e per le etichette.'],
      center_entity: ['Entità del centro', 'Entità usata dalle azioni del centro, per esempio per più informazioni o commutare.'],
      center_tap_action: ['Azione al tocco del centro', "Azione al tocco del centro dell'anello. Per un popup browser_mod usa fire-dom-event con un blocco browser_mod in YAML."],
      center_hold_action: ['Azione alla pressione prolungata del centro', "Azione quando tieni premuto il centro dell'anello."],
      height: ['Altezza della scheda (CSS)', 'Altezza della scheda in unità CSS, per esempio 500px, o 100vh per una vista pannello a schermo intero.'],
      ring_scale: ["Dimensione dell'anello", "Raggio dell'anello rispetto alla dimensione della scheda."],
      resolution_scale: ['Scala di risoluzione', 'Risoluzione di rendering rispetto allo schermo. Valori più bassi risparmiano tempo GPU sui tablet lenti.'],
      fps_idle: ['FPS a riposo', 'Frequenza dei fotogrammi mentre tutte le entità sono calme.'],
      fps_active: ['FPS in attività', "Frequenza dei fotogrammi mentre un'entità diverge o un valore cambia."]
    },
    entity: {
      entity: ['ID entità', 'Entità di Home Assistant che guida questa etichetta.'],
      name: ['Nome', "Testo dell'etichetta. Vuoto usa il nome visualizzato dell'entità.", "Nome visualizzato dell'entità"],
      category: ['Categoria', 'Intestazione sopra il nome, per esempio VARIAZIONE TERMICA.'],
      baseline: ['Valore base (divergenza 0)', "Valore a cui l'entità è calma (divergenza 0)."],
      critical: ['Valore critico (divergenza 1)', "Valore a cui l'entità diverge del tutto (divergenza 1). Se è sotto il valore base, divergono i valori più bassi."],
      state_map: ['Mappa degli stati', "Divergenza (0-1) per ogni stato elencato, per esempio home 0 e not_home 1. Uno stato elencato ignora valore base e valore critico. Con una mappa, le soglie dell'entità sono valori di divergenza (0-1)."],
      unit: ['Unità', "Unità mostrata dopo il valore. Vuoto usa l'unità dell'entità.", "Unità dell'entità"],
      angle: ['Angolo (°, vuoto = auto)', "Posizione dell'etichetta sull'anello in gradi (0 = destra, senso antiorario). Lascia vuoto per distribuire le etichette in modo uniforme.", 'Auto'],
      monitoring_threshold: ['Soglia di monitoraggio (valore del sensore)', "Valore del sensore da cui questa etichetta appare come MONITORAGGIO; con una mappa degli stati, un valore di divergenza (0-1). Vuoto usa l'impostazione della scheda.", 'Scheda', 'Soglia di monitoraggio (0–1)'],
      divergence_threshold: ['Soglia di divergenza (valore del sensore)', "Valore del sensore da cui questa etichetta passa a DIVERGENZA; con una mappa degli stati, un valore di divergenza (0-1). Vuoto usa l'impostazione della scheda.", 'Scheda', 'Soglia di divergenza (0–1)'],
      always_visible: ['Etichetta sempre visibile', "Mostra l'etichetta come MONITORAGGIO anche quando sarebbe nascosta."],
      tap_action: ['Azione al tocco', 'Azione al tocco di questa etichetta. Il predefinito apre più informazioni.'],
      hold_action: ['Azione alla pressione prolungata', 'Azione quando tieni premuta questa etichetta.']
    }
  }
};

function normLang(lang) {
  const base = String(lang || '').toLowerCase().split(/[-_]/)[0];
  return base in TRANSLATIONS ? base : 'en';
}
const fillText = (text, vars) => String(text).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
const I18N_CACHE = {};
// The settings list, section titles and texts in one language, with English as the fallback
function i18n(lang) {
  const code = normLang(lang);
  if (I18N_CACHE[code]) return I18N_CACHE[code];
  const tr = TRANSLATIONS[code] || {};
  const text = { ...CARD_TEXT, ...tr.card };
  const ui = { ...UI_TEXT, ...tr.ui };
  const localize = (list, dict) => list.map(st => {
    const out = { ...st };
    const t = dict && dict[st.key];
    if (t) {
      if (t[0]) out.label = t[0];
      if (t[1]) out.tip = t[1];
      if (t[2]) out.placeholder = t[2];
      if (t[3]) out.mapLabel = t[3];
    }
    const names = tr.options && tr.options[st.key];
    if (st.options && names) out.options = st.options.map(([v, n]) => [v, v in names ? names[v] : n]);
    return out;
  });
  const settings = localize(CARD_SETTINGS, tr.settings).map(st => {
    if (st.key === 'monitoring_label') return { ...st, placeholder: text.monitoring };
    if (st.key === 'divergence_label') return { ...st, placeholder: text.divergence };
    return st;
  });
  const entity = localize(ENTITY_SETTINGS, tr.entity).map(st => (st.key === 'category' ? { ...st, placeholder: text.category } : st));
  const secs = tr.sections || {};
  const sections = SETTING_SECTIONS.map(sec => ({
    ...sec,
    title: secs[sec.id] || sec.title,
    hint: sec.hint && (secs[`${sec.id}_hint`] || sec.hint)
  }));
  const groupNames = tr.entityGroups || {};
  const entityGroups = ENTITY_GROUPS.map(g => ({ ...g, title: groupNames[g.id] || g.title }));
  I18N_CACHE[code] = { code, text, ui, sections, settings, entity, entityGroups };
  return I18N_CACHE[code];
}

const hasStateMap = ent => Boolean(ent && ent.state_map && typeof ent.state_map === 'object' && Object.keys(ent.state_map).length);
const SETTING = Object.fromEntries(CARD_SETTINGS.map(st => [st.key, st]));
const settingUnsetAt = (st, config) => (typeof st.unsetAt === 'function' ? st.unsetAt(config) : st.unsetAt ?? st.default ?? st.min);

// Info icon for a setting label; the tooltip opens on hover and on tap (focus)
function tipIcon(text) {
  return text ? `<span class="tip" tabindex="0" role="note" aria-label="${esc(text)}" data-tip="${esc(text)}">i</span>` : '';
}

// ============================================================================
// VISUAL LOVELACE CONFIG EDITOR (<lovelace-rehoboam-editor>)
// ============================================================================
class RehoboamCardEditor extends HTMLElement {
  // The settings list in English (for the README) or in one language (for the playground)
  static get settings() {
    return RehoboamCardEditor.settingsFor('en');
  }

  static settingsFor(lang) {
    const L = i18n(lang);
    return { language: L.code, sections: L.sections, card: L.settings, entity: L.entity, entityGroups: L.entityGroups, ui: L.ui, text: L.text, languages: LANGUAGES };
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = null;
    this._hass = null;
    this._rendered = false;
    // Indexes of the entity sections that are expanded; kept across re-renders
    this._openEntities = new Set();
  }

  connectedCallback() {
    // Home Assistant lazy-loads ha-entity-picker; trigger loading via hui-entities-card
    if (!customElements.get('ha-entity-picker')) {
      const entitiesCard = customElements.get('hui-entities-card');
      if (entitiesCard && typeof entitiesCard.getConfigElement === 'function') {
        entitiesCard.getConfigElement();
      }
      customElements.whenDefined('ha-entity-picker').then(() => {
        if (this.isConnected && this._config) {
          this._render();
        }
      });
    }
    if (!customElements.get('ha-selector')) {
      customElements.whenDefined('ha-selector').then(() => {
        if (this.isConnected && this._config) {
          this._render();
        }
      });
    }
  }

  setConfig(config) {
    // HA echoes back every config we emit. Only rebuild the form when the config
    // changed from outside (e.g. YAML editor), so stale fields never overwrite it.
    const incoming = JSON.stringify(config);
    if (this._rendered && incoming === this._lastEmitted) return;

    this._config = {
      ...Object.fromEntries(CARD_SETTINGS.filter(st => st.default !== undefined).map(st => [st.key, st.default])),
      ...config,
      entities: Array.isArray(config.entities)
        ? config.entities.map(e => (typeof e === 'string' ? { entity: e } : { ...e }))
        : []
    };

    this._render();
    this._rendered = true;
  }

  set hass(hass) {
    this._hass = hass;
    // The editor follows the language of the Home Assistant user
    const lang = normLang((hass && hass.locale && hass.locale.language) || (hass && hass.language));
    if (lang !== this._lang) {
      this._lang = lang;
      if (this._rendered) this._render();
      return;
    }
    if (this.shadowRoot) {
      this.shadowRoot.querySelectorAll('ha-entity-picker, ha-selector').forEach(el => {
        el.hass = hass;
      });
    }
  }

  _emitConfig(newConfig) {
    this._config = newConfig;
    this._lastEmitted = JSON.stringify(newConfig);
    this.dispatchEvent(
      new CustomEvent('config-changed', {
        detail: { config: newConfig },
        bubbles: true,
        composed: true
      })
    );
  }

  _onGlobalChange(key, value, isNumber = false) {
    const next = { ...this._config };
    if (value === '' || value === null || value === undefined || (isNumber && Number.isNaN(Number(value)))) {
      // Empty field -> remove key so the card falls back to its default
      delete next[key];
    } else {
      next[key] = isNumber ? Number(value) : value;
    }
    this._emitConfig(next);
  }

  _onEntityChange(index, key, value, type = 'string') {
    const entities = this._config.entities.map((e, i) => {
      if (i !== index) return e;
      const updated = { ...e };
      if (type === 'boolean') {
        updated[key] = Boolean(value);
      } else if (type === 'object') {
        if (value === undefined || value === null) {
          delete updated[key];
        } else {
          updated[key] = value;
        }
      } else if (type === 'number') {
        if (value === '' || value === null || Number.isNaN(Number(value))) {
          delete updated[key];
        } else {
          updated[key] = Number(value);
        }
      } else {
        if (value === '' && key !== 'entity' && key !== 'unit') {
          delete updated[key];
        } else {
          updated[key] = value;
        }
      }
      return updated;
    });
    this._emitConfig({ ...this._config, entities });
  }

  _addEntity() {
    const entities = [
      ...this._config.entities,
      {
        entity: '',
        ...Object.fromEntries(ENTITY_SETTINGS.filter(st => st.default !== undefined).map(st => [st.key, st.default]))
      }
    ];
    // A new entity opens expanded, so it can be filled in at once
    this._openEntities.add(entities.length - 1);
    this._emitConfig({ ...this._config, entities });
    this._render();
  }

  _removeEntity(index) {
    const entities = this._config.entities.filter((_, i) => i !== index);
    // Shift the expanded state of the sections after the removed one
    this._openEntities = new Set([...this._openEntities].filter(i => i !== index).map(i => (i > index ? i - 1 : i)));
    this._emitConfig({ ...this._config, entities });
    this._render();
  }

  // A slider next to a number box. Both show one value; an empty number box means "not set"
  // (the card default), and the slider then rests dimmed at unsetAt.
  _rangeField(label, key, min, max, step, { value, placeholder = '', unsetAt = min, idx = null, cls = '', tip = SETTING[key] && SETTING[key].tip } = {}) {
    const raw = idx === null ? this._config[key] : value;
    const isSet = raw !== undefined && raw !== null && raw !== '' && Number.isFinite(Number(raw));
    const scope = idx === null ? 'global' : 'entity';
    const bounds = `min="${min}" max="${max}" step="${step}"`;
    return `<div class="field">
      <label>${label}${tipIcon(tip)}</label>
      <div class="range-row ${cls} ${isSet ? '' : 'unset'}" data-scope="${scope}" data-key="${key}" data-idx="${idx ?? ''}" data-unset="${esc(unsetAt)}">
        <input class="rng" type="range" ${bounds} value="${esc(isSet ? raw : unsetAt)}" aria-label="${esc(label)}" />
        <input class="num" ${idx === null ? `id="f-${key}"` : ''} type="number" ${bounds} value="${esc(isSet ? raw : '')}" placeholder="${esc(placeholder)}" aria-label="${esc(label)}" />
      </div>
    </div>`;
  }

  // Entity thresholds are sensor values, so their sliders span baseline..critical
  _thresholdBounds(ent) {
    // With a state map the thresholds are divergence values, so the sliders span 0..1
    const mapped = hasStateMap(ent);
    const base = mapped ? 0 : Number.isFinite(Number(ent.baseline)) && ent.baseline !== '' ? Number(ent.baseline) : 0;
    const crit = mapped ? 1 : Number.isFinite(Number(ent.critical)) && ent.critical !== '' ? Number(ent.critical) : 100;
    const lo = Math.min(base, crit);
    const hi = Math.max(base, crit);
    const span = hi - lo;
    const step = span > 0 ? Math.pow(10, Math.floor(Math.log10(span / 100))) : 1;
    const c = this._config;
    const divFrac = Number.isFinite(Number(c.divergence_threshold)) ? Number(c.divergence_threshold) : 0.15;
    const monFrac = Number.isFinite(Number(c.monitoring_threshold)) && c.monitoring_threshold !== null && c.monitoring_threshold !== ''
      ? Number(c.monitoring_threshold) : divFrac;
    const at = frac => roundToStep(base + frac * (crit - base), step);
    return { lo, hi, step, divAt: at(divFrac), monAt: at(monFrac) };
  }

  // Angle the card picks for an entity without an angle override
  _autoAngle(index) {
    const unangled = this._config.entities.map(e => e.angle === undefined || e.angle === '' || e.angle === null);
    const count = unangled.filter(Boolean).length;
    const autoIdx = unangled.slice(0, index).filter(Boolean).length;
    return Math.round((22.5 + (autoIdx * 360) / Math.max(1, count)) % 360);
  }

  _updateThresholdRanges(index) {
    const ent = this._config.entities[index];
    if (!ent) return;
    const { lo, hi, step, divAt, monAt } = this._thresholdBounds(ent);
    this.shadowRoot.querySelectorAll(`.range-row.ent-threshold[data-idx="${index}"]`).forEach(row => {
      const unsetAt = row.dataset.key === 'divergence_threshold' ? divAt : monAt;
      row.dataset.unset = String(unsetAt);
      row.querySelectorAll('input').forEach(inp => {
        inp.min = String(lo);
        inp.max = String(hi);
        inp.step = String(step);
      });
      const rng = row.querySelector('.rng');
      const num = row.querySelector('.num');
      rng.value = num.value !== '' ? num.value : String(unsetAt);
    });
  }

  _bindRangeRows() {
    this.shadowRoot.querySelectorAll('.range-row').forEach(row => {
      const rng = row.querySelector('.rng');
      const num = row.querySelector('.num');
      const { scope, key } = row.dataset;
      const emit = value => {
        if (scope === 'global') {
          this._onGlobalChange(key, value, true);
          if (key === 'divergence_threshold' || key === 'monitoring_threshold') {
            this._config.entities.forEach((_, i) => this._updateThresholdRanges(i));
          }
        } else this._onEntityChange(Number(row.dataset.idx), key, value, 'number');
      };
      // Live value while dragging; the config is sent on release, so the preview card is not
      // rebuilt on every step of the drag.
      rng.addEventListener('input', () => {
        num.value = String(roundToStep(Number(rng.value), Number(rng.step)));
        row.classList.remove('unset');
      });
      rng.addEventListener('change', () => emit(num.value));
      num.addEventListener('change', () => {
        const isSet = num.value !== '' && Number.isFinite(Number(num.value));
        rng.value = isSet ? num.value : row.dataset.unset;
        row.classList.toggle('unset', !isSet);
        emit(num.value);
      });
    });
  }

  _settingField(st, hasEntityPicker) {
    const c = this._config;
    const value = c[st.key];
    const label = `<label>${esc(st.label)}${tipIcon(st.tip)}</label>`;
    switch (st.type) {
      case 'number':
        return this._rangeField(esc(st.label), st.key, st.min, st.max, st.step, {
          placeholder: st.placeholder ?? (st.default !== undefined ? String(st.default) : ''),
          unsetAt: settingUnsetAt(st, c),
          tip: st.tip
        });
      case 'select':
        return `<div class="field">${label}
          <select class="set-input" data-key="${st.key}">
            ${st.options.map(([val, name]) => `<option value="${esc(val)}" ${value === val ? 'selected' : ''}>${esc(name)}</option>`).join('')}
          </select></div>`;
      case 'text':
        return `<div class="field">${label}
          <input class="set-input" data-key="${st.key}" type="text" value="${esc(value)}" placeholder="${esc(st.placeholder || '')}" /></div>`;
      case 'bool':
        return `<div class="checkbox-row">
          <input class="set-check" id="f-${st.key}" data-key="${st.key}" type="checkbox" ${value !== false && (value || st.default) ? 'checked' : ''} />
          <label for="f-${st.key}">${esc(st.label)}</label>${tipIcon(st.tip)}</div>`;
      case 'template':
        // Home Assistant's template editor when it is loaded, else a plain text area
        return `<div class="field" style="grid-column: span 2;">${label}
          ${customElements.get('ha-selector')
            ? `<ha-selector class="tpl-sel" data-key="${st.key}"></ha-selector>`
            : `<textarea class="set-input" data-key="${st.key}" rows="2" placeholder="${esc(st.placeholder || '')}">${esc(value)}</textarea>`}</div>`;
      case 'entity':
        return `<div class="field" style="grid-column: span 2;">${label}
          ${hasEntityPicker
            ? `<ha-entity-picker id="f-${st.key}" value="${esc(value)}" allow-custom-entity></ha-entity-picker>`
            : `<input id="f-${st.key}" type="text" value="${esc(value)}" placeholder="${esc(st.placeholder || '')}" />`}</div>`;
      case 'action':
        return this._actionField(esc(st.label), 'global', st.key, '', st.tip);
      default:
        return '';
    }
  }

  _entityField(st, ent, idx, tb, hasEntityPicker) {
    const value = ent[st.key];
    const label = `<label>${esc(st.label)}${tipIcon(st.tip)}</label>`;
    const data = `data-idx="${idx}" data-key="${st.key}"`;
    switch (st.type) {
      case 'entity':
        return `<div class="field" style="grid-column: span 2;">${label}
          ${hasEntityPicker
            ? `<ha-entity-picker class="ent-picker" data-idx="${idx}" value="${esc(value)}" allow-custom-entity></ha-entity-picker>`
            : `<input class="ent-input" ${data} data-type="string" type="text" value="${esc(value)}" placeholder="${esc(st.placeholder || '')}" />`}</div>`;
      case 'text':
        return `<div class="field">${label}
          <input class="ent-input" ${data} data-type="string" type="text" value="${esc(value)}" placeholder="${esc(st.placeholder || '')}" /></div>`;
      case 'plain':
        return `<div class="field">${label}
          <input class="ent-input" ${data} data-type="number" type="number" step="any" value="${esc(value ?? st.default)}" /></div>`;
      case 'number':
        return this._rangeField(esc(st.label), st.key, st.min, st.max, st.step, {
          idx, value, placeholder: st.placeholder, unsetAt: st.key === 'angle' ? this._autoAngle(idx) : st.min, tip: st.tip
        });
      case 'threshold':
        return this._rangeField(esc(hasStateMap(ent) ? st.mapLabel : st.label), st.key, tb.lo, tb.hi, tb.step, {
          idx, value, placeholder: st.placeholder, cls: 'ent-threshold', tip: st.tip,
          unsetAt: st.key === 'divergence_threshold' ? tb.divAt : tb.monAt
        });
      case 'bool':
        return `<div class="checkbox-row">
          <input class="ent-check" id="chk-${idx}-${st.key}" ${data} type="checkbox" ${value ? 'checked' : ''} />
          <label for="chk-${idx}-${st.key}">${esc(st.label)}</label>${tipIcon(st.tip)}</div>`;
      case 'action':
        return this._actionField(esc(st.label), 'entity', st.key, idx, st.tip);
      case 'map': {
        const entries = Object.entries(value && typeof value === 'object' ? value : {});
        const ui = this._L.ui;
        return `<div class="field map-field" data-idx="${idx}" style="grid-column: span 2;">${label}
          ${entries.map(([state, v]) => `<div class="map-row">
            <input class="map-state" type="text" value="${esc(state)}" placeholder="${esc(ui.state)}" aria-label="${esc(ui.state)}" />
            <input class="map-rng" type="range" min="0" max="1" step="0.05" value="${esc(v)}" aria-label="${esc(fillText(ui.divergenceOf, { state }))}" />
            <input class="map-num" type="number" min="0" max="1" step="0.05" value="${esc(v)}" aria-label="${esc(fillText(ui.divergenceOf, { state }))}" />
            <button class="btn btn-danger map-del" type="button" aria-label="${esc(fillText(ui.removeState, { state }))}">×</button>
          </div>`).join('')}
          <div><button class="btn map-add" type="button">${esc(ui.addState)}</button></div>
        </div>`;
      }
      default:
        return '';
    }
  }

  // Rebuilds an entity's state map from its rows; empty state names are left out
  _readStateMap(field) {
    const map = {};
    field.querySelectorAll('.map-row').forEach(row => {
      const state = row.querySelector('.map-state').value.trim();
      const v = Number(row.querySelector('.map-num').value);
      if (state) map[state] = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
    });
    return Object.keys(map).length ? map : undefined;
  }

  _bindStateMaps() {
    this.shadowRoot.querySelectorAll('.map-field').forEach(field => {
      const idx = Number(field.dataset.idx);
      // Adding or removing a row (or the first or last state) changes the threshold sliders, so
      // those re-render; edits inside a row only send the config.
      const emit = rerender => {
        const before = hasStateMap(this._config.entities[idx]);
        this._onEntityChange(idx, 'state_map', this._readStateMap(field), 'object');
        if (rerender || before !== hasStateMap(this._config.entities[idx])) this._render();
      };
      field.querySelectorAll('.map-row').forEach(row => {
        const rng = row.querySelector('.map-rng');
        const num = row.querySelector('.map-num');
        rng.addEventListener('input', () => { num.value = rng.value; });
        rng.addEventListener('change', () => emit(false));
        num.addEventListener('change', () => { rng.value = num.value; emit(false); });
        row.querySelector('.map-state').addEventListener('change', () => emit(false));
        row.querySelector('.map-del').addEventListener('click', () => { row.remove(); emit(true); });
      });
      field.querySelector('.map-add').addEventListener('click', () => {
        const map = { ...(this._config.entities[idx].state_map || {}) };
        let name = 'new_state';
        for (let n = 2; name in map; n++) name = `new_state_${n}`;
        map[name] = 1;
        this._onEntityChange(idx, 'state_map', map, 'object');
        this._render();
      });
    });
  }

  // ha-selector with { ui_action: {} } is Home Assistant's own action picker
  _actionField(label, scope, key, idx = '', tip = '') {
    if (!customElements.get('ha-selector')) {
      return `<div class="field" style="grid-column: span 2;"><label>${label}${tipIcon(tip)}</label>
        <div class="hint">${esc(fillText((this._L || i18n('en')).ui.yamlOnly, { key })).replace(esc(key), `<code>${esc(key)}</code>`)}</div></div>`;
    }
    return `<div class="field" style="grid-column: span 2;">
      <label>${label}${tipIcon(tip)}</label>
      <ha-selector class="act-sel" data-scope="${scope}" data-key="${key}" data-idx="${idx}"></ha-selector>
    </div>`;
  }

  _render() {
    if (!this._config) return;
    const c = this._config;
    const L = i18n(this._lang);
    this._L = L;
    const hasEntityPicker = Boolean(customElements.get('ha-entity-picker'));

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif);
          color: var(--primary-text-color, #e1e1e1);
        }
        .section {
          margin-bottom: 18px;
          padding: 14px;
          border-radius: 8px;
          background: var(--card-background-color, rgba(255,255,255,0.03));
          border: 1px solid var(--divider-color, rgba(255,255,255,0.12));
        }
        .section-title {
          font-size: 13px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.8px;
          margin-bottom: 12px;
          color: var(--primary-color, #03a9f4);
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
          gap: 12px;
        }
        .field {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        label {
          font-size: 12px;
          color: var(--secondary-text-color, #9b9b9b);
        }
        input, select, textarea {
          padding: 8px 10px;
          border-radius: 6px;
          border: 1px solid var(--divider-color, rgba(255,255,255,0.2));
          background: var(--lovelace-background, rgba(0,0,0,0.2));
          color: var(--primary-text-color, #fff);
          font-size: 13px;
          width: 100%;
          box-sizing: border-box;
        }
        .entity-card {
          margin-top: 12px;
          padding: 0 12px;
          border-radius: 6px;
          background: rgba(0, 0, 0, 0.15);
          border: 1px solid var(--divider-color, rgba(255,255,255,0.1));
        }
        .entity-card[open] {
          padding-bottom: 12px;
        }
        .entity-head {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 8px;
          padding: 10px 0;
          font-weight: 600;
          font-size: 13px;
          cursor: pointer;
          list-style: none;
        }
        .entity-head::-webkit-details-marker {
          display: none;
        }
        .entity-head::before {
          content: '▸';
          display: inline-block;
          width: 14px;
          transition: transform 0.15s;
          color: var(--secondary-text-color, #9b9b9b);
        }
        .entity-card[open] > .entity-head::before {
          transform: rotate(90deg);
        }
        .entity-title {
          flex: 1;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .entity-sub {
          font-weight: 400;
          color: var(--secondary-text-color, #9b9b9b);
        }
        .btn {
          padding: 6px 12px;
          border-radius: 6px;
          border: 1px solid var(--primary-color, #03a9f4);
          background: transparent;
          color: var(--primary-color, #03a9f4);
          cursor: pointer;
          font-size: 12px;
          font-weight: 600;
        }
        .btn:hover {
          background: rgba(3, 169, 244, 0.12);
        }
        .btn-danger {
          border-color: var(--error-color, #db4437);
          color: var(--error-color, #db4437);
        }
        .checkbox-row {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-top: 18px;
        }
        .checkbox-row input {
          width: auto;
        }
        .hint {
          font-size: 11px;
          color: var(--secondary-text-color, #888);
          margin-top: 4px;
        }
        .section > .hint {
          margin: -4px 0 12px;
        }
        .field > label {
          position: relative;
        }
        .range-row {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .range-row .rng {
          flex: 1;
          min-width: 0;
          padding: 0;
          border: none;
          background: transparent;
          accent-color: var(--primary-color, #03a9f4);
        }
        .range-row .num {
          flex: 0 0 84px;
          width: 84px;
        }
        .range-row.unset .rng {
          opacity: 0.4;
        }
        .tip {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 14px;
          height: 14px;
          margin-left: 6px;
          border-radius: 50%;
          border: 1px solid currentColor;
          font: 600 10px/1 Georgia, serif;
          font-style: italic;
          color: var(--secondary-text-color, #9b9b9b);
          cursor: help;
          vertical-align: middle;
          outline: none;
        }
        .tip:hover, .tip:focus {
          color: var(--primary-color, #03a9f4);
        }
        .tip:hover::after, .tip:focus::after {
          content: attr(data-tip);
          position: absolute;
          left: 0;
          right: 0;
          top: calc(100% + 4px);
          z-index: 10;
          min-width: 200px;
          padding: 8px 10px;
          border-radius: 6px;
          background: var(--secondary-background-color, #2b2b30);
          color: var(--primary-text-color, #e1e1e1);
          border: 1px solid var(--divider-color, rgba(255,255,255,0.2));
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
          font: 400 12px/1.4 var(--paper-font-body1_-_font-family, Roboto, sans-serif);
          font-style: normal;
          text-transform: none;
          letter-spacing: normal;
          white-space: normal;
          pointer-events: none;
        }
        .checkbox-row {
          position: relative;
        }
        .sub-title {
          grid-column: 1 / -1;
          margin: 6px 0 -4px;
          padding-bottom: 4px;
          border-bottom: 1px solid var(--divider-color, rgba(255,255,255,0.12));
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.6px;
          text-transform: uppercase;
          color: var(--secondary-text-color, #9b9b9b);
        }
        .map-row {
          display: flex;
          align-items: center;
          gap: 6px;
          margin-bottom: 6px;
        }
        .map-row .map-state {
          flex: 1 1 35%;
          min-width: 0;
        }
        .map-row .map-rng {
          flex: 1 1 45%;
          min-width: 0;
          padding: 0;
          border: none;
          background: transparent;
          accent-color: var(--primary-color, #03a9f4);
        }
        .map-row .map-num {
          flex: 0 0 64px;
          width: 64px;
        }
        .map-row .map-del {
          flex: none;
          padding: 4px 9px;
        }
      </style>

      ${L.sections.map(sec => `
      <div class="section">
        <div class="section-title">${sec.title}</div>
        ${sec.hint ? `<div class="hint">${esc(sec.hint)}</div>` : ''}
        <div class="grid">
          ${L.settings.filter(st => st.section === sec.id).map(st => this._settingField(st, hasEntityPicker)).join('')}
        </div>
      </div>`).join('')}

      <div class="section">
        <div class="section-title">
          <span>${esc(L.ui.entities)} (${c.entities.length})</span>
          <span>
            <button class="btn" id="btn-toggle-entities">${esc(this._openEntities.size ? L.ui.collapseAll : L.ui.expandAll)}</button>
            <button class="btn" id="btn-add-entity">${esc(L.ui.addEntity)}</button>
          </span>
        </div>
        <div class="hint">${esc(fillText(L.ui.entitiesHint, { monitoring: L.text.monitoring, divergence: L.text.divergence }))}</div>
        <div id="entities-container">
          ${c.entities
            .map(
              (ent, idx) => {
                const tb = this._thresholdBounds(ent);
                return `
            <details class="entity-card" data-idx="${idx}" ${this._openEntities.has(idx) ? 'open' : ''}>
              <summary class="entity-head">
                <span class="entity-title">#${idx + 1} ${esc(ent.category || L.text.category)}
                  <span class="entity-sub">· ${esc(ent.name || ent.entity || L.ui.unconfigured)}</span></span>
                <button class="btn btn-danger btn-remove" data-idx="${idx}">${esc(L.ui.remove)}</button>
              </summary>
              <div class="grid">
                ${L.entityGroups.map(g => `<div class="sub-title">${esc(g.title)}</div>
                ${L.entity.filter(st => st.group === g.id).map(st => this._entityField(st, ent, idx, tb, hasEntityPicker)).join('')}`).join('')}
              </div>
            </details>
          `;
              }
            )
            .join('')}
        </div>
      </div>
    `;

    const root = this.shadowRoot;

    // Bind card-level fields
    root.querySelectorAll('.set-input').forEach(inp => {
      inp.addEventListener('change', e => this._onGlobalChange(inp.dataset.key, e.target.value));
    });
    // Template editors send every keystroke; the config goes out once typing pauses
    root.querySelectorAll('.tpl-sel').forEach(sel => {
      const key = sel.dataset.key;
      sel.selector = { template: {} };
      if (this._hass) sel.hass = this._hass;
      sel.value = c[key] || '';
      sel.addEventListener('value-changed', e => {
        e.stopPropagation();
        sel.value = e.detail.value;
        clearTimeout(this._templateTimer);
        this._templateTimer = setTimeout(() => this._onGlobalChange(key, e.detail.value), 400);
      });
    });
    root.querySelectorAll('.set-check').forEach(chk => {
      chk.addEventListener('change', e => this._onGlobalChange(chk.dataset.key, e.target.checked));
    });
    this._bindRangeRows();
    this._bindStateMaps();

    // Bind Add / Remove Entity buttons
    root.getElementById('btn-add-entity').addEventListener('click', () => this._addEntity());
    root.querySelectorAll('.btn-remove').forEach(btn => {
      btn.addEventListener('click', e => {
        // The button sits in the section header; do not also toggle the section
        e.preventDefault();
        e.stopPropagation();
        this._removeEntity(Number(e.currentTarget.dataset.idx));
      });
    });
    root.querySelectorAll('details.entity-card').forEach(box => {
      box.addEventListener('toggle', () => {
        const idx = Number(box.dataset.idx);
        if (box.open) this._openEntities.add(idx); else this._openEntities.delete(idx);
        const toggleAll = root.getElementById('btn-toggle-entities');
        if (toggleAll) toggleAll.textContent = this._openEntities.size ? L.ui.collapseAll : L.ui.expandAll;
      });
    });
    root.getElementById('btn-toggle-entities').addEventListener('click', () => {
      const expand = this._openEntities.size === 0;
      root.querySelectorAll('details.entity-card').forEach(box => { box.open = expand; });
    });

    // Bind ha-entity-picker if available
    root.querySelectorAll('.ent-picker').forEach(picker => {
      if (this._hass) picker.hass = this._hass;
      picker.addEventListener('value-changed', e => {
        const idx = Number(e.currentTarget.dataset.idx);
        e.currentTarget.value = e.detail.value;
        this._onEntityChange(idx, 'entity', e.detail.value, 'string');
      });
    });

    // Bind standard entity inputs
    root.querySelectorAll('.ent-input').forEach(inp => {
      inp.addEventListener('change', e => {
        const el = e.currentTarget;
        this._onEntityChange(Number(el.dataset.idx), el.dataset.key, el.value, el.dataset.type);
        if (el.dataset.key === 'baseline' || el.dataset.key === 'critical') this._updateThresholdRanges(Number(el.dataset.idx));
      });
    });

    root.querySelectorAll('.ent-check').forEach(chk => {
      chk.addEventListener('change', e => {
        const el = e.currentTarget;
        this._onEntityChange(Number(el.dataset.idx), el.dataset.key, el.checked, 'boolean');
      });
    });


    const centerEntity = root.getElementById('f-center_entity');
    if (centerEntity.tagName === 'HA-ENTITY-PICKER') {
      if (this._hass) centerEntity.hass = this._hass;
      centerEntity.addEventListener('value-changed', e => {
        centerEntity.value = e.detail.value;
        this._onGlobalChange('center_entity', e.detail.value);
      });
    } else {
      centerEntity.addEventListener('change', e => this._onGlobalChange('center_entity', e.target.value));
    }

    // HA pickers are controlled: they report a new value and show it only once it is handed back
    // through .value. Without that the picker falls back to the old value, and the sub-form of an
    // action (service, data, navigation path, ...) never opens.
    root.querySelectorAll('.act-sel').forEach(sel => {
      const { scope, key, idx } = sel.dataset;
      sel.selector = { ui_action: {} };
      if (this._hass) sel.hass = this._hass;
      const entityId = scope === 'global' ? c.center_entity : c.entities[Number(idx)].entity;
      if (entityId) sel.context = { entity_id: entityId };
      sel.value = scope === 'global' ? c[key] : c.entities[Number(idx)][key];
      sel.addEventListener('value-changed', e => {
        e.stopPropagation();
        sel.value = e.detail.value;
        if (scope === 'global') {
          this._onGlobalChange(key, e.detail.value);
        } else {
          this._onEntityChange(Number(idx), key, e.detail.value, 'object');
        }
      });
    });
  }
}

if (!customElements.get('lovelace-rehoboam-editor')) {
  customElements.define('lovelace-rehoboam-editor', RehoboamCardEditor);
}

// ============================================================================
// MAIN LOVELACE CARD (<lovelace-rehoboam>)
// ============================================================================
class RehoboamCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement('lovelace-rehoboam-editor');
  }

  static getStubConfig() {
    return {
      theme_mode: 'dark',
      height: DEFAULT_HEIGHT,
      eclipse_intensity: 1.0,
      ray_intensity: 0.35,
      amplitude_scale: 1.25,
      entities: []
    };
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = null;
    this._hass = null;
    this._entities = [];
    this._domBuilt = false;
    this._gl = null;
    this._program = null;
    this._lutTex = null;
    this._lutData = new Uint8ClampedArray(LUT_SIZE * 2 * 4);
    this._layerVals = new Float32Array(7 * LUT_SIZE);
    this._env = null;
    this._envKey = '';
    this._activeScratch = [];
    this._rayBaseHash = new Float32Array(LUT_SIZE);
    for (let i = 0; i < LUT_SIZE; i++) {
      const a = (i / LUT_SIZE) * TWO_PI;
      this._rayBaseHash[i] =
        0.50 +
        0.20 * Math.sin(a * 43.0 + 0.7) +
        0.15 * Math.cos(a * 79.0 - 1.4) +
        0.10 * Math.sin(a * 131.0 + 2.3);
    }
    this._rafId = null;
    this._isVisible = true;
    this._lastFrameTime = 0;
    this._lastSimTimeSec = performance.now() * 0.001;
    this._currentEclipse = 0;
    this._targetEclipse = 0;
    this._eclipseAngle = Math.PI;
    this._eclipseAimed = false;
    this._vpWidth = 1280;
    this._vpHeight = 800;
    this._ringRadiusPx = 220;
  }

  setConfig(config) {
    if (!config) throw new Error('Invalid configuration');

    // Parse a numeric option; empty / invalid values fall back to the default, then clamp.
    const num = (value, def, min = -Infinity, max = Infinity) => {
      const n = value === undefined || value === null || value === '' ? NaN : Number(value);
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
    };
    // Default and limits from CARD_SETTINGS
    const opt = key => {
      const st = SETTING[key];
      return num(config[key], st.nullable ? null : st.default, st.min, st.max);
    };

    const themeMode = String(config.theme_mode || 'dark').toLowerCase();
    // Empty or 'auto': the eclipse turns toward the most diverged entity. A number fixes it.
    const eclipseRaw = config.eclipse_angle;
    const eclipseFollow = eclipseRaw === undefined || eclipseRaw === null || eclipseRaw === '' ||
      String(eclipseRaw).toLowerCase() === 'auto' || !Number.isFinite(Number(eclipseRaw));
    const eclipseAngleDeg = eclipseFollow ? null : Number(eclipseRaw);
    const testDiv = opt('test_divergence');

    this._config = {
      theme_mode: ['light', 'auto'].includes(themeMode) ? themeMode : 'dark',
      font_family: config.font_family ? String(config.font_family) : DEFAULT_FONT,
      title: config.title ? String(config.title) : '',
      subtitle: config.subtitle ? String(config.subtitle) : '',
      language: config.language ? String(config.language) : null,
      monitoring_label: config.monitoring_label ? String(config.monitoring_label) : null,
      divergence_label: config.divergence_label ? String(config.divergence_label) : null,
      font_size: opt('font_size'),
      height: config.height ? String(config.height) : DEFAULT_HEIGHT,
      eclipse_angle: eclipseAngleDeg,
      eclipse_follow: eclipseFollow,
      eclipse_intensity: opt('eclipse_intensity'),
      ray_intensity: opt('ray_intensity'),
      facet_shading: opt('facet_shading'),
      ring_shading: config.ring_shading !== false,
      amplitude_scale: opt('amplitude_scale'),
      strata_width: opt('strata_width'),
      peak_width: opt('peak_width'),
      peak_sharpness: opt('peak_sharpness'),
      peak_height: opt('peak_height'),
      baseline_height: opt('baseline_height'),
      ambient_count: Math.round(opt('ambient_count')),
      ambient_size: opt('ambient_size'),
      ambient_width: opt('ambient_width'),
      ambient_lifetime: opt('ambient_lifetime'),
      transition_tau: opt('transition_tau'),
      ring_scale: opt('ring_scale'),
      resolution_scale: opt('resolution_scale'),
      fps_idle: opt('fps_idle'),
      fps_active: opt('fps_active'),
      divergence_threshold: opt('divergence_threshold'),
      monitoring_threshold: opt('monitoring_threshold'),
      test_divergence: testDiv,
      center_entity: config.center_entity || null,
      hold_time: opt('hold_time'),
      center_tap_action: config.center_tap_action || null,
      center_hold_action: config.center_hold_action || null,
      entities: Array.isArray(config.entities) ? config.entities : []
    };

    if (!eclipseFollow) this._eclipseAngle = eclipseAngleDeg * DEG_TO_RAD;
    ensureLabelFont(this._config.font_family);
    this._initEntities();
    this._ensureDOM();
    this._setTitleText(this._titleEl, this._config.title);
    this._syncSubtitle();
    this._applyThemeStyles();
    this._buildHUD();
    this._syncUniforms();
    this._onResize();

    if (this._hass) {
      this.hass = this._hass;
    }
  }

  _initEntities() {
    const raw = this._config.entities;
    const unangledCount = raw.filter(e => typeof e === 'string' || !e || e.angle === undefined || e.angle === '').length;
    let autoIdx = 0;

    // Carry animation state over by entity id so config edits don't collapse the waves
    const previous = new Map((this._entities || []).map(e => [e.id, e]));

    this._entities = raw.map(item => {
      const conf = typeof item === 'string' ? { entity: item } : (item || {});
      let angleDeg = conf.angle !== undefined && conf.angle !== '' ? Number(conf.angle) : null;
      if (angleDeg === null || Number.isNaN(angleDeg)) {
        angleDeg = (22.5 + (autoIdx * 360) / Math.max(1, unangledCount)) % 360;
        autoIdx++;
      }
      const angleRad = ((angleDeg % 360) + 360) % 360 * DEG_TO_RAD;
      const binCenter = Math.floor((angleRad / TWO_PI) * LUT_SIZE) & LUT_MASK;
      const id = conf.entity || '';
      const prev = previous.get(id);
      const toNum = v => (v === undefined || v === null || v === '' ? NaN : Number(v));
      const baseline = toNum(conf.baseline);
      const critical = toNum(conf.critical);
      const base = Number.isFinite(baseline) ? baseline : 0;
      const crit = Number.isFinite(critical) ? critical : 100;
      // Callout thresholds as fractions between baseline and critical. Per entity they are given
      // in the sensor's own units (direction-aware), or with a state map as divergence values
      // (0-1); the global values (0-1) are the fallbacks. Without a monitoring threshold there is
      // no monitoring band: below the divergence threshold the callout is hidden.
      const toFraction = v => (hasStateMap(conf) ? Math.max(0, Math.min(1, v)) : computeDirectionalDivergence(v, base, crit));
      const divValue = toNum(conf.divergence_threshold);
      const monValue = toNum(conf.monitoring_threshold);
      const divergeAt = Number.isFinite(divValue) ? toFraction(divValue) : this._config.divergence_threshold;
      const monitorAt = Math.min(divergeAt, Number.isFinite(monValue)
        ? toFraction(monValue)
        : (this._config.monitoring_threshold ?? divergeAt));
      // Stable per-entity sweep direction for the spike's longer flank
      let hash = 0;
      for (let c = 0; c < id.length; c++) hash = (hash * 31 + id.charCodeAt(c)) | 0;

      return {
        id,
        name: conf.name || null,
        category: conf.category ? String(conf.category) : null,
        angleDeg,
        angleRad,
        cosA: Math.cos(angleRad),
        sinA: Math.sin(angleRad),
        binCenter,
        leanDir: hash & 1 ? 1 : -1,
        motionPhase: ((hash >>> 1) % 1000) * (TWO_PI / 1000),
        baseline: base,
        critical: crit,
        monitorAt,
        divergeAt,
        alwaysVisible: Boolean(conf.always_visible),
        stateMap: conf.state_map || null,
        tapAction: conf.tap_action || null,
        holdAction: conf.hold_action || null,
        unit: conf.unit !== undefined && conf.unit !== '' ? conf.unit : null,
        currentDivergence: prev ? prev.currentDivergence : 0,
        targetDivergence: prev ? prev.targetDivergence : 0,
        formattedValue: '--',
        resolvedName: conf.name || conf.entity || 'SENSOR',
        isVisible: Boolean(conf.always_visible),
        domGroup: null,
        domPoly: null,
        domHeader: null,
        domSub: null
      };
    });
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config || !hass || !hass.states) return;
    if (this._config.theme_mode === 'auto' && this._appliedLight !== this._isLight()) {
      this._applyThemeStyles();
      this._syncUniforms();
    }

    this._syncSubtitle();

    // Callout text and value format follow the card language, else the Home Assistant language
    const L = i18n(this._config.language || (hass.locale && hass.locale.language) || hass.language);
    this._i18n = L;
    const upper = text => String(text).toLocaleUpperCase(L.code);
    const monitoringText = this._config.monitoring_label || L.text.monitoring;
    const divergenceText = this._config.divergence_label || L.text.divergence;

    let maxDiv = 0;
    let sumDiv = 0;

    for (let i = 0; i < this._entities.length; i++) {
      const ent = this._entities[i];
      // Missing entities are treated as unavailable so they don't freeze at their last divergence
      const stateObj = hass.states[ent.id];
      const rawState = stateObj ? stateObj.state : 'unavailable';
      const attrs = (stateObj && stateObj.attributes) || {};
      const friendly = ent.name || attrs.friendly_name || ent.id || 'SENSOR';
      const isUnavailable = rawState === 'unavailable' || rawState === 'unknown';

      let div = 0;
      const mapped = ent.stateMap ? Number(ent.stateMap[rawState]) : NaN;
      if (Number.isFinite(mapped)) {
        div = Math.max(0.0, Math.min(1.0, mapped));
      } else if (!isUnavailable) {
        const num = parseFloat(rawState);
        if (!Number.isNaN(num)) {
          // Directional normalization & clamping between baseline and critical
          div = computeDirectionalDivergence(num, ent.baseline, ent.critical);
        } else {
          // Binary "problem" states. Use state_map for anything else (e.g. person: { not_home: 1 }).
          const activeStates = ['on', 'open', 'detected', 'problem', 'unsafe', 'triggered'];
          div = activeStates.includes(String(rawState).toLowerCase()) ? 1.0 : 0.0;
        }
      }

      ent.targetDivergence = div;
      if (div > maxDiv) maxDiv = div;
      sumDiv += div;

      const nextFormatted = this._formatValue(hass, stateObj, ent, L);
      // Three callout states: hidden (or monitoring if always visible), monitoring, divergence
      const isDiverging = div >= ent.divergeAt;
      const isMonitoring = !isDiverging && div >= ent.monitorAt;
      const nextVisible = ent.alwaysVisible || isDiverging || isMonitoring;

      if (ent.domGroup) {
        if (ent.isVisible !== nextVisible || ent.wasDiverging !== isDiverging) {
          ent.isVisible = nextVisible;
          ent.wasDiverging = isDiverging;
          ent.domGroup.setAttribute('class', `callout ${nextVisible ? 'visible' : ''} ${isDiverging ? 'diverging' : 'monitoring'}`);
          this._labelsDirty = true;
        }

        const headerText = upper(`${isDiverging ? divergenceText : monitoringText}: ${ent.category || L.text.category}`);
        if (ent.lastHeader !== headerText && ent.domHeader) {
          ent.lastHeader = headerText;
          ent.domHeader.textContent = headerText;
          ent.textDirty = true;
          this._labelsDirty = true;
        }

        // The value keeps its case: upper case would change units (mW to MW, µg to ΜG)
        const subText = `${upper(friendly)} : ${nextFormatted}`;
        if (ent.formattedValue !== subText && ent.domSub) {
          ent.formattedValue = subText;
          ent.domSub.textContent = subText;
          ent.textDirty = true;
          this._labelsDirty = true;
        }
      }
    }

    if (this._config.test_divergence !== null) {
      this._targetEclipse = Math.max(0, Math.min(1, this._config.test_divergence));
    } else {
      const combined = Math.min(1.0, maxDiv * 0.78 + (sumDiv / Math.max(1, this._entities.length)) * 0.65);
      this._targetEclipse = combined * this._config.eclipse_intensity;
    }
  }

  _setTitleText(el, text) {
    if (!el) return;
    if (el.textContent !== text) el.textContent = text;
    if (this._titleBlock) this._titleBlock.hidden = !this._titleEl.textContent && !this._subtitleEl.textContent;
  }

  // Subtitle: plain text, or a Home Assistant template. Home Assistant renders the template and
  // sends a new result whenever it changes (render_template subscription); the card only writes
  // the text when it arrives.
  _syncSubtitle() {
    const source = (this._config && this._config.subtitle) || '';
    const isTemplate = /\{\{|\{%/.test(source);
    const canRender = isTemplate && this.isConnected && this._hass && this._hass.connection;
    if (canRender && this._subtitleKey === source) return;
    this._unsubscribeSubtitle();
    if (!isTemplate || !canRender) {
      this._setTitleText(this._subtitleEl, isTemplate ? '' : source);
      return;
    }
    const key = source;
    this._subtitleKey = key;
    const user = this._hass.user ? this._hass.user.name : '';
    const unsub = this._hass.connection.subscribeMessage(msg => {
      if (this._subtitleKey !== key || !msg) return;
      if ('result' in msg) this._setTitleText(this._subtitleEl, msg.result == null ? '' : String(msg.result));
      else if (msg.error) console.warn(`Rehoboam card: subtitle template: ${msg.error}`);
    }, { type: 'render_template', template: source, variables: { user }, strict: false, report_errors: true });
    this._subtitleUnsub = unsub;
    Promise.resolve(unsub).catch(err => {
      if (this._subtitleKey === key) this._setTitleText(this._subtitleEl, '');
      console.warn('Rehoboam card: subtitle template failed', (err && err.message) || err);
    });
  }

  _unsubscribeSubtitle() {
    const unsub = this._subtitleUnsub;
    this._subtitleUnsub = null;
    this._subtitleKey = null;
    if (unsub) Promise.resolve(unsub).then(fn => { if (typeof fn === 'function') fn(); }).catch(() => {});
  }

  // Callout value: Home Assistant's own format (localized numbers and states) where it exists.
  // A unit override keeps the localized number and replaces the unit.
  _formatValue(hass, stateObj, ent, L) {
    if (!stateObj) return L.text.unavailable;
    const raw = String(stateObj.state);
    const haFormat = typeof hass.formatEntityState === 'function';
    if (raw === 'unavailable' || raw === 'unknown') return haFormat ? hass.formatEntityState(stateObj) : raw;
    const num = raw.trim() === '' ? NaN : Number(raw);
    if (ent.unit === null) {
      if (haFormat) return hass.formatEntityState(stateObj);
      const unit = stateObj.attributes && stateObj.attributes.unit_of_measurement;
      return `${Number.isFinite(num) ? this._formatNumber(num, raw, L.code) : raw}${unit ? ' ' + unit : ''}`;
    }
    const value = Number.isFinite(num) ? this._formatNumber(num, raw, L.code) : haFormat ? hass.formatEntityState(stateObj) : raw;
    return `${value} ${ent.unit}`;
  }

  // Number in the card language with as many decimals as the state has
  _formatNumber(num, raw, lang) {
    const decimals = Math.min(6, (raw.split('.')[1] || '').length);
    const key = `${lang}:${decimals}`;
    if (!this._numberFormats) this._numberFormats = new Map();
    let format = this._numberFormats.get(key);
    if (!format) {
      try {
        format = new Intl.NumberFormat(lang, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
      } catch (err) {
        format = { format: n => String(n) };
      }
      this._numberFormats.set(key, format);
    }
    return format.format(num);
  }

  _ensureDOM() {
    if (this._domBuilt) return;
    this._domBuilt = true;

    this.shadowRoot.innerHTML = `
      <style id="theme-style"></style>
      <ha-card id="card">
        <div class="viewport" id="vp">
          <canvas id="gl-canvas"></canvas>
          <svg class="hud" id="hud-svg" preserveAspectRatio="xMidYMid meet"></svg>
          <div class="title-block" id="title-block" hidden>
            <div class="card-title" id="card-title"></div>
            <div class="card-subtitle" id="card-subtitle"></div>
          </div>
          <div class="gl-error" id="gl-error" hidden>
            Rehoboam card: WebGL is not available in this browser.
          </div>
        </div>
      </ha-card>
    `;

    this._styleEl = this.shadowRoot.getElementById('theme-style');
    this._canvas = this.shadowRoot.getElementById('gl-canvas');
    this._svg = this.shadowRoot.getElementById('hud-svg');
    this._vp = this.shadowRoot.getElementById('vp');
    this._glErrorEl = this.shadowRoot.getElementById('gl-error');
    this._titleBlock = this.shadowRoot.getElementById('title-block');
    this._titleEl = this.shadowRoot.getElementById('card-title');
    this._subtitleEl = this.shadowRoot.getElementById('card-subtitle');

    this._canvas.addEventListener('webglcontextlost', e => {
      // preventDefault is required for the context to be restorable
      e.preventDefault();
      this._gl = null;
      this._program = null;
    });
    this._canvas.addEventListener('webglcontextrestored', () => {
      this._initWebGL();
      this._syncUniforms();
      this._onResize();
      this._updateRunningState();
    });

    this._initWebGL();
  }

  // 'auto' follows Home Assistant's dark mode (hass.themes.darkMode)
  _isLight() {
    const mode = this._config ? this._config.theme_mode : 'dark';
    if (mode === 'auto') return !(this._hass && this._hass.themes && this._hass.themes.darkMode);
    return mode === 'light';
  }

  _applyThemeStyles() {
    if (!this._styleEl || !this._config) return;
    const isLight = this._isLight();
    this._appliedLight = isLight;
    const strokeCol = isLight ? '#22222A' : '#EAEAF0';
    const textCol = isLight ? '#181820' : '#F4F4F8';
    const subCol = isLight ? '#4A4A58' : '#B0B0BC';
    const bgCol = isLight ? '#F8F8FA' : '#060608';

    this._styleEl.textContent = `
      :host {
        display: block;
        width: 100%;
        height: 100%;
      }
      ha-card {
        display: block;
        width: 100%;
        height: ${this._config.height};
        min-height: 240px;
        background: ${bgCol} !important;
        border: none !important;
        box-shadow: none !important;
        border-radius: 0 !important;
        overflow: hidden;
        position: relative;
        user-select: none;
        -webkit-user-select: none;
        pointer-events: none;
      }
      .viewport {
        position: relative;
        width: 100%;
        height: 100%;
        min-height: 240px;
      }
      canvas {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        display: block;
      }
      svg.hud {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        overflow: visible;
        pointer-events: none;
      }
      .title-block {
        position: absolute;
        top: 14px;
        left: 16px;
        max-width: 55%;
        pointer-events: none;
        font-family: ${this._config.font_family};
      }
      .title-block[hidden] {
        display: none;
      }
      .card-title {
        color: ${textCol};
        font-size: ${Math.round(labelMetrics(this._config.font_size).header * 1.6)}px;
        font-weight: 600;
        letter-spacing: 2px;
        line-height: 1.15;
        text-transform: uppercase;
      }
      .card-subtitle {
        margin-top: 3px;
        color: ${subCol};
        font-size: ${labelMetrics(this._config.font_size).sub + 1}px;
        font-weight: 500;
        letter-spacing: 1px;
        line-height: 1.3;
        white-space: pre-line;
      }
      .card-title:empty,
      .card-subtitle:empty {
        display: none;
      }
      .gl-error {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
        text-align: center;
        color: ${textCol};
        font-family: 'Roboto', sans-serif;
        font-size: 14px;
      }
      .gl-error[hidden] {
        display: none;
      }
      /* Appear: the marker fades in (0.3 s), the leader draws out from it (1.1 s, even speed),
         and the labels fade in from the moment the line turns onto the shelf. Hide runs faster and all at once. Only these transitions
         repaint; the dash length is set per callout. */
      .callout .reticle-hex,
      .callout .reticle-inner,
      .callout .reticle-dot,
      .callout .leader,
      .callout text {
        transition: opacity 0.25s ease-out, stroke-dashoffset 0.35s ease-in;
      }
      .callout:not(.visible) .reticle-hex,
      .callout:not(.visible) .reticle-inner,
      .callout:not(.visible) .reticle-dot,
      .callout:not(.visible) .leader,
      .callout:not(.visible) text {
        opacity: 0;
      }
      .callout.visible .reticle-hex,
      .callout.visible .reticle-inner,
      .callout.visible .reticle-dot {
        transition: opacity 0.3s ease-out;
      }
      .callout.visible .leader {
        stroke-dashoffset: 0;
        transition: stroke-dashoffset ${LEADER_DRAW_S}s cubic-bezier(${LEADER_EASE.join(', ')}) ${LEADER_DELAY_S}s;
      }
      .callout.visible text {
        transition: opacity 0.55s ease-out var(--text-delay, 0.6s);
      }
      .hit {
        fill: transparent;
        stroke: none;
        pointer-events: all;
        cursor: pointer;
        -webkit-tap-highlight-color: transparent;
      }
      .callout:not(.visible) .hit {
        pointer-events: none;
      }
      .reticle-hex {
        fill: none;
        stroke: ${strokeCol};
        stroke-width: 1.1;
        opacity: 0.78;
      }
      .reticle-inner {
        fill: none;
        stroke: ${strokeCol};
        stroke-width: 1.4;
      }
      .reticle-dot {
        fill: ${strokeCol};
        stroke: none;
      }
      .leader {
        fill: none;
        stroke: ${strokeCol};
        stroke-width: 1.15;
        stroke-linecap: round;
        stroke-linejoin: round;
        opacity: 0.88;
      }
      .label-header {
        fill: ${textCol};
        font-family: ${this._config.font_family};
        font-size: ${labelMetrics(this._config.font_size).header}px;
        font-weight: 600;
        letter-spacing: 1.2px;
      }
      .label-sub {
        fill: ${subCol};
        font-family: ${this._config.font_family};
        font-size: ${labelMetrics(this._config.font_size).sub}px;
        font-weight: 500;
        letter-spacing: 1px;
      }
    `;
  }

  _updateRunningState() {
    const shouldRun = !document.hidden && this._inViewport !== false;
    this._isVisible = shouldRun;
    if (shouldRun && !this._rafId && this._gl) {
      const now = performance.now();
      this._lastFrameTime = now;
      this._lastSimTimeSec = now * 0.001;
      this._rafId = requestAnimationFrame(t => this._tick(t));
    } else if (!shouldRun && this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  connectedCallback() {
    if (this._loseContextTimer) {
      clearTimeout(this._loseContextTimer);
      this._loseContextTimer = null;
    }

    this._ensureDOM();

    if (this._contextManuallyLost) {
      this._contextManuallyLost = false;
      if (this._loseContextExt) {
        try {
          this._loseContextExt.restoreContext();
        } catch (_) {
          this._initWebGL();
        }
      } else {
        this._initWebGL();
      }
      this._syncUniforms();
    }

    if (!this._resizeObserver && window.ResizeObserver) {
      this._resizeObserver = new ResizeObserver(() => this._onResize());
    }
    if (this._resizeObserver && this._vp) {
      this._resizeObserver.observe(this._vp);
    }

    if (!this._intersectionObserver && window.IntersectionObserver) {
      this._intersectionObserver = new IntersectionObserver(entries => {
        for (const entry of entries) {
          this._inViewport = entry.isIntersecting;
        }
        this._updateRunningState();
      });
    }
    if (this._intersectionObserver && this._vp) {
      this._intersectionObserver.observe(this._vp);
    }

    if (!this._visHandler) {
      this._visHandler = () => this._updateRunningState();
    }
    document.addEventListener('visibilitychange', this._visHandler);

    // Re-fit the shelves once the label font has loaded (it changes the text widths)
    if (!this._fontHandler && document.fonts) {
      this._fontHandler = () => {
        this._entities.forEach(e => { e.textDirty = true; });
        this._labelsDirty = true;
        this._updateCalloutTipPositions();
      };
    }
    if (this._fontHandler) {
      document.fonts.addEventListener('loadingdone', this._fontHandler);
      document.fonts.ready.then(this._fontHandler);
    }

    this._onResize();
    this._resizeTimer = setTimeout(() => this._onResize(), 100);

    this._inViewport = true;
    this._updateRunningState();
    this._syncSubtitle();
  }

  disconnectedCallback() {
    this._unsubscribeSubtitle();
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = null;
    if (this._resizeTimer) {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = null;
    }
    if (this._resizeObserver) this._resizeObserver.disconnect();
    if (this._intersectionObserver) this._intersectionObserver.disconnect();
    if (this._visHandler) document.removeEventListener('visibilitychange', this._visHandler);
    if (this._fontHandler) document.fonts.removeEventListener('loadingdone', this._fontHandler);

    // Release WebGL context after a short grace period so detached editor previews
    // don't exhaust the browser's ~16 active context limit, while brief DOM moves survive.
    if (this._gl && !this._loseContextTimer) {
      this._loseContextTimer = setTimeout(() => {
        this._loseContextTimer = null;
        if (!this.isConnected && this._gl) {
          this._loseContextExt = this._gl.getExtension('WEBGL_lose_context');
          if (this._loseContextExt) {
            this._contextManuallyLost = true;
            this._loseContextExt.loseContext();
          }
        }
      }, 1000);
    }
  }

  _initWebGL() {
    if (!this._canvas) return;
    const glOpts = {
      alpha: false,
      depth: false,
      stencil: false,
      antialias: false,
      preserveDrawingBuffer: false,
      powerPreference: 'low-power'
    };
    const gl = this._canvas.getContext('webgl', glOpts) || this._canvas.getContext('experimental-webgl', glOpts);
    if (!gl) {
      if (this._glErrorEl) this._glErrorEl.hidden = false;
      return;
    }
    this._gl = gl;

    const vs = this._compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = this._compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    if (!vs || !fs) {
      if (this._glErrorEl) this._glErrorEl.hidden = false;
      return;
    }

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('RehoboamCard program link error:', gl.getProgramInfoLog(prog));
      gl.deleteProgram(prog);
      if (this._glErrorEl) this._glErrorEl.hidden = false;
      return;
    }
    if (this._glErrorEl) this._glErrorEl.hidden = true;
    gl.useProgram(prog);
    this._program = prog;

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    );

    const aPos = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, LUT_SIZE, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, this._lutData);
    this._lutTex = tex;

    this._uAspect = gl.getUniformLocation(prog, 'u_aspect');
    this._uEclipse = gl.getUniformLocation(prog, 'u_eclipse');
    this._uEclipseDir = gl.getUniformLocation(prog, 'u_eclipse_dir');
    this._uLightMode = gl.getUniformLocation(prog, 'u_light_mode');
    this._uAmpScale = gl.getUniformLocation(prog, 'u_amp_scale');
    this._uRayIntensity = gl.getUniformLocation(prog, 'u_ray_intensity');
    this._uFacet = gl.getUniformLocation(prog, 'u_facet');
    this._uRingShade = gl.getUniformLocation(prog, 'u_ring_shade');
    this._uBandPhase = gl.getUniformLocation(prog, 'u_band_phase');
    this._uWobble = gl.getUniformLocation(prog, 'u_wobble');
    this._uPxSize = gl.getUniformLocation(prog, 'u_px_size');
  }

  _syncUniforms() {
    if (!this._gl || !this._program || !this._config) return;
    const gl = this._gl;
    gl.useProgram(this._program);
    gl.uniform2f(this._uEclipseDir, Math.cos(this._eclipseAngle), Math.sin(this._eclipseAngle));
    gl.uniform1f(this._uLightMode, this._isLight() ? 1.0 : 0.0);
    gl.uniform1f(this._uAmpScale, this._config.amplitude_scale);
    gl.uniform1f(this._uRayIntensity, this._config.ray_intensity);
    gl.uniform1f(this._uFacet, this._config.facet_shading);
    gl.uniform1f(this._uRingShade, this._config.ring_shading ? 1.0 : 0.0);
  }

  _compileShader(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error('RehoboamCard shader error:', gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  }

  _onResize() {
    if (!this._vp || !this._config) return;
    const rect = this._vp.getBoundingClientRect();
    const w = Math.max(200, rect.width > 50 ? rect.width : window.innerWidth);
    const h = Math.max(200, rect.height > 50 ? rect.height : window.innerHeight);
    this._vpWidth = w;
    this._vpHeight = h;

    const minDim = Math.min(w, h);
    this._ringRadiusPx = (minDim * 0.5) * this._config.ring_scale;

    if (this._gl && this._program) {
      const scale = this._config.resolution_scale;
      const cw = Math.max(1, Math.round(w * scale));
      const ch = Math.max(1, Math.round(h * scale));

      if (this._canvas.width !== cw || this._canvas.height !== ch) {
        this._canvas.width = cw;
        this._canvas.height = ch;
        this._gl.viewport(0, 0, cw, ch);
      }

      const aspectX = (w * 0.5) / this._ringRadiusPx;
      const aspectY = (h * 0.5) / this._ringRadiusPx;
      // One canvas pixel in ring units. Narrower AA than this aliases the spike flanks.
      const pxSize = 1.0 / Math.max(30.0, this._ringRadiusPx * scale);
      this._gl.useProgram(this._program);
      this._gl.uniform2f(this._uAspect, aspectX, aspectY);
      this._gl.uniform1f(this._uPxSize, pxSize);
    }

    this._layoutHUD(w, h, this._ringRadiusPx);
  }

  _centerActionConfig() {
    const c = this._config;
    return {
      entity: c.center_entity || undefined,
      tap_action: c.center_tap_action || NO_ACTION,
      hold_action: c.center_hold_action || NO_ACTION
    };
  }

  _entityActionConfig(ent) {
    return {
      entity: ent.id || undefined,
      tap_action: ent.tapAction || { action: 'more-info' },
      hold_action: ent.holdAction || NO_ACTION
    };
  }

  // Home Assistant's card wrapper handles 'hass-action' (more-info, toggle, navigate, url,
  // perform-action, fire-dom-event for browser_mod, ...), the same as for built-in cards
  _fireAction(config, action) {
    this.dispatchEvent(new CustomEvent('hass-action', {
      bubbles: true,
      composed: true,
      detail: { config, action }
    }));
  }

  // Tap fires on release; hold fires after hold_time ms if a hold action is set. A drag (scrolling
  // the dashboard) cancels both.
  _bindActions(el, getConfig) {
    const isSet = a => a && a.action && a.action !== 'none';
    if (!window.PointerEvent) {
      el.addEventListener('click', () => this._fireAction(getConfig(), 'tap'));
      return;
    }
    let timer = null;
    let active = false;
    let held = false;
    let startX = 0;
    let startY = 0;
    const clear = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    el.addEventListener('pointerdown', ev => {
      active = true;
      held = false;
      startX = ev.clientX;
      startY = ev.clientY;
      if (isSet(getConfig().hold_action)) {
        timer = setTimeout(() => {
          timer = null;
          held = true;
          this._fireAction(getConfig(), 'hold');
        }, this._config.hold_time);
      }
    });
    el.addEventListener('pointermove', ev => {
      if (active && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > TAP_MOVE_TOLERANCE_PX) {
        active = false;
        clear();
      }
    });
    el.addEventListener('pointerup', () => {
      clear();
      if (active && !held && isSet(getConfig().tap_action)) this._fireAction(getConfig(), 'tap');
      active = false;
    });
    el.addEventListener('pointercancel', () => { active = false; clear(); });
    el.addEventListener('pointerleave', () => { active = false; clear(); });
    el.addEventListener('contextmenu', ev => ev.preventDefault());
  }

  _buildHUD() {
    if (!this._svg) return;
    this._svg.innerHTML = '';

    const ns = 'http://www.w3.org/2000/svg';
    const isSet = a => a && a.action && a.action !== 'none';
    this._centerHit = null;
    const center = this._centerActionConfig();
    if (isSet(center.tap_action) || isSet(center.hold_action)) {
      const hit = document.createElementNS(ns, 'circle');
      hit.setAttribute('class', 'hit');
      this._bindActions(hit, () => this._centerActionConfig());
      this._svg.appendChild(hit);
      this._centerHit = hit;
    }

    for (let i = 0; i < this._entities.length; i++) {
      const ent = this._entities[i];
      const g = document.createElementNS(ns, 'g');
      g.setAttribute('class', `callout ${ent.alwaysVisible ? 'visible' : ''}`);

      // Transparent tap area over the reticle, leader and labels; only live while visible
      const hitRect = document.createElementNS(ns, 'rect');
      hitRect.setAttribute('class', 'hit');
      this._bindActions(hitRect, () => this._entityActionConfig(ent));
      g.appendChild(hitRect);
      ent.domHit = hitRect;

      const hex = document.createElementNS(ns, 'polygon');
      hex.setAttribute('class', 'reticle-hex');
      hex.setAttribute('points', hexPoints(10.5));

      const cIn = document.createElementNS(ns, 'circle');
      cIn.setAttribute('class', 'reticle-inner');
      cIn.setAttribute('r', '4.2');

      const dot = document.createElementNS(ns, 'circle');
      dot.setAttribute('class', 'reticle-dot');
      dot.setAttribute('r', '1.3');

      const poly = document.createElementNS(ns, 'polyline');
      poly.setAttribute('class', 'leader');

      const tHeader = document.createElementNS(ns, 'text');
      tHeader.setAttribute('class', 'label-header');
      const L = this._i18n || i18n(this._config.language);
      tHeader.textContent = `${this._config.monitoring_label || L.text.monitoring}: ${ent.category || L.text.category}`.toUpperCase();

      const tSub = document.createElementNS(ns, 'text');
      tSub.setAttribute('class', 'label-sub');
      tSub.textContent = `${ent.resolvedName.toUpperCase()} : --`;

      g.appendChild(hex);
      g.appendChild(cIn);
      g.appendChild(dot);
      g.appendChild(poly);
      g.appendChild(tHeader);
      g.appendChild(tSub);
      this._svg.appendChild(g);

      ent.domGroup = g;
      ent.domPoly = poly;
      ent.domHeader = tHeader;
      ent.domSub = tSub;
    }
  }

  _layoutHUD(w, h, ringRadiusPx) {
    if (!this._svg) return;
    this._svg.setAttribute('viewBox', `0 0 ${w} ${h}`);

    if (this._centerHit) {
      this._centerHit.setAttribute('cx', (w * 0.5).toFixed(1));
      this._centerHit.setAttribute('cy', (h * 0.5).toFixed(1));
      this._centerHit.setAttribute('r', (ringRadiusPx * 0.9).toFixed(1));
    }

    for (let i = 0; i < this._entities.length; i++) {
      const ent = this._entities[i];
      if (!ent.domGroup) continue;

      const cosA = Math.cos(ent.angleRad);
      const sinA = Math.sin(ent.angleRad);
      const isRight = cosA >= 0;
      const isTop = sinA >= 0;
      const dirX = isRight ? 1 : -1;
      const dirY = isTop ? -1 : 1;

      const diagAngle = Math.atan2(dirY * 1.15, dirX * 0.45);
      const sx = Math.cos(diagAngle) * 10.5;
      const sy = Math.sin(diagAngle) * 10.5;

      const diagX = dirX * Math.max(18, ringRadiusPx * 0.09);
      const diagY = dirY * Math.max(42, ringRadiusPx * 0.25);
      // The shelf ends just past the longer label (measured when the text changes)
      const shelfLen = ent.textWidth ? ent.textWidth + SHELF_PAD : Math.min(220, Math.max(140, w * 0.16));
      const x2 = diagX + dirX * shelfLen;
      const anchor = isRight ? 'start' : 'end';

      ent.domHeader.setAttribute('text-anchor', anchor);
      ent.domSub.setAttribute('text-anchor', anchor);

      ent.hud = { isRight, sx, sy, diagX, diagY, x2 };
      ent.textDirty = true;
      this._applyLabelOffset(ent, ent.labelDx || 0, ent.labelDy || 0, true);
    }

    this._labelsDirty = true;
    this._updateCalloutTipPositions();
  }

  // Moves a callout's corner, shelf and labels by (dx, dy) (to clear another label or the card
  // edge) and keeps the leader, the draw-on dash length and the tap area in step
  _applyLabelOffset(ent, dx, dy, force = false) {
    const g = ent.hud;
    if (!g) return;
    if (!force && Math.abs(dy - (ent.labelDy || 0)) < 0.5 && Math.abs(dx - (ent.labelDx || 0)) < 0.5) return;
    ent.labelDy = dy;
    ent.labelDx = dx;
    const y = g.diagY + dy;
    const cx = g.diagX + dx;
    const x2 = g.x2 + dx;
    // The line leaves the hexagon edge on the line from the marker centre to the (possibly moved)
    // corner, so it always points at the centre
    const toCorner = Math.atan2(y, cx);
    const sx = Math.cos(toCorner) * 10.5;
    const sy = Math.sin(toCorner) * 10.5;
    ent.domPoly.setAttribute(
      'points',
      `${sx.toFixed(1)},${sy.toFixed(1)} ${cx.toFixed(1)},${y.toFixed(1)} ${x2.toFixed(1)},${y.toFixed(1)}`
    );
    const diagLen = Math.hypot(cx - sx, y - sy);
    const len = diagLen + Math.abs(x2 - cx);
    // The gap is longer than the line, so rounding never leaves a dot of the next dash at the end
    ent.domPoly.setAttribute('stroke-dasharray', `${len.toFixed(1)} ${(len + 20).toFixed(1)}`);
    ent.domPoly.setAttribute('stroke-dashoffset', (len + 1).toFixed(1));
    // Labels start to fade in when the line turns its corner onto the shelf
    const cornerS = LEADER_DELAY_S + LEADER_DRAW_S * easeTimeForProgress(diagLen / len, LEADER_EASE);
    ent.domGroup.style.setProperty('--text-delay', `${cornerS.toFixed(2)}s`);
    const textX = (cx + (g.isRight ? 6 : -6)).toFixed(1);
    ent.domHeader.setAttribute('x', textX);
    ent.domSub.setAttribute('x', textX);
    const lm = labelMetrics(this._config.font_size);
    ent.domHeader.setAttribute('y', (y - lm.headerY).toFixed(1));
    ent.domSub.setAttribute('y', (y - lm.subY).toFixed(1));
    if (ent.domHit) {
      const xMin = Math.min(-14, cx, x2 - (g.isRight ? 0 : 20));
      const xMax = Math.max(14, cx, x2 + (g.isRight ? 20 : 0));
      const yMin = Math.min(-14, y - lm.top - 2);
      const yMax = Math.max(14, y + 6);
      ent.domHit.setAttribute('x', xMin.toFixed(1));
      ent.domHit.setAttribute('y', yMin.toFixed(1));
      ent.domHit.setAttribute('width', (xMax - xMin).toFixed(1));
      ent.domHit.setAttribute('height', (yMax - yMin).toFixed(1));
    }
  }

  // Places the visible labels on each side of the ring:
  // 1. at least the label height plus LABEL_GAP_EXTRA apart: sorted top to bottom, each one is
  //    pushed below the one above it;
  // 2. inside the card, within limits: the corner slides inward by up to the diagonal's width plus
  //    EDGE_MAX_X, and a label moves back from the top or bottom edge by up to EDGE_MAX_Y. Labels
  //    that need more than that stay partly outside; then ring_scale or the angles need a change.
  _resolveLabelOverlap() {
    const w = this._vpWidth;
    const h = this._vpHeight;
    const lm = labelMetrics(this._config.font_size);
    for (const right of [true, false]) {
      const list = this._entities.filter(e => e.hud && e.isVisible && e.hud.isRight === right);
      list.sort((a, b) => (a.tipY + a.hud.diagY) - (b.tipY + b.hud.diagY));
      let prev = -Infinity;
      for (const ent of list) {
        const g = ent.hud;
        const y = ent.tipY + g.diagY;
        let dy = Math.max(y, prev + lm.gap) - y;
        prev = y + dy;

        const top = y + dy - lm.top;
        const bottom = y + dy + 6;
        if (top < EDGE_MARGIN) dy += Math.min(EDGE_MARGIN - top, EDGE_MAX_Y);
        else if (bottom > h - EDGE_MARGIN) dy -= Math.min(bottom - (h - EDGE_MARGIN), EDGE_MAX_Y);

        const outer = ent.tipX + g.x2;
        const maxShift = Math.abs(g.diagX) + EDGE_MAX_X;
        let dx = 0;
        if (right && outer > w - EDGE_MARGIN) dx = -Math.min(outer - (w - EDGE_MARGIN), maxShift);
        else if (!right && outer < EDGE_MARGIN) dx = Math.min(EDGE_MARGIN - outer, maxShift);

        this._applyLabelOffset(ent, dx, dy);
      }
    }
  }

  _updateCalloutTipPositions() {
    if (!this._config) return;
    const cx = this._vpWidth * 0.5;
    const cy = this._vpHeight * 0.5;
    const R = this._ringRadiusPx;
    const ampScale = this._config.amplitude_scale;
    // The LUT clamps heights at 1.0, so the callout never sits above that
    const peakTop = Math.min(1.0, LAYER_CONFIG[0].height * this._config.peak_height);
    let moved = false;

    for (let i = 0; i < this._entities.length; i++) {
      const ent = this._entities[i];
      if (!ent.domGroup) continue;
      // Anchored at the peak's full height; breathing only pulls the peak in below it
      const severityRadius = 0.992 + ent.currentDivergence * 0.58 * ampScale * peakTop;
      const tipPx = R * severityRadius;
      const tx = cx + Math.cos(ent.angleRad) * tipPx;
      const ty = cy - Math.sin(ent.angleRad) * tipPx;
      // Skip unchanged positions: an SVG attribute write costs a style and layout pass every frame
      const transform = `translate(${tx.toFixed(1)}, ${ty.toFixed(1)})`;
      ent.tipX = tx;
      ent.tipY = ty;
      if (transform !== ent.lastTransform) {
        ent.lastTransform = transform;
        ent.domGroup.setAttribute('transform', transform);
        moved = true;
      }
    }
    if (moved || this._labelsDirty) {
      this._labelsDirty = false;
      this._fitShelves();
      this._resolveLabelOverlap();
    }
  }

  // Re-measures labels whose text changed and fits the shelf to the longer one. Text measurement
  // forces a layout, so it runs only for changed callouts, not per frame.
  _fitShelves() {
    for (let i = 0; i < this._entities.length; i++) {
      const ent = this._entities[i];
      if (!ent.textDirty || !ent.hud) continue;
      ent.textDirty = false;
      let width = 0;
      try {
        width = Math.max(ent.domHeader.getComputedTextLength(), ent.domSub.getComputedTextLength());
      } catch (_) {
        continue;
      }
      if (!(width > 0) || Math.abs(width - (ent.textWidth || 0)) < 0.5) continue;
      ent.textWidth = width;
      const g = ent.hud;
      g.x2 = g.diagX + (g.isRight ? 1 : -1) * (width + SHELF_PAD);
      this._applyLabelOffset(ent, ent.labelDx || 0, ent.labelDy || 0, true);
    }
  }

  // The flank modulation depends only on the offset from the spike centre, so each layer's spike
  // profile is built once per frame and shared between all spikes that use the same envelopes.
  _buildProfile(env, k, tLayer) {
    const cfg = LAYER_CONFIG[k];
    const sinLut = FAST_SIN_LUT;
    const nL = env.left[k];
    const nR = env.right[k];
    const envBase = env.base[k];
    const envMod = env.mod[k];
    const profile = env.profile[k];
    const lobeStep1 = cfg.lobeFreq * env.freqScale[k] * RAD_TO_SIN_IDX;
    const lobeStep2 = lobeStep1 * 1.9;
    const jagStep = cfg.jagFreq * env.freqScale[k] * RAD_TO_SIN_IDX;
    const jagAmp = cfg.jag;
    const lobeAmp = cfg.lobe;
    const tCos = Math.round((-tLayer * 1.4 + k * 0.9) * RAD_TO_SIN_IDX) + COS_LUT_OFFSET + 65536.5;
    const tSin = Math.round(tLayer * 1.1 * RAD_TO_SIN_IDX) + 65536.5;
    const tJag = Math.round((tLayer * 0.7 + k * 1.7) * RAD_TO_SIN_IDX) + 65536.5;
    for (let d = -nL; d <= nR; d++) {
      const e = d + nL;
      const sj = sinLut[(d * jagStep + tJag) & SIN_LUT_MASK];
      const osc = lobeAmp * sinLut[(d * lobeStep1 + tCos) & SIN_LUT_MASK] +
        0.5 * lobeAmp * sinLut[(d * lobeStep2 + tSin) & SIN_LUT_MASK] +
        jagAmp * (1.0 - 2.0 * (sj < 0.0 ? -sj : sj));
      profile[e + 1] = envBase[e] + envMod[e] * osc;
    }
  }

  // Stamp the profile only over each spike's own window, shifted by its sway and scaled by its
  // breathing. The fractional part of the shift blends neighbouring entries, so the spike glides
  // instead of stepping by whole bins.
  _stampLayer(env, k, spikes, count, timeSec) {
    const cfg = LAYER_CONFIG[k];
    const vals = this._layerVals;
    const rowBase = k * LUT_SIZE;
    const nL = env.left[k];
    const nR = env.right[k];
    const profile = env.profile[k];
    const offsetBins = env.offset[k];
    const nLast = nL + nR + 2;
    for (let s = 0; s < count; s++) {
      const spike = spikes[s];
      const dir = spike.leanDir;
      const ph = spike.motionPhase + k * 1.3;
      const div = spike.currentDivergence *
        (1.0 - cfg.breathe * (0.5 + 0.5 * Math.sin(timeSec * (0.8 + 0.13 * k) + ph)));
      const sway = cfg.sway * Math.sin(timeSec * (0.55 + 0.11 * k) + ph * 1.7);
      const swayInt = Math.floor(sway);
      const swayFrac = sway - swayInt;
      const start = spike.binCenter + dir * (offsetBins + swayInt - nL - 1) + LUT_SIZE;
      let prevQ = 0.0;
      for (let e = 1; e <= nLast; e++) {
        const q = profile[e];
        const peak = div * (q + swayFrac * (prevQ - q));
        prevQ = q;
        const idx = rowBase + ((start + dir * e) & LUT_MASK);
        if (peak > vals[idx]) vals[idx] = peak;
      }
    }
  }

  // Picks a random bin in a calm part of the ring: clear of every diverging entity's strata and of
  // the other ambient strata. The first random candidate that is clear wins, so positions stay
  // random; only on a crowded ring, where no candidate is clear, the most open one is taken.
  _pickCalmBin(self) {
    const c = this._config;
    // Measured on the broad base stratum (layer 2); the outer layers are too low to count
    const hill = LAYER_CONFIG[FIRST_STRATA_LAYER];
    const reach = hill.cutoff * (1.0 + hill.lean);
    const entReach = reach * c.strata_width;
    const ghostReach = reach * c.ambient_width;
    const half = LUT_SIZE >> 1;
    const dist = (a, b) => {
      const d = Math.abs(a - b) & LUT_MASK;
      return d > half ? LUT_SIZE - d : d;
    };
    let best = 0;
    let bestClear = -Infinity;
    for (let tries = 0; tries < 16; tries++) {
      const bin = (Math.random() * LUT_SIZE) | 0;
      let clear = Infinity;
      for (const ent of this._entities) {
        if (Math.max(ent.currentDivergence, ent.targetDivergence) < 0.05) continue;
        clear = Math.min(clear, dist(bin, ent.binCenter) - (entReach + 0.6 * ghostReach));
      }
      for (let i = 0; i < Math.min(c.ambient_count, this._ambient.length); i++) {
        const m = this._ambient[i];
        if (m === self || m.binCenter === undefined) continue;
        clear = Math.min(clear, dist(bin, m.binCenter) - 1.2 * ghostReach);
      }
      if (clear >= 0) return bin;
      if (clear > bestClear) {
        bestClear = clear;
        best = bin;
      }
    }
    return best;
  }

  // Ambient strata: low strata in calm parts of the ring, with no entity or callout behind them.
  // Each one rises and sinks over its lifetime (sin^2), then comes back somewhere else.
  _updateAmbient(timeSec) {
    const c = this._config;
    const count = c.ambient_count;
    const pool = this._ambient || (this._ambient = []);
    const spawn = (m, born) => {
      m.binCenter = this._pickCalmBin(m);
      m.leanDir = Math.random() < 0.5 ? -1 : 1;
      m.motionPhase = Math.random() * TWO_PI;
      // Kept as factors, so size and lifetime changes apply at once
      m.lifeRand = 0.6 + 0.8 * Math.random();
      m.peakRand = 0.5 + 0.5 * Math.random();
      m.born = born;
    };
    while (pool.length < count) {
      const m = {};
      pool.push(m);
      spawn(m, 0);
      // Stagger the first ones so they do not all rise together
      m.born = timeSec - Math.random() * c.ambient_lifetime * m.lifeRand;
    }
    for (let i = 0; i < count; i++) {
      const m = pool[i];
      let u = (timeSec - m.born) / (c.ambient_lifetime * m.lifeRand);
      if (u >= 1.0 || u < 0.0) {
        spawn(m, timeSec);
        u = 0.0;
      }
      const rise = Math.sin(Math.PI * u);
      m.currentDivergence = c.ambient_size * m.peakRand * rise * rise;
    }
    return count;
  }

  _updatePolarLUT(timeSec) {
    const dt = Math.min(0.1, Math.max(0.001, timeSec - this._lastSimTimeSec));
    this._lastSimTimeSec = timeSec;

    const tau = Math.max(0.2, this._config.transition_tau);
    const smoothFactor = 1.0 - Math.exp(-dt / tau);

    this._currentEclipse += (this._targetEclipse - this._currentEclipse) * smoothFactor;
    const ec = this._currentEclipse;

    const active = this._activeScratch;
    active.length = 0;
    for (let s = 0; s < this._entities.length; s++) {
      const ent = this._entities[s];
      ent.currentDivergence += (ent.targetDivergence - ent.currentDivergence) * smoothFactor;
      if (ent.currentDivergence >= 0.005) {
        active.push(ent);
      }
    }
    const activeCount = active.length;

    // Eclipse follow: turn toward the divergence-weighted direction (cubed, so the worst entity
    // dominates), easing at about twice the transition time
    if (this._config.eclipse_follow) {
      let vx = 0;
      let vy = 0;
      for (let s = 0; s < this._entities.length; s++) {
        const ent = this._entities[s];
        const w = ent.currentDivergence * ent.currentDivergence * ent.currentDivergence;
        vx += w * ent.cosA;
        vy += w * ent.sinA;
      }
      if (vx * vx + vy * vy > 1e-8) {
        const target = Math.atan2(vy, vx);
        if (!this._eclipseAimed) {
          this._eclipseAngle = target;
          this._eclipseAimed = true;
        } else {
          const diff = Math.atan2(Math.sin(target - this._eclipseAngle), Math.cos(target - this._eclipseAngle));
          this._eclipseAngle += diff * (1.0 - Math.exp(-dt / Math.max(1.0, 2.0 * tau)));
        }
      }
    }

    const sinLut = FAST_SIN_LUT;
    const ecBoost = 1.0 + 0.65 * ec;
    const baselineHeight = this._config.baseline_height;
    const c = this._config;
    const envKey = `${c.strata_width}|${c.peak_width}|${c.peak_sharpness}|${c.peak_height}`;
    if (this._envKey !== envKey) {
      this._env = buildLayerEnvelopes(c.strata_width, c.peak_width, c.peak_sharpness, c.peak_height);
      this._envKey = envKey;
    }
    const env = this._env;
    const ambientCount = this._updateAmbient(timeSec);
    let ambientEnv = null;
    if (ambientCount > 0) {
      if (this._ambientEnvWidth !== c.ambient_width) {
        this._ambientEnv = buildLayerEnvelopes(c.ambient_width, 1.0, 0, 1.0);
        this._ambientEnvWidth = c.ambient_width;
      }
      ambientEnv = this._ambientEnv;
    }
    const vals = this._layerVals;
    const warpScale = 0.45 * RAD_TO_SIN_IDX;

    for (let k = 0; k < 7; k++) {
      const cfg = LAYER_CONFIG[k];
      const rowBase = k * LUT_SIZE;
      const tLayer = timeSec * cfg.speed + cfg.phase;
      const tWarp = Math.round(tLayer * 0.45 * RAD_TO_SIN_IDX);
      const tFreq1 = Math.round(tLayer * RAD_TO_SIN_IDX) + 65536;
      const tFreq2 = 65536 + COS_LUT_OFFSET - Math.round(tLayer * 1.15 * RAD_TO_SIN_IDX);
      const step1 = cfg.freq1 * 4;
      const step2 = cfg.freq2 * 4;
      const amp = cfg.baseAmp * ecBoost * baselineHeight;

      // Resting rim: smooth, low undulations, so the ring reads as a thick band
      for (let i = 0; i < LUT_SIZE; i++) {
        const warpIdx = (warpScale * sinLut[((i << 3) - tWarp) & SIN_LUT_MASK] + 0.5) | 0;
        const s1 = sinLut[(i * step1 + warpIdx + tFreq1) & SIN_LUT_MASK];
        const w = 0.50 + 0.30 * s1 +
          0.20 * sinLut[(i * step2 + tFreq2) & SIN_LUT_MASK];
        vals[rowBase + i] = w > 0.0 ? amp * w : 0.0;
      }

      if (activeCount > 0) {
        this._buildProfile(env, k, tLayer);
        this._stampLayer(env, k, active, activeCount, timeSec);
      }
      // Ambient strata use only the lower strata layers, with their own width
      if (ambientCount > 0 && k >= FIRST_STRATA_LAYER) {
        this._buildProfile(ambientEnv, k, tLayer);
        this._stampLayer(ambientEnv, k, this._ambient, ambientCount, timeSec);
      }
    }

    const tRay37Idx = Math.round(timeSec * 0.35 * RAD_TO_SIN_IDX);
    const tRay71Idx = Math.round(timeSec * 0.25 * RAD_TO_SIN_IDX) + COS_LUT_OFFSET;
    const rayHash = this._rayBaseHash;
    const data = this._lutData;
    const row1Offset = LUT_SIZE * 4;
    const L = LUT_SIZE;

    // Non-linear sqrt encoding gives ~8x more 8-bit resolution for subtle baseline waves.
    // Uint8ClampedArray clamps to [0, 255] and rounds, so no manual clamp is needed.
    for (let i = 0; i < L; i++) {
      const i4 = i << 2;
      const v0 = vals[i], v1 = vals[L + i], v2 = vals[2 * L + i], v3 = vals[3 * L + i];
      const v4 = vals[4 * L + i], v5 = vals[5 * L + i], v6 = vals[6 * L + i];
      data[i4]     = Math.sqrt(v0 < 1.0 ? v0 : 1.0) * 255.0;
      data[i4 + 1] = Math.sqrt(v1 < 1.0 ? v1 : 1.0) * 255.0;
      data[i4 + 2] = Math.sqrt(v2 < 1.0 ? v2 : 1.0) * 255.0;
      data[i4 + 3] = Math.sqrt(v3 < 1.0 ? v3 : 1.0) * 255.0;

      const j4 = row1Offset + i4;
      data[j4]     = Math.sqrt(v4 < 1.0 ? v4 : 1.0) * 255.0;
      data[j4 + 1] = Math.sqrt(v5 < 1.0 ? v5 : 1.0) * 255.0;
      data[j4 + 2] = Math.sqrt(v6 < 1.0 ? v6 : 1.0) * 255.0;
      data[j4 + 3] = (0.78 * rayHash[i] +
        0.13 * sinLut[(i * 148 - tRay37Idx) & SIN_LUT_MASK] +
        0.09 * sinLut[(i * 284 + tRay71Idx) & SIN_LUT_MASK]) * 255.0;
    }
  }

  _tick(now) {
    if (!this._isVisible) {
      this._rafId = null;
      return;
    }

    if (this._config && this._gl) {
      const isDiverging = this._currentEclipse > 0.05 || this._targetEclipse > 0.05;
      const targetFps = isDiverging ? this._config.fps_active : this._config.fps_idle;
      const frameInterval = 1000 / targetFps;

      const elapsed = now - this._lastFrameTime;
      if (elapsed >= frameInterval) {
        this._lastFrameTime = now - (elapsed % frameInterval);
        const gl = this._gl;

        this._updatePolarLUT(now * 0.001);
        this._updateCalloutTipPositions();

        gl.bindTexture(gl.TEXTURE_2D, this._lutTex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LUT_SIZE, 2, gl.RGBA, gl.UNSIGNED_BYTE, this._lutData);

        gl.useProgram(this._program);
        gl.uniform1f(this._uEclipse, this._currentEclipse);
        if (this._config.eclipse_follow) {
          gl.uniform2f(this._uEclipseDir, Math.cos(this._eclipseAngle), Math.sin(this._eclipseAngle));
        }
        // Shading rings slide inward and back out (0 to 0.8 of a ring spacing, about every 7 s)
        // while their wobble drifts slowly round the circle
        const tSec = now * 0.001;
        gl.uniform1f(this._uBandPhase, 0.4 - 0.4 * Math.cos(tSec * BAND_SPEED));
        gl.uniform2f(this._uWobble, (tSec * 0.23) % TWO_PI, (tSec * 0.17) % TWO_PI);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
    }

    this._rafId = requestAnimationFrame(t => this._tick(t));
  }

  getCardSize() {
    return 8;
  }

  getGridOptions() {
    return {
      columns: 12,
      rows: 8,
      min_columns: 6,
      min_rows: 5
    };
  }
}

if (!customElements.get('lovelace-rehoboam')) {
  customElements.define('lovelace-rehoboam', RehoboamCard);
}

window.customCards = window.customCards || [];
if (!window.customCards.some(c => c.type === 'lovelace-rehoboam')) {
  window.customCards.push({
    type: 'lovelace-rehoboam',
    name: 'Rehoboam Divergence Card',
    description: 'Westworld Rehoboam predictive divergence visualization',
    preview: true,
    documentationURL: 'https://github.com/FHeilmann/lovelace-rehoboam'
  });
}
