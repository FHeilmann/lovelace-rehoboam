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

// Each spike is a stack of 7 lumpy masses, after the show's skyline look: a summit (layer 0) on an
// upper hill (layer 1) on a broad mass with outward-curving sides (layer 2), with smaller lumps on
// its flanks (layers 3-6). Heights step down gradually, so the peak is part of the mass.
// Envelope: cusp (1 - x)^pow, or with flat: true, 1 - x^pow (flat top, steep sides); x = d / cutoff.
// lobe/lobeFreq give the masses rounded bumps along their tops; jag/jagFreq add small notches.
// lean stretches one flank and shortens the other (cutoff * (1 +/- lean)).
// sway (bins) moves each layer of a spike sideways and breathe (fraction of its height) pulls it in
// and out over time. Callouts stay at the full, unmoved summit.
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
// [-left[k], right[k]]. massWidth scales the width, offset and bump spacing of the lower masses (layers 2-6),
// summitWidth those of the main lump (layers 0-1). summitSharpness (0-1) blends the main lump from
// its flat-topped dome toward a pointed cusp, and summitHeight scales how far it stands out.
const FIRST_MASS_LAYER = 2;
const SUMMIT_CUSP_POW = 2.4;
function buildLayerEnvelopes(massWidth, summitWidth, summitSharpness, summitHeight) {
  const env = { base: [], mod: [], left: [], right: [], offset: [], freqScale: [] };
  for (let k = 0; k < LAYER_CONFIG.length; k++) {
    const cfg = LAYER_CONFIG[k];
    const isSummit = k < FIRST_MASS_LAYER;
    const widthScale = isSummit ? summitWidth : massWidth;
    const height = cfg.height * (isSummit ? summitHeight : 1.0);
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
      if (isSummit && summitSharpness > 0.0) {
        e += (Math.pow(1.0 - x, SUMMIT_CUSP_POW) - e) * summitSharpness;
      }
      // The summit keeps its full height on average (it carries the callout) with lighter bumps;
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
    // circle show through the lumps' fill
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
const CARD_VERSION = '0.14.0';

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

// ============================================================================
// VISUAL LOVELACE CONFIG EDITOR (<lovelace-rehoboam-editor>)
// ============================================================================
class RehoboamCardEditor extends HTMLElement {
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
      theme_mode: 'dark',
      height: DEFAULT_HEIGHT,
      eclipse_intensity: 1.0,
      ray_intensity: 0.35,
      facet_shading: 0.6,
      ring_shading: true,
      amplitude_scale: 1.25,
      mass_width: 1.0,
      ambient_count: 3,
      ambient_size: 0.3,
      ambient_width: 1.0,
      ambient_lifetime: 25,
      summit_width: 1.0,
      summit_sharpness: 0,
      summit_height: 1.0,
      baseline_height: 1.0,
      transition_tau: 2.2,
      ring_scale: 0.42,
      resolution_scale: 0.65,
      fps_idle: 24,
      fps_active: 45,
      divergence_threshold: 0.15,
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
        category: 'SYSTEM ANOMALY',
        baseline: 0,
        critical: 100,
        always_visible: false
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

  // ha-selector with { ui_action: {} } is Home Assistant's own action picker
  _actionField(label, scope, key, idx = '') {
    if (!customElements.get('ha-selector')) {
      return `<div class="field" style="grid-column: span 2;"><label>${label}</label>
        <div class="hint">Set <code>${key}</code> in the YAML editor.</div></div>`;
    }
    return `<div class="field" style="grid-column: span 2;">
      <ha-selector class="act-sel" data-scope="${scope}" data-key="${key}" data-idx="${idx}" data-label="${esc(label)}"></ha-selector>
    </div>`;
  }

  _render() {
    if (!this._config) return;
    const c = this._config;
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
        input, select {
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
      </style>

      <div class="section">
        <div class="section-title">Appearance &amp; Eclipse Bloom</div>
        <div class="grid">
          <div class="field">
            <label>Theme Mode</label>
            <select id="f-theme_mode">
              <option value="dark" ${c.theme_mode === 'dark' ? 'selected' : ''}>Dark Mode (Night Eclipse)</option>
              <option value="light" ${c.theme_mode === 'light' ? 'selected' : ''}>Light Mode (Day Eclipse)</option>
              <option value="auto" ${c.theme_mode === 'auto' ? 'selected' : ''}>Auto (follow Home Assistant)</option>
            </select>
          </div>
          <div class="field">
            <label>Label Font (CSS font-family)</label>
            <input id="f-font_family" type="text" value="${esc(c.font_family)}" placeholder="Barlow Condensed (default)" />
          </div>
          <div class="field">
            <label>Label Font Size (px, 8–32)</label>
            <input id="f-font_size" type="number" min="8" max="32" step="0.5" value="${esc(c.font_size)}" placeholder="13" />
          </div>
          <div class="field">
            <label>Card Height (CSS)</label>
            <input id="f-height" type="text" value="${esc(c.height || DEFAULT_HEIGHT)}" placeholder="500px, 60vh, ..." />
          </div>
          <div class="field">
            <label>Eclipse Angle (0–360°, empty = follow divergence)</label>
            <input id="f-eclipse_angle" type="number" min="0" max="360" step="1" value="${esc(c.eclipse_angle)}" placeholder="Auto" />
          </div>
          <div class="field">
            <label>Eclipse Intensity (0.0–2.0)</label>
            <input id="f-eclipse_intensity" type="number" min="0" max="2" step="0.05" value="${esc(c.eclipse_intensity)}" />
          </div>
          <div class="field">
            <label>Corona Rays / Beams (0.0–1.0)</label>
            <input id="f-ray_intensity" type="number" min="0" max="1" step="0.05" value="${esc(c.ray_intensity)}" />
          </div>
          <div class="field">
            <label>Spike 3D Shading (0.0–1.0)</label>
            <input id="f-facet_shading" type="number" min="0" max="1" step="0.05" value="${esc(c.facet_shading)}" />
          </div>
          <div class="checkbox-row">
            <input id="f-ring_shading" type="checkbox" ${c.ring_shading !== false ? 'checked' : ''} />
            <label for="f-ring_shading">Wobbling Ring Shading</label>
          </div>
          <div class="field">
            <label>Wave Amplitude Scale (0.4–2.0)</label>
            <input id="f-amplitude_scale" type="number" min="0.4" max="2.0" step="0.05" value="${esc(c.amplitude_scale)}" />
          </div>
          <div class="field">
            <label>Main Lump Width (0.4–3)</label>
            <input id="f-summit_width" type="number" min="0.4" max="3" step="0.05" value="${esc(c.summit_width)}" />
          </div>
          <div class="field">
            <label>Main Lump Spikiness (0 = dome, 1 = point)</label>
            <input id="f-summit_sharpness" type="number" min="0" max="1" step="0.05" value="${esc(c.summit_sharpness)}" />
          </div>
          <div class="field">
            <label>Main Lump Prominence (0.3–1.43)</label>
            <input id="f-summit_height" type="number" min="0.3" max="1.43" step="0.05" value="${esc(c.summit_height)}" />
          </div>
          <div class="field">
            <label>Lump Mass Width (0.3–2.5)</label>
            <input id="f-mass_width" type="number" min="0.3" max="2.5" step="0.05" value="${esc(c.mass_width)}" />
          </div>
          <div class="field">
            <label>Baseline Wave Height (0 = flat ring, 0–5)</label>
            <input id="f-baseline_height" type="number" min="0" max="5" step="0.1" value="${esc(c.baseline_height)}" />
          </div>
          <div class="field">
            <label>Ambient Masses (count, 0–12)</label>
            <input id="f-ambient_count" type="number" min="0" max="12" step="1" value="${esc(c.ambient_count)}" />
          </div>
          <div class="field">
            <label>Ambient Mass Size (0–1)</label>
            <input id="f-ambient_size" type="number" min="0" max="1" step="0.05" value="${esc(c.ambient_size)}" />
          </div>
          <div class="field">
            <label>Ambient Mass Width (0.3–2.5)</label>
            <input id="f-ambient_width" type="number" min="0.3" max="2.5" step="0.05" value="${esc(c.ambient_width)}" />
          </div>
          <div class="field">
            <label>Ambient Mass Lifetime (s, 4–300)</label>
            <input id="f-ambient_lifetime" type="number" min="4" max="300" step="1" value="${esc(c.ambient_lifetime)}" />
          </div>
          <div class="field">
            <label>Transition Smoothing Tau (s)</label>
            <input id="f-transition_tau" type="number" min="0.2" max="15" step="0.1" value="${esc(c.transition_tau)}" />
          </div>
          <div class="field">
            <label>Global Monitoring Threshold (0–1 of baseline→critical)</label>
            <input id="f-monitoring_threshold" type="number" min="0" max="1" step="0.05" value="${esc(c.monitoring_threshold)}" placeholder="Same as divergence" />
          </div>
          <div class="field">
            <label>Global Divergence Threshold (0–1 of baseline→critical)</label>
            <input id="f-divergence_threshold" type="number" min="0" max="1" step="0.05" value="${esc(c.divergence_threshold)}" />
          </div>
          <div class="field">
            <label>Test Divergence Override (optional)</label>
            <input id="f-test_divergence" type="number" min="0" max="1" step="0.05" value="${esc(c.test_divergence)}" placeholder="Leave empty for live" />
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">Performance &amp; Tablet Scaling</div>
        <div class="grid">
          <div class="field">
            <label>Ring Scale (0.25–0.65)</label>
            <input id="f-ring_scale" type="number" min="0.25" max="0.65" step="0.01" value="${esc(c.ring_scale)}" />
          </div>
          <div class="field">
            <label>Resolution Scale (0.35–1.0)</label>
            <input id="f-resolution_scale" type="number" min="0.35" max="1.0" step="0.05" value="${esc(c.resolution_scale)}" />
          </div>
          <div class="field">
            <label>Idle FPS (10–60)</label>
            <input id="f-fps_idle" type="number" min="10" max="60" step="1" value="${esc(c.fps_idle)}" />
          </div>
          <div class="field">
            <label>Active FPS (15–60)</label>
            <input id="f-fps_active" type="number" min="15" max="60" step="1" value="${esc(c.fps_active)}" />
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">Circle Centre Actions</div>
        <div class="hint">
          Tap or hold the centre of the ring. For a browser_mod popup use the action
          "fire-dom-event" with a <code>browser_mod</code> block in YAML.
        </div>
        <div class="grid">
          <div class="field" style="grid-column: span 2;">
            <label>Centre Entity (optional, for more-info / toggle)</label>
            ${
              hasEntityPicker
                ? `<ha-entity-picker id="f-center_entity" value="${esc(c.center_entity)}" allow-custom-entity></ha-entity-picker>`
                : `<input id="f-center_entity" type="text" value="${esc(c.center_entity)}" placeholder="sensor.anything" />`
            }
          </div>
          <div class="field">
            <label>Hold Duration (ms, centre and callouts)</label>
            <input id="f-hold_time" type="number" min="150" max="5000" step="50" value="${esc(c.hold_time ?? DEFAULT_HOLD_MS)}" />
          </div>
          ${this._actionField('Centre Tap Action', 'global', 'center_tap_action')}
          ${this._actionField('Centre Hold Action', 'global', 'center_hold_action')}
        </div>
      </div>

      <div class="section">
        <div class="section-title">
          <span>Monitored Entities (${c.entities.length})</span>
          <span>
            <button class="btn" id="btn-toggle-entities">${this._openEntities.size ? 'Collapse all' : 'Expand all'}</button>
            <button class="btn" id="btn-add-entity">+ Add Entity</button>
          </span>
        </div>
        <div class="hint">
          Tip: If Critical &gt; Baseline, low values are normal and high values diverge. If Critical &lt; Baseline (e.g. Battery: Baseline 100, Critical 20), high values are normal and low values diverge.
          Callouts: below the monitoring threshold hidden (or "MONITORING" if always visible), from the monitoring threshold "MONITORING", from the divergence threshold "DIVERGENCE". Thresholds count in the same direction as baseline → critical.
        </div>
        <div id="entities-container">
          ${c.entities
            .map(
              (ent, idx) => `
            <details class="entity-card" data-idx="${idx}" ${this._openEntities.has(idx) ? 'open' : ''}>
              <summary class="entity-head">
                <span class="entity-title">#${idx + 1} ${esc(ent.category || 'SYSTEM ANOMALY')}
                  <span class="entity-sub">· ${esc(ent.name || ent.entity || 'Unconfigured')}</span></span>
                <button class="btn btn-danger btn-remove" data-idx="${idx}">Remove</button>
              </summary>
              <div class="grid">
                <div class="field" style="grid-column: span 2;">
                  <label>Entity ID</label>
                  ${
                    hasEntityPicker
                      ? `<ha-entity-picker class="ent-picker" data-idx="${idx}" value="${esc(ent.entity)}" allow-custom-entity></ha-entity-picker>`
                      : `<input class="ent-input" data-idx="${idx}" data-key="entity" data-type="string" type="text" value="${esc(ent.entity)}" placeholder="sensor.living_room_pm25" />`
                  }
                </div>
                <div class="field">
                  <label>Display Name (optional)</label>
                  <input class="ent-input" data-idx="${idx}" data-key="name" data-type="string" type="text" value="${esc(ent.name)}" placeholder="Auto from entity" />
                </div>
                <div class="field">
                  <label>Divergence Category</label>
                  <input class="ent-input" data-idx="${idx}" data-key="category" data-type="string" type="text" value="${esc(ent.category)}" placeholder="SYSTEM ANOMALY" />
                </div>
                <div class="field">
                  <label>Baseline (0% Normal Value)</label>
                  <input class="ent-input" data-idx="${idx}" data-key="baseline" data-type="number" type="number" step="any" value="${esc(ent.baseline ?? 0)}" />
                </div>
                <div class="field">
                  <label>Critical (100% Divergence Value)</label>
                  <input class="ent-input" data-idx="${idx}" data-key="critical" data-type="number" type="number" step="any" value="${esc(ent.critical ?? 100)}" />
                </div>
                <div class="field">
                  <label>Angle Override (0–360°, optional)</label>
                  <input class="ent-input" data-idx="${idx}" data-key="angle" data-type="number" type="number" min="0" max="360" step="1" value="${esc(ent.angle)}" placeholder="Auto-distributed" />
                </div>
                <div class="field">
                  <label>Monitoring Threshold (sensor value)</label>
                  <input class="ent-input" data-idx="${idx}" data-key="monitoring_threshold" data-type="number" type="number" step="any" value="${esc(ent.monitoring_threshold)}" placeholder="Use global" />
                </div>
                <div class="field">
                  <label>Divergence Threshold (sensor value)</label>
                  <input class="ent-input" data-idx="${idx}" data-key="divergence_threshold" data-type="number" type="number" step="any" value="${esc(ent.divergence_threshold)}" placeholder="Use global" />
                </div>
                <div class="field">
                  <label>Unit Override (optional)</label>
                  <input class="ent-input" data-idx="${idx}" data-key="unit" data-type="string" type="text" value="${esc(ent.unit)}" placeholder="Auto" />
                </div>
                <div class="checkbox-row">
                  <input class="ent-check" id="chk-${idx}" data-idx="${idx}" data-key="always_visible" type="checkbox" ${ent.always_visible ? 'checked' : ''} />
                  <label for="chk-${idx}">Always Visible Callout</label>
                </div>
                ${this._actionField('Callout Tap Action (default: more-info)', 'entity', 'tap_action', idx)}
                ${this._actionField('Callout Hold Action', 'entity', 'hold_action', idx)}
              </div>
            </details>
          `
            )
            .join('')}
        </div>
      </div>
    `;

    const root = this.shadowRoot;

    // Bind global fields
    root.getElementById('f-theme_mode').addEventListener('change', e => this._onGlobalChange('theme_mode', e.target.value));
    root.getElementById('f-ring_shading').addEventListener('change', e => this._onGlobalChange('ring_shading', e.target.checked));
    root.getElementById('f-font_size').addEventListener('change', e => this._onGlobalChange('font_size', e.target.value, true));
    root.getElementById('f-font_family').addEventListener('change', e => this._onGlobalChange('font_family', e.target.value));
    root.getElementById('f-height').addEventListener('change', e => this._onGlobalChange('height', e.target.value));
    root.getElementById('f-eclipse_angle').addEventListener('change', e => this._onGlobalChange('eclipse_angle', e.target.value, true));
    root.getElementById('f-eclipse_intensity').addEventListener('change', e => this._onGlobalChange('eclipse_intensity', e.target.value, true));
    root.getElementById('f-ray_intensity').addEventListener('change', e => this._onGlobalChange('ray_intensity', e.target.value, true));
    root.getElementById('f-facet_shading').addEventListener('change', e => this._onGlobalChange('facet_shading', e.target.value, true));
    root.getElementById('f-amplitude_scale').addEventListener('change', e => this._onGlobalChange('amplitude_scale', e.target.value, true));
    root.getElementById('f-summit_width').addEventListener('change', e => this._onGlobalChange('summit_width', e.target.value, true));
    root.getElementById('f-summit_height').addEventListener('change', e => this._onGlobalChange('summit_height', e.target.value, true));
    root.getElementById('f-summit_sharpness').addEventListener('change', e => this._onGlobalChange('summit_sharpness', e.target.value, true));
    ['ambient_count', 'ambient_size', 'ambient_width', 'ambient_lifetime'].forEach(key => {
      root.getElementById(`f-${key}`).addEventListener('change', e => this._onGlobalChange(key, e.target.value, true));
    });
    root.getElementById('f-mass_width').addEventListener('change', e => this._onGlobalChange('mass_width', e.target.value, true));
    root.getElementById('f-baseline_height').addEventListener('change', e => this._onGlobalChange('baseline_height', e.target.value, true));
    root.getElementById('f-transition_tau').addEventListener('change', e => this._onGlobalChange('transition_tau', e.target.value, true));
    root.getElementById('f-ring_scale').addEventListener('change', e => this._onGlobalChange('ring_scale', e.target.value, true));
    root.getElementById('f-resolution_scale').addEventListener('change', e => this._onGlobalChange('resolution_scale', e.target.value, true));
    root.getElementById('f-fps_idle').addEventListener('change', e => this._onGlobalChange('fps_idle', e.target.value, true));
    root.getElementById('f-fps_active').addEventListener('change', e => this._onGlobalChange('fps_active', e.target.value, true));
    root.getElementById('f-divergence_threshold').addEventListener('change', e => this._onGlobalChange('divergence_threshold', e.target.value, true));
    root.getElementById('f-monitoring_threshold').addEventListener('change', e => this._onGlobalChange('monitoring_threshold', e.target.value, true));
    root.getElementById('f-test_divergence').addEventListener('change', e => this._onGlobalChange('test_divergence', e.target.value, true));

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
        if (toggleAll) toggleAll.textContent = this._openEntities.size ? 'Collapse all' : 'Expand all';
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
      });
    });

    root.querySelectorAll('.ent-check').forEach(chk => {
      chk.addEventListener('change', e => {
        const el = e.currentTarget;
        this._onEntityChange(Number(el.dataset.idx), el.dataset.key, el.checked, 'boolean');
      });
    });

    root.getElementById('f-hold_time').addEventListener('change', e => this._onGlobalChange('hold_time', e.target.value, true));

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
      const { scope, key, idx, label } = sel.dataset;
      sel.selector = { ui_action: {} };
      sel.label = label;
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

    const themeMode = String(config.theme_mode || 'dark').toLowerCase();
    // Empty or 'auto': the eclipse turns toward the most diverged entity. A number fixes it.
    const eclipseRaw = config.eclipse_angle;
    const eclipseFollow = eclipseRaw === undefined || eclipseRaw === null || eclipseRaw === '' ||
      String(eclipseRaw).toLowerCase() === 'auto' || !Number.isFinite(Number(eclipseRaw));
    const eclipseAngleDeg = eclipseFollow ? null : Number(eclipseRaw);
    const testDiv = num(config.test_divergence, null, 0, 1);

    this._config = {
      theme_mode: ['light', 'auto'].includes(themeMode) ? themeMode : 'dark',
      font_family: config.font_family ? String(config.font_family) : DEFAULT_FONT,
      font_size: num(config.font_size, DEFAULT_FONT_SIZE, 8, 32),
      height: config.height ? String(config.height) : DEFAULT_HEIGHT,
      eclipse_angle: eclipseAngleDeg,
      eclipse_follow: eclipseFollow,
      eclipse_intensity: num(config.eclipse_intensity, 1.0, 0, 2),
      ray_intensity: num(config.ray_intensity, 0.35, 0, 1),
      facet_shading: num(config.facet_shading, 0.6, 0, 1),
      ring_shading: config.ring_shading !== false,
      amplitude_scale: num(config.amplitude_scale, 1.25, 0.1, 3),
      mass_width: num(config.mass_width, 1.0, 0.3, 2.5),
      summit_width: num(config.summit_width, 1.0, 0.4, 3),
      summit_sharpness: num(config.summit_sharpness, 0, 0, 1),
      summit_height: num(config.summit_height, 1.0, 0.3, 1.43),
      baseline_height: num(config.baseline_height, 1.0, 0, 5),
      ambient_count: Math.round(num(config.ambient_count, 3, 0, 12)),
      ambient_size: num(config.ambient_size, 0.3, 0, 1),
      ambient_width: num(config.ambient_width, 1.0, 0.3, 2.5),
      ambient_lifetime: num(config.ambient_lifetime, 25, 4, 300),
      transition_tau: num(config.transition_tau, 2.2, 0.2, 60),
      ring_scale: num(config.ring_scale, 0.42, 0.1, 1),
      resolution_scale: num(config.resolution_scale, 0.65, 0.1, 2),
      fps_idle: num(config.fps_idle, 24, 1, 120),
      fps_active: num(config.fps_active, 45, 1, 120),
      divergence_threshold: num(config.divergence_threshold, 0.15, 0, 1),
      monitoring_threshold: num(config.monitoring_threshold, null, 0, 1),
      test_divergence: testDiv,
      center_entity: config.center_entity || null,
      hold_time: num(config.hold_time, DEFAULT_HOLD_MS, 150, 5000),
      center_tap_action: config.center_tap_action || null,
      center_hold_action: config.center_hold_action || null,
      entities: Array.isArray(config.entities) ? config.entities : []
    };

    if (!eclipseFollow) this._eclipseAngle = eclipseAngleDeg * DEG_TO_RAD;
    ensureLabelFont(this._config.font_family);
    this._initEntities();
    this._ensureDOM();
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
      // in the sensor's own units (direction-aware); the global values (0-1) are the fallbacks.
      // Without a monitoring threshold there is no monitoring band: below the divergence
      // threshold the callout is hidden.
      const divValue = toNum(conf.divergence_threshold);
      const monValue = toNum(conf.monitoring_threshold);
      const divergeAt = Number.isFinite(divValue)
        ? computeDirectionalDivergence(divValue, base, crit)
        : this._config.divergence_threshold;
      const monitorAt = Math.min(divergeAt, Number.isFinite(monValue)
        ? computeDirectionalDivergence(monValue, base, crit)
        : (this._config.monitoring_threshold ?? divergeAt));
      // Stable per-entity sweep direction for the spike's longer flank
      let hash = 0;
      for (let c = 0; c < id.length; c++) hash = (hash * 31 + id.charCodeAt(c)) | 0;

      return {
        id,
        name: conf.name || null,
        category: String(conf.category || 'SYSTEM ANOMALY').toUpperCase(),
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
      const unit = isUnavailable ? '' : (ent.unit !== null ? ent.unit : (attrs.unit_of_measurement || ''));

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

      const nextFormatted = `${rawState}${unit ? ' ' + unit : ''}`;
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

        const headerText = isDiverging ? `DIVERGENCE: ${ent.category}` : `MONITORING: ${ent.category}`;
        if (ent.lastHeader !== headerText && ent.domHeader) {
          ent.lastHeader = headerText;
          ent.domHeader.textContent = headerText;
          ent.textDirty = true;
          this._labelsDirty = true;
        }

        const subText = `${friendly.toUpperCase()} : ${nextFormatted.toUpperCase()}`;
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

  _ensureDOM() {
    if (this._domBuilt) return;
    this._domBuilt = true;

    this.shadowRoot.innerHTML = `
      <style id="theme-style"></style>
      <ha-card id="card">
        <div class="viewport" id="vp">
          <canvas id="gl-canvas"></canvas>
          <svg class="hud" id="hud-svg" preserveAspectRatio="xMidYMid meet"></svg>
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
  }

  disconnectedCallback() {
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
      tHeader.textContent = `MONITORING: ${ent.category}`;

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
    const summitTop = Math.min(1.0, LAYER_CONFIG[0].height * this._config.summit_height);
    let moved = false;

    for (let i = 0; i < this._entities.length; i++) {
      const ent = this._entities[i];
      if (!ent.domGroup) continue;
      // Anchored at the summit's full height; breathing only pulls the summit in below it
      const severityRadius = 0.992 + ent.currentDivergence * 0.58 * ampScale * summitTop;
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

  // Picks a random bin in a calm part of the ring: clear of every diverging entity's masses and of
  // the other ambient masses. The first random candidate that is clear wins, so positions stay
  // random; only on a crowded ring, where no candidate is clear, the most open one is taken.
  _pickCalmBin(self) {
    const c = this._config;
    // Measured on the broad base mass (layer 2); the outer layers are too low to count
    const hill = LAYER_CONFIG[FIRST_MASS_LAYER];
    const reach = hill.cutoff * (1.0 + hill.lean);
    const entReach = reach * c.mass_width;
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

  // Ambient masses: low lumps in calm parts of the ring, with no entity or callout behind them.
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
    const envKey = `${c.mass_width}|${c.summit_width}|${c.summit_sharpness}|${c.summit_height}`;
    if (this._envKey !== envKey) {
      this._env = buildLayerEnvelopes(c.mass_width, c.summit_width, c.summit_sharpness, c.summit_height);
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
      // Ambient masses use only the lower mass layers, with their own width
      if (ambientCount > 0 && k >= FIRST_MASS_LAYER) {
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
