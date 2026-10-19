/**
 * Rehoboam Custom Lovelace Card v9 (Home Assistant Production Build)
 * 1. Directional baseline-to-critical clamping: (val - baseline) / (critical - baseline) clamped to [0, 1]
 *    Automatically detects low=good/high=bad (critical > baseline) vs high=good/low=bad (critical < baseline).
 * 2. Smooth Raised-Cosine (Hann) sine-wave amplitude peaks (zero derivative at apex, no solid sharp needle spike).
 * 3. Full Lovelace Visual Configuration Editor (`lovelace-rehoboam-editor` via `getConfigElement()`).
 */

const LUT_SIZE = 1024;
const LUT_MASK = LUT_SIZE - 1;
const TWO_PI = Math.PI * 2;
const DEG_TO_RAD = Math.PI / 180;

// Smooth raised-cosine (Hann) wave parameters — zero derivative at dBin=0 produces a rounded sine wave crest
const LAYER_CONFIG = [
  { cutoff: 20.0, pow: 1.35, lobeFreq: 0.17, height: 1.00, baseAmp: 0.012, freq1: 19, freq2: 43, speed: 0.95, phase: 0.0, offsetBins: 0   },
  { cutoff: 28.0, pow: 1.30, lobeFreq: 0.14, height: 0.86, baseAmp: 0.022, freq1: 14, freq2: 31, speed: 0.80, phase: 0.9, offsetBins: 3   },
  { cutoff: 38.0, pow: 1.25, lobeFreq: 0.12, height: 0.72, baseAmp: 0.032, freq1: 11, freq2: 27, speed: 0.68, phase: 2.1, offsetBins: -5  },
  { cutoff: 50.0, pow: 1.20, lobeFreq: 0.10, height: 0.58, baseAmp: 0.042, freq1: 9,  freq2: 23, speed: 0.58, phase: 3.4, offsetBins: 6   },
  { cutoff: 64.0, pow: 1.15, lobeFreq: 0.08, height: 0.46, baseAmp: 0.052, freq1: 7,  freq2: 19, speed: 0.48, phase: 4.2, offsetBins: -8  },
  { cutoff: 82.0, pow: 1.10, lobeFreq: 0.07, height: 0.35, baseAmp: 0.064, freq1: 5,  freq2: 15, speed: 0.40, phase: 1.5, offsetBins: 10  },
  { cutoff: 105.0,pow: 1.05, lobeFreq: 0.06, height: 0.24, baseAmp: 0.068, freq1: 4,  freq2: 11, speed: 0.30, phase: 2.8, offsetBins: -10 }
];

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

  float evalRibbon(float r, float rBase, float disp, float fillAlpha, float edgeAlpha, float edgeSharpness) {
    float rTop = rBase + disp;
    float vis = step(0.0012, disp);
    float body = smoothstep(rBase - 0.004, rBase + 0.003, r) *
                 (1.0 - smoothstep(rTop - 0.005, rTop + 0.0035, r));
    float grad = 0.58 + 0.42 * clamp((r - rBase) / (disp + 0.0001), 0.0, 1.0);
    float dEdge = (r - rTop) * edgeSharpness;
    float rim = (1.0 / (1.0 + dEdge * dEdge)) *
                smoothstep(rBase - 0.002, rBase + 0.003, r) *
                (1.0 - smoothstep(rTop + 0.003, rTop + 0.012, r));
    return (body * fillAlpha * grad + rim * edgeAlpha) * vis;
  }

  void main() {
    float r = length(v_uv);
    float angle01 = fastAtan01(v_uv);

    vec4 L0_3 = texture2D(u_lut, vec2(angle01, 0.25));
    vec4 L4_7 = texture2D(u_lut, vec2(angle01, 0.75));

    float maxRange = 0.58 * u_amp_scale;
    float d0 = L0_3.r * maxRange;
    float d1 = L0_3.g * maxRange;
    float d2 = L0_3.b * maxRange;
    float d3 = L0_3.a * maxRange;
    float d4 = L4_7.r * maxRange;
    float d5 = L4_7.g * maxRange;
    float d6 = L4_7.b * maxRange;
    float rayStriation = L4_7.a;

    vec2 dir = v_uv / (r + 1e-5);
    float align01 = clamp(dot(dir, u_eclipse_dir) * 0.5 + 0.5, 0.0, 1.0);
    float align2 = align01 * align01;
    float align4 = align2 * align2;
    float align6 = align4 * align2;

    vec2 innerCenter = -u_eclipse_dir * (0.032 * u_eclipse);
    float rInner = length(v_uv - innerCenter);

    float innerErode = (L4_7.g + L4_7.b) * 0.010;
    float innerRadius = 0.992 - 0.014 * u_eclipse - innerErode;
    float dInner = rInner - innerRadius;

    // Consistent semi-transparent opacities across all 7 wave strata
    float trans = 1.0;
    trans *= (1.0 - evalRibbon(r, innerRadius, d0, 0.19, 0.35, 200.0));
    trans *= (1.0 - evalRibbon(r, innerRadius, d1, 0.17, 0.32, 195.0));
    trans *= (1.0 - evalRibbon(r, innerRadius, d2, 0.16, 0.29, 185.0));
    trans *= (1.0 - evalRibbon(r, innerRadius, d3, 0.15, 0.27, 175.0));
    trans *= (1.0 - evalRibbon(r, innerRadius, d4, 0.14, 0.25, 168.0));
    trans *= (1.0 - evalRibbon(r, innerRadius, d5, 0.13, 0.23, 160.0));
    trans *= (1.0 - evalRibbon(r, innerRadius, d6, 0.12, 0.21, 152.0));

    float dRim = (r - innerRadius) * 180.0;
    float baseRim = (1.0 / (1.0 + dRim * dRim)) * 0.72;
    trans *= (1.0 - baseRim);

    float strataDensity = 1.0 - trans;

    float dLimb = max(0.0, dInner);

    float coreWidth = 0.005 + u_eclipse * (0.012 + 0.092 * align6);
    float cCore = dLimb / coreWidth;
    float coreCrescent = (1.0 / (1.0 + cCore * cCore * 1.15 + cCore * cCore * cCore * cCore * 0.42))
                       * u_eclipse * (0.38 + 1.90 * align4);

    float haloWidth = 0.022 + u_eclipse * (0.040 + 0.20 * align4);
    float cHalo = dLimb / haloWidth;
    float smoothHalo = (1.0 / (1.0 + cHalo * cHalo * 1.8 + cHalo * cHalo * cHalo * cHalo * 0.6))
                     * u_eclipse * (0.08 + 0.36 * align4);

    float rayStretch = 1.0 + (0.48 * rayStriation) * u_ray_intensity;
    float rayWidth = (0.016 + u_eclipse * (0.028 + 0.19 * align4)) * rayStretch;
    float cRay = dLimb / rayWidth;
    float cRay2 = cRay * cRay;
    float outerRays = (1.0 / (1.0 + cRay2 * 1.8 + cRay2 * cRay2 * 0.85))
                    * u_eclipse * (0.10 + 0.52 * align4) * rayStriation * u_ray_intensity;

    float eclipseBloom = (coreCrescent + smoothHalo + outerRays) * smoothstep(-0.015, 0.008, dInner);

    float diskMask = smoothstep(-0.0035, 0.0035, dInner);
    float wrapWidth = 0.006 + u_eclipse * (0.012 + 0.065 * align6);
    float dWrap = max(0.0, -dInner) / wrapWidth;
    float innerRadialFade = smoothstep(0.75, 0.98, rInner);
    float innerWrap = (1.0 / (1.0 + dWrap * dWrap * 2.2))
                    * (0.08 + u_eclipse * (0.45 + 1.15 * align6))
                    * innerRadialFade;

    if (u_light_mode < 0.5) {
      vec3 bgCol = vec3(0.024, 0.024, 0.030);
      vec3 diskCol = vec3(0.016, 0.016, 0.022);

      float energy = (strataDensity * 1.30 + eclipseBloom) * diskMask + innerWrap * (1.0 - diskMask);
      vec3 hdrCol = vec3(0.96, 0.98, 1.0) * energy;
      vec3 mapped = 1.0 - exp(-hdrCol * 1.35);
      vec3 finalDark = mix(diskCol, bgCol, diskMask) + mapped;
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
      vec3 shaded = mix(baseCanvas, inkColor, totalInk);

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
  }

  setConfig(config) {
    this._config = {
      theme_mode: 'dark',
      height: '100vh',
      eclipse_angle: 180,
      eclipse_intensity: 1.0,
      ray_intensity: 0.35,
      amplitude_scale: 1.25,
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

    if (!this._rendered) {
      this._render();
      this._rendered = true;
    } else {
      this._syncInputs();
    }
  }

  set hass(hass) {
    this._hass = hass;
    if (this.shadowRoot) {
      this.shadowRoot.querySelectorAll('ha-entity-picker').forEach(picker => {
        picker.hass = hass;
      });
    }
  }

  _emitConfig(newConfig) {
    this._config = newConfig;
    this.dispatchEvent(
      new CustomEvent('config-changed', {
        detail: { config: newConfig },
        bubbles: true,
        composed: true
      })
    );
  }

  _onGlobalChange(key, value, isNumber = false, allowNull = false) {
    const next = { ...this._config };
    if (allowNull && (value === '' || value === null || Number.isNaN(Number(value)))) {
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
    this._rendered = false;
    this._emitConfig({ ...this._config, entities });
    this._render();
    this._rendered = true;
  }

  _removeEntity(index) {
    const entities = this._config.entities.filter((_, i) => i !== index);
    this._rendered = false;
    this._emitConfig({ ...this._config, entities });
    this._render();
    this._rendered = true;
  }

  _syncInputs() {
    const root = this.shadowRoot;
    if (!root || !this._config) return;
    const setVal = (id, val) => {
      const el = root.getElementById(id);
      if (el && document.activeElement !== el) {
        el.value = val !== undefined && val !== null ? val : '';
      }
    };
    setVal('f-theme_mode', this._config.theme_mode);
    setVal('f-height', this._config.height);
    setVal('f-eclipse_angle', this._config.eclipse_angle);
    setVal('f-eclipse_intensity', this._config.eclipse_intensity);
    setVal('f-ray_intensity', this._config.ray_intensity);
    setVal('f-amplitude_scale', this._config.amplitude_scale);
    setVal('f-transition_tau', this._config.transition_tau);
    setVal('f-ring_scale', this._config.ring_scale);
    setVal('f-resolution_scale', this._config.resolution_scale);
    setVal('f-fps_idle', this._config.fps_idle);
    setVal('f-fps_active', this._config.fps_active);
    setVal('f-divergence_threshold', this._config.divergence_threshold);
    setVal('f-test_divergence', this._config.test_divergence);
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
          padding: 12px;
          border-radius: 6px;
          background: rgba(0, 0, 0, 0.15);
          border: 1px solid var(--divider-color, rgba(255,255,255,0.1));
        }
        .entity-head {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 10px;
          font-weight: 600;
          font-size: 13px;
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
            </select>
          </div>
          <div class="field">
            <label>Card Height (CSS)</label>
            <input id="f-height" type="text" value="${c.height || '100vh'}" placeholder="100vh or 600px" />
          </div>
          <div class="field">
            <label>Eclipse Angle (0–360°)</label>
            <input id="f-eclipse_angle" type="number" min="0" max="360" step="1" value="${c.eclipse_angle}" />
          </div>
          <div class="field">
            <label>Eclipse Intensity (0.0–2.0)</label>
            <input id="f-eclipse_intensity" type="number" min="0" max="2" step="0.05" value="${c.eclipse_intensity}" />
          </div>
          <div class="field">
            <label>Corona Rays / Beams (0.0–1.0)</label>
            <input id="f-ray_intensity" type="number" min="0" max="1" step="0.05" value="${c.ray_intensity}" />
          </div>
          <div class="field">
            <label>Wave Amplitude Scale (0.4–2.0)</label>
            <input id="f-amplitude_scale" type="number" min="0.4" max="2.0" step="0.05" value="${c.amplitude_scale}" />
          </div>
          <div class="field">
            <label>Transition Smoothing Tau (s)</label>
            <input id="f-transition_tau" type="number" min="0.2" max="15" step="0.1" value="${c.transition_tau}" />
          </div>
          <div class="field">
            <label>Global Threshold (0.0–1.0)</label>
            <input id="f-divergence_threshold" type="number" min="0" max="1" step="0.05" value="${c.divergence_threshold}" />
          </div>
          <div class="field">
            <label>Test Divergence Override (optional)</label>
            <input id="f-test_divergence" type="number" min="0" max="1" step="0.05" value="${c.test_divergence !== undefined && c.test_divergence !== null ? c.test_divergence : ''}" placeholder="Leave empty for live" />
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">Performance &amp; Tablet Scaling</div>
        <div class="grid">
          <div class="field">
            <label>Ring Scale (0.25–0.65)</label>
            <input id="f-ring_scale" type="number" min="0.25" max="0.65" step="0.01" value="${c.ring_scale}" />
          </div>
          <div class="field">
            <label>Resolution Scale (0.35–1.0)</label>
            <input id="f-resolution_scale" type="number" min="0.35" max="1.0" step="0.05" value="${c.resolution_scale}" />
          </div>
          <div class="field">
            <label>Idle FPS (10–60)</label>
            <input id="f-fps_idle" type="number" min="10" max="60" step="1" value="${c.fps_idle}" />
          </div>
          <div class="field">
            <label>Active FPS (15–60)</label>
            <input id="f-fps_active" type="number" min="15" max="60" step="1" value="${c.fps_active}" />
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">
          <span>Monitored Entities (${c.entities.length})</span>
          <button class="btn" id="btn-add-entity">+ Add Entity</button>
        </div>
        <div class="hint">
          Tip: If Critical &gt; Baseline, low values are normal and high values diverge. If Critical &lt; Baseline (e.g. Battery: Baseline 100, Critical 20), high values are normal and low values diverge.
        </div>
        <div id="entities-container">
          ${c.entities
            .map(
              (ent, idx) => `
            <div class="entity-card" data-idx="${idx}">
              <div class="entity-head">
                <span>Entity #${idx + 1}: ${ent.name || ent.entity || 'Unconfigured'}</span>
                <button class="btn btn-danger btn-remove" data-idx="${idx}">Remove</button>
              </div>
              <div class="grid">
                <div class="field" style="grid-column: span 2;">
                  <label>Entity ID</label>
                  ${
                    hasEntityPicker
                      ? `<ha-entity-picker class="ent-picker" data-idx="${idx}" value="${ent.entity || ''}" allow-custom-entity></ha-entity-picker>`
                      : `<input class="ent-input" data-idx="${idx}" data-key="entity" data-type="string" type="text" value="${ent.entity || ''}" placeholder="sensor.living_room_pm25" />`
                  }
                </div>
                <div class="field">
                  <label>Display Name (optional)</label>
                  <input class="ent-input" data-idx="${idx}" data-key="name" data-type="string" type="text" value="${ent.name || ''}" placeholder="Auto from entity" />
                </div>
                <div class="field">
                  <label>Divergence Category</label>
                  <input class="ent-input" data-idx="${idx}" data-key="category" data-type="string" type="text" value="${ent.category || ''}" placeholder="AIR QUALITY" />
                </div>
                <div class="field">
                  <label>Baseline (0% Normal Value)</label>
                  <input class="ent-input" data-idx="${idx}" data-key="baseline" data-type="number" type="number" step="any" value="${ent.baseline !== undefined ? ent.baseline : 0}" />
                </div>
                <div class="field">
                  <label>Critical (100% Divergence Value)</label>
                  <input class="ent-input" data-idx="${idx}" data-key="critical" data-type="number" type="number" step="any" value="${ent.critical !== undefined ? ent.critical : 100}" />
                </div>
                <div class="field">
                  <label>Angle Override (0–360°, optional)</label>
                  <input class="ent-input" data-idx="${idx}" data-key="angle" data-type="number" type="number" min="0" max="360" step="1" value="${ent.angle !== undefined ? ent.angle : ''}" placeholder="Auto-distributed" />
                </div>
                <div class="field">
                  <label>Threshold Override (0.0–1.0)</label>
                  <input class="ent-input" data-idx="${idx}" data-key="threshold" data-type="number" type="number" min="0" max="1" step="0.05" value="${ent.threshold !== undefined ? ent.threshold : ''}" placeholder="Use global" />
                </div>
                <div class="field">
                  <label>Unit Override (optional)</label>
                  <input class="ent-input" data-idx="${idx}" data-key="unit" data-type="string" type="text" value="${ent.unit !== undefined && ent.unit !== null ? ent.unit : ''}" placeholder="Auto" />
                </div>
                <div class="checkbox-row">
                  <input class="ent-check" id="chk-${idx}" data-idx="${idx}" data-key="always_visible" type="checkbox" ${ent.always_visible ? 'checked' : ''} />
                  <label for="chk-${idx}">Always Visible Callout</label>
                </div>
              </div>
            </div>
          `
            )
            .join('')}
        </div>
      </div>
    `;

    const root = this.shadowRoot;

    // Bind global fields
    root.getElementById('f-theme_mode').addEventListener('change', e => this._onGlobalChange('theme_mode', e.target.value));
    root.getElementById('f-height').addEventListener('change', e => this._onGlobalChange('height', e.target.value));
    root.getElementById('f-eclipse_angle').addEventListener('change', e => this._onGlobalChange('eclipse_angle', e.target.value, true));
    root.getElementById('f-eclipse_intensity').addEventListener('change', e => this._onGlobalChange('eclipse_intensity', e.target.value, true));
    root.getElementById('f-ray_intensity').addEventListener('change', e => this._onGlobalChange('ray_intensity', e.target.value, true));
    root.getElementById('f-amplitude_scale').addEventListener('change', e => this._onGlobalChange('amplitude_scale', e.target.value, true));
    root.getElementById('f-transition_tau').addEventListener('change', e => this._onGlobalChange('transition_tau', e.target.value, true));
    root.getElementById('f-ring_scale').addEventListener('change', e => this._onGlobalChange('ring_scale', e.target.value, true));
    root.getElementById('f-resolution_scale').addEventListener('change', e => this._onGlobalChange('resolution_scale', e.target.value, true));
    root.getElementById('f-fps_idle').addEventListener('change', e => this._onGlobalChange('fps_idle', e.target.value, true));
    root.getElementById('f-fps_active').addEventListener('change', e => this._onGlobalChange('fps_active', e.target.value, true));
    root.getElementById('f-divergence_threshold').addEventListener('change', e => this._onGlobalChange('divergence_threshold', e.target.value, true));
    root.getElementById('f-test_divergence').addEventListener('change', e => this._onGlobalChange('test_divergence', e.target.value, true, true));

    // Bind Add / Remove Entity buttons
    root.getElementById('btn-add-entity').addEventListener('click', () => this._addEntity());
    root.querySelectorAll('.btn-remove').forEach(btn => {
      btn.addEventListener('click', e => this._removeEntity(Number(e.currentTarget.dataset.idx)));
    });

    // Bind ha-entity-picker if available
    root.querySelectorAll('.ent-picker').forEach(picker => {
      if (this._hass) picker.hass = this._hass;
      picker.addEventListener('value-changed', e => {
        const idx = Number(e.currentTarget.dataset.idx);
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
      height: '100vh',
      eclipse_angle: 180,
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
    this._lutData = new Uint8Array(LUT_SIZE * 2 * 4);
    this._layerScratch = new Float32Array(7);
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
    this._vpWidth = 1280;
    this._vpHeight = 800;
    this._ringRadiusPx = 220;
  }

  setConfig(config) {
    if (!config) throw new Error('Invalid configuration');

    const themeMode = (config.theme_mode || 'dark').toLowerCase();
    const eclipseAngleDeg = config.eclipse_angle !== undefined ? Number(config.eclipse_angle) : 180;
    const eclipseRad = eclipseAngleDeg * DEG_TO_RAD;

    this._config = {
      theme_mode: themeMode === 'light' ? 'light' : 'dark',
      height: config.height || '100vh',
      eclipse_angle: eclipseAngleDeg,
      eclipse_dir: [Math.cos(eclipseRad), Math.sin(eclipseRad)],
      eclipse_intensity: config.eclipse_intensity !== undefined ? Number(config.eclipse_intensity) : 1.0,
      ray_intensity: config.ray_intensity !== undefined ? Number(config.ray_intensity) : 0.35,
      amplitude_scale: config.amplitude_scale !== undefined ? Number(config.amplitude_scale) : 1.25,
      transition_tau: config.transition_tau !== undefined ? Number(config.transition_tau) : 2.2,
      ring_scale: config.ring_scale !== undefined ? Number(config.ring_scale) : 0.42,
      resolution_scale: config.resolution_scale !== undefined ? Number(config.resolution_scale) : 0.65,
      fps_idle: config.fps_idle !== undefined ? Number(config.fps_idle) : 24,
      fps_active: config.fps_active !== undefined ? Number(config.fps_active) : 45,
      divergence_threshold: config.divergence_threshold !== undefined ? Number(config.divergence_threshold) : 0.15,
      test_divergence:
        config.test_divergence !== undefined && config.test_divergence !== null && config.test_divergence !== ''
          ? Number(config.test_divergence)
          : null,
      entities: Array.isArray(config.entities) ? config.entities : []
    };

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
    const unangledCount = raw.filter(e => typeof e === 'string' || e.angle === undefined || e.angle === '').length;
    let autoIdx = 0;

    this._entities = raw.map(item => {
      const conf = typeof item === 'string' ? { entity: item } : (item || {});
      let angleDeg = conf.angle !== undefined && conf.angle !== '' ? Number(conf.angle) : null;
      if (angleDeg === null || Number.isNaN(angleDeg)) {
        angleDeg = (22.5 + (autoIdx * 360) / Math.max(1, unangledCount)) % 360;
        autoIdx++;
      }
      const angleRad = ((angleDeg % 360) + 360) % 360 * DEG_TO_RAD;
      const binCenter = Math.floor((angleRad / TWO_PI) * LUT_SIZE) & LUT_MASK;

      return {
        id: conf.entity || '',
        name: conf.name || null,
        category: (conf.category || 'SYSTEM ANOMALY').toUpperCase(),
        angleDeg,
        angleRad,
        binCenter,
        baseline: conf.baseline !== undefined ? Number(conf.baseline) : 0,
        critical: conf.critical !== undefined ? Number(conf.critical) : 100,
        threshold:
          conf.threshold !== undefined && conf.threshold !== ''
            ? Number(conf.threshold)
            : this._config.divergence_threshold,
        alwaysVisible: Boolean(conf.always_visible),
        stateMap: conf.state_map || null,
        unit: conf.unit !== undefined && conf.unit !== '' ? conf.unit : null,
        currentDivergence: 0,
        targetDivergence: 0,
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

    let maxDiv = 0;
    let sumDiv = 0;

    for (let i = 0; i < this._entities.length; i++) {
      const ent = this._entities[i];
      const stateObj = hass.states[ent.id];
      if (!stateObj) continue;

      const rawState = stateObj.state;
      const attrs = stateObj.attributes || {};
      const friendly = ent.name || attrs.friendly_name || ent.id;
      const unit = ent.unit !== null ? ent.unit : (attrs.unit_of_measurement || '');

      let div = 0;
      if (ent.stateMap && ent.stateMap[rawState] !== undefined) {
        div = Math.max(0.0, Math.min(1.0, Number(ent.stateMap[rawState])));
      } else {
        const num = parseFloat(rawState);
        if (!Number.isNaN(num)) {
          // Directional normalization & clamping between baseline and critical
          div = computeDirectionalDivergence(num, ent.baseline, ent.critical);
        } else {
          const activeStates = ['on', 'open', 'detected', 'problem', 'unsafe', 'triggered', 'home'];
          div = activeStates.includes(String(rawState).toLowerCase()) ? 1.0 : 0.0;
        }
      }

      ent.targetDivergence = div;
      if (div > maxDiv) maxDiv = div;
      sumDiv += div;

      const nextFormatted = `${rawState}${unit ? ' ' + unit : ''}`;
      const nextVisible = ent.alwaysVisible || div >= ent.threshold;
      const isDiverging = div >= ent.threshold;

      if (ent.domGroup) {
        if (ent.isVisible !== nextVisible || ent.wasDiverging !== isDiverging) {
          ent.isVisible = nextVisible;
          ent.wasDiverging = isDiverging;
          ent.domGroup.setAttribute('class', `callout ${nextVisible ? 'visible' : ''} ${isDiverging ? 'diverging' : ''}`);
        }

        const headerText = isDiverging ? `DIVERGENCE: ${ent.category}` : `MONITORING: ${ent.category}`;
        if (ent.lastHeader !== headerText && ent.domHeader) {
          ent.lastHeader = headerText;
          ent.domHeader.textContent = headerText;
        }

        const subText = `${friendly.toUpperCase()} : ${nextFormatted.toUpperCase()}`;
        if (ent.formattedValue !== subText && ent.domSub) {
          ent.formattedValue = subText;
          ent.domSub.textContent = subText;
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
        </div>
      </ha-card>
    `;

    this._styleEl = this.shadowRoot.getElementById('theme-style');
    this._canvas = this.shadowRoot.getElementById('gl-canvas');
    this._svg = this.shadowRoot.getElementById('hud-svg');
    this._vp = this.shadowRoot.getElementById('vp');

    this._canvas.addEventListener('webglcontextlost', e => {
      e.preventDefault();
      this._gl = null;
    });
    this._canvas.addEventListener('webglcontextrestored', () => {
      this._initWebGL();
      this._syncUniforms();
      this._onResize();
    });

    this._initWebGL();
  }

  _applyThemeStyles() {
    if (!this._styleEl || !this._config) return;
    const isLight = this._config.theme_mode === 'light';
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
        min-height: 480px;
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
        min-height: 480px;
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
      .callout {
        opacity: 0;
        transition: opacity 0.85s cubic-bezier(0.22, 1, 0.36, 1);
        will-change: transform, opacity;
      }
      .callout.visible {
        opacity: 1;
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
        font-family: 'Montserrat', 'Rajdhani', 'Inter', 'Roboto', sans-serif;
        font-size: 11.5px;
        font-weight: 700;
        letter-spacing: 2.2px;
      }
      .label-sub {
        fill: ${subCol};
        font-family: 'Montserrat', 'Rajdhani', 'Inter', 'Roboto', sans-serif;
        font-size: 10.5px;
        font-weight: 600;
        letter-spacing: 1.7px;
      }
    `;
  }

  connectedCallback() {
    this._ensureDOM();
    if (!this._resizeObserver && window.ResizeObserver) {
      this._resizeObserver = new ResizeObserver(() => this._onResize());
    }
    if (this._resizeObserver && this._vp) {
      this._resizeObserver.observe(this._vp);
    }

    this._visHandler = () => {
      this._isVisible = !document.hidden;
      if (this._isVisible && !this._rafId) {
        const now = performance.now();
        this._lastFrameTime = now;
        this._lastSimTimeSec = now * 0.001;
        this._rafId = requestAnimationFrame(t => this._tick(t));
      }
    };
    document.addEventListener('visibilitychange', this._visHandler);

    this._onResize();
    setTimeout(() => this._onResize(), 100);

    const now = performance.now();
    this._lastFrameTime = now;
    this._lastSimTimeSec = now * 0.001;
    if (!this._rafId) {
      this._rafId = requestAnimationFrame(t => this._tick(t));
    }
  }

  disconnectedCallback() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = null;
    if (this._resizeObserver) this._resizeObserver.disconnect();
    if (this._visHandler) document.removeEventListener('visibilitychange', this._visHandler);
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
    if (!gl) return;
    this._gl = gl;

    const vs = this._compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = this._compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    if (!vs || !fs) return;

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
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
  }

  _syncUniforms() {
    if (!this._gl || !this._program || !this._config) return;
    const gl = this._gl;
    gl.useProgram(this._program);
    gl.uniform2fv(this._uEclipseDir, this._config.eclipse_dir);
    gl.uniform1f(this._uLightMode, this._config.theme_mode === 'light' ? 1.0 : 0.0);
    gl.uniform1f(this._uAmpScale, this._config.amplitude_scale);
    gl.uniform1f(this._uRayIntensity, this._config.ray_intensity);
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
    if (!this._vp || !this._gl || !this._config) return;
    const rect = this._vp.getBoundingClientRect();
    const w = Math.max(320, rect.width > 50 ? rect.width : window.innerWidth);
    const h = Math.max(320, rect.height > 50 ? rect.height : window.innerHeight);
    this._vpWidth = w;
    this._vpHeight = h;

    const scale = this._config.resolution_scale;
    const cw = Math.round(w * scale);
    const ch = Math.round(h * scale);

    if (this._canvas.width !== cw || this._canvas.height !== ch) {
      this._canvas.width = cw;
      this._canvas.height = ch;
      this._gl.viewport(0, 0, cw, ch);
    }

    const minDim = Math.min(w, h);
    this._ringRadiusPx = (minDim * 0.5) * this._config.ring_scale;

    const aspectX = (w * 0.5) / this._ringRadiusPx;
    const aspectY = (h * 0.5) / this._ringRadiusPx;
    this._gl.useProgram(this._program);
    this._gl.uniform2f(this._uAspect, aspectX, aspectY);

    this._layoutHUD(w, h, this._ringRadiusPx);
  }

  _buildHUD() {
    if (!this._svg) return;
    this._svg.innerHTML = '';

    const ns = 'http://www.w3.org/2000/svg';
    for (let i = 0; i < this._entities.length; i++) {
      const ent = this._entities[i];
      const g = document.createElementNS(ns, 'g');
      g.setAttribute('class', `callout ${ent.alwaysVisible ? 'visible' : ''}`);

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
      tHeader.textContent = `DIVERGENCE: ${ent.category}`;

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
      const shelfLen = Math.min(220, Math.max(140, w * 0.16));
      const x2 = diagX + dirX * shelfLen;
      const y2 = diagY;

      ent.domPoly.setAttribute(
        'points',
        `${sx.toFixed(1)},${sy.toFixed(1)} ${diagX.toFixed(1)},${diagY.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`
      );

      const textX = isRight ? diagX + 6 : diagX - 6;
      const anchor = isRight ? 'start' : 'end';

      ent.domHeader.setAttribute('x', textX.toFixed(1));
      ent.domHeader.setAttribute('y', (diagY - 18).toFixed(1));
      ent.domHeader.setAttribute('text-anchor', anchor);

      ent.domSub.setAttribute('x', textX.toFixed(1));
      ent.domSub.setAttribute('y', (diagY - 5).toFixed(1));
      ent.domSub.setAttribute('text-anchor', anchor);
    }

    this._updateCalloutTipPositions();
  }

  _updateCalloutTipPositions() {
    if (!this._config) return;
    const cx = this._vpWidth * 0.5;
    const cy = this._vpHeight * 0.5;
    const R = this._ringRadiusPx;
    const ampScale = this._config.amplitude_scale;

    for (let i = 0; i < this._entities.length; i++) {
      const ent = this._entities[i];
      if (!ent.domGroup) continue;
      const severityRadius = 0.992 + ent.currentDivergence * 0.58 * ampScale;
      const tipPx = R * severityRadius;
      const tx = cx + Math.cos(ent.angleRad) * tipPx;
      const ty = cy - Math.sin(ent.angleRad) * tipPx;
      ent.domGroup.setAttribute('transform', `translate(${tx.toFixed(1)}, ${ty.toFixed(1)})`);
    }
  }

  _updatePolarLUT(timeSec) {
    const dt = Math.min(0.1, Math.max(0.001, timeSec - this._lastSimTimeSec));
    this._lastSimTimeSec = timeSec;

    const tau = Math.max(0.2, this._config.transition_tau);
    const smoothFactor = 1.0 - Math.exp(-dt / tau);

    this._currentEclipse += (this._targetEclipse - this._currentEclipse) * smoothFactor;
    const ec = this._currentEclipse;

    for (let s = 0; s < this._entities.length; s++) {
      const ent = this._entities[s];
      ent.currentDivergence += (ent.targetDivergence - ent.currentDivergence) * smoothFactor;
    }

    const data = this._lutData;
    const row1Offset = LUT_SIZE * 4;
    const layerOut = this._layerScratch;

    for (let i = 0; i < LUT_SIZE; i++) {
      const a = (i / LUT_SIZE) * TWO_PI;

      for (let k = 0; k < 7; k++) {
        const cfg = LAYER_CONFIG[k];
        const tLayer = timeSec * cfg.speed + cfg.phase;

        const phaseWarp = 0.45 * Math.sin(a * 2.0 - tLayer * 0.45);
        const baseWave =
          0.50 +
          0.30 * Math.sin(a * cfg.freq1 + phaseWarp + tLayer) +
          0.20 * Math.cos(a * cfg.freq2 - tLayer * 1.15);
        let val = cfg.baseAmp * (1.0 + 0.65 * ec) * Math.max(0.0, baseWave);

        for (let s = 0; s < this._entities.length; s++) {
          const ent = this._entities[s];
          const dVal = ent.currentDivergence;
          if (dVal < 0.005) continue;

          const shiftedCenter = (ent.binCenter + cfg.offsetBins + LUT_SIZE) & LUT_MASK;
          let signedDiff = i - shiftedCenter;
          if (signedDiff > (LUT_SIZE >> 1)) signedDiff -= LUT_SIZE;
          if (signedDiff < -(LUT_SIZE >> 1)) signedDiff += LUT_SIZE;
          const dBin = Math.abs(signedDiff);

          if (dBin < cfg.cutoff) {
            // Smooth Raised-Cosine (Hann) Window: C1 continuous with zero derivative at apex (rounded sine wave peak)
            const hann = 0.5 * (1.0 + Math.cos(Math.PI * (dBin / cfg.cutoff)));
            const env = Math.pow(hann, cfg.pow);

            const flankWeight = k === 0 ? Math.min(1.0, (dBin / 7.5) ** 2) : 1.0;
            const subLobes =
              0.74 +
              0.16 * Math.cos(signedDiff * cfg.lobeFreq - tLayer * 1.4 + k * 0.9) +
              0.10 * Math.sin(signedDiff * (cfg.lobeFreq * 1.9) + tLayer * 1.1);
            const waveMod = (1.0 - flankWeight) + flankWeight * subLobes;

            const layerWavePeak = dVal * cfg.height * env * waveMod;
            if (layerWavePeak > val) val = layerWavePeak;
          }
        }

        layerOut[k] = Math.min(1.0, Math.max(0.0, val));
      }

      const rayShimmer =
        0.78 * this._rayBaseHash[i] +
        0.13 * Math.sin(a * 37.0 - timeSec * 0.35) +
        0.09 * Math.cos(a * 71.0 + timeSec * 0.25);

      const idx0 = i * 4;
      data[idx0]     = (layerOut[0] * 255) | 0;
      data[idx0 + 1] = (layerOut[1] * 255) | 0;
      data[idx0 + 2] = (layerOut[2] * 255) | 0;
      data[idx0 + 3] = (layerOut[3] * 255) | 0;

      const idx1 = row1Offset + idx0;
      data[idx1]     = (layerOut[4] * 255) | 0;
      data[idx1 + 1] = (layerOut[5] * 255) | 0;
      data[idx1 + 2] = (layerOut[6] * 255) | 0;
      data[idx1 + 3] = (Math.max(0, Math.min(1, rayShimmer)) * 255) | 0;
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
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
    }

    this._rafId = requestAnimationFrame(t => this._tick(t));
  }

  getCardSize() {
    return 12;
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
    description: 'Westworld Rehoboam predictive divergence visualization'
  });
}