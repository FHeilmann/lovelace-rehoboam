# Rehoboam Divergence Card for Home Assistant

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-41BDF5.svg?style=for-the-badge)](https://github.com/hacs/default)
[![HACS Validation](https://github.com/FHeilmann/lovelace-rehoboam/actions/workflows/validate.yml/badge.svg)](https://github.com/FHeilmann/lovelace-rehoboam/actions/workflows/validate.yml)
[![GitHub Release](https://img.shields.io/github/v/release/FHeilmann/lovelace-rehoboam?style=for-the-badge)](https://github.com/FHeilmann/lovelace-rehoboam/releases)

A high-performance, WebGL-accelerated custom Lovelace card inspired by the **Westworld Rehoboam** AI system. It visualizes systemic anomalies, metrics, and home state as dynamic predictive divergence waves around a central eclipse.

---

## Features

- **Hardware-Accelerated WebGL Shaders**: 7-layer wave strata with smooth Hann raised-cosine wave peaks and dynamic ray striation.
- **Directional Baseline-to-Critical Clamping**: Automatically handles low-is-good/high-is-bad (e.g. CPU temperature) vs high-is-good/low-is-bad (e.g. battery or free disk space).
- **Lovelace Visual Configuration Editor**: Complete graphical editor with built-in entity pickers, sliders, and live preview.
- **Adaptive Frame Rate & Viewport Culling**: Runs at a low idle FPS, ramps up smoothly during active divergence events, and pauses rendering when off-screen or in a background tab.
- **Dark & Light Themes**: Supports both dark mode (night eclipse) and light mode (ink/paper style).
- **Zero Build Step**: Native Web Components with zero external dependencies, 100% offline-ready.

---

## Installation

### Method 1: Via HACS (Recommended)

1. Make sure [HACS](https://hacs.xyz/) is installed in your Home Assistant instance.
2. In Home Assistant, open **HACS** > **Frontend**.
3. Click the three dots in the top right corner and select **Custom repositories**.
4. Enter repository URL: `https://github.com/FHeilmann/lovelace-rehoboam`
5. Select Category: **Dashboard** (or **Lovelace**).
6. Click **Add**, then find **Rehoboam Card** and click **Download**.
7. Refresh your browser cache.

### Method 2: Manual Installation

1. Download `lovelace-rehoboam.js` from the [latest release](https://github.com/FHeilmann/lovelace-rehoboam/releases).
2. Copy `lovelace-rehoboam.js` into your Home Assistant directory: `<config>/www/lovelace-rehoboam.js`.
3. In Home Assistant, go to **Settings** > **Dashboards** > **Resources** (top right three dots).
4. Click **Add Resource**:
   - URL: `/local/lovelace-rehoboam.js`
   - Resource type: **JavaScript Module**
5. Refresh your browser.

---

## Configuration

### Visual Editor
1. In your Lovelace dashboard, click **Edit Dashboard** > **Add Card**.
2. Search for **Rehoboam Divergence Card**.
3. Configure appearance, performance, and entities directly in the UI editor.

### YAML Configuration Example

```yaml
type: custom:lovelace-rehoboam
theme_mode: dark
height: 500px
eclipse_angle: 180
eclipse_intensity: 1.0
ray_intensity: 0.35
amplitude_scale: 1.25
fps_idle: 24
fps_active: 45
divergence_threshold: 0.15
entities:
  - entity: sensor.processor_use
    name: CPU Load
    category: COMPUTE DIVERGENCE
    baseline: 15
    critical: 85
    unit: "%"
  - entity: sensor.disk_free
    name: Free Storage
    category: CAPACITY DEPLETION
    baseline: 100
    critical: 10
    unit: GB
  - entity: sensor.living_room_temperature
    name: Indoor Temp
    category: THERMAL VARIANCE
    baseline: 21
    critical: 32
    threshold: 0.25
    unit: "°C"
    always_visible: false
  - entity: binary_sensor.front_door
    name: Front Door
    category: PERIMETER BREACH
    state_map:
      "on": 1.0
      "off": 0.0
```

---

## Configuration Options

### Card Options

| Parameter | Type | Default | Description |
| --------- | ---- | ------- | ----------- |
| `type` | string | **Required** | `custom:lovelace-rehoboam` |
| `theme_mode` | string | `dark` | Visual theme: `dark` (night eclipse) or `light` (day eclipse) |
| `height` | string | `500px` | Card height in CSS units (e.g. `500px`, `600px`, or `100vh` for full-screen panel views) |
| `eclipse_angle` | number | `180` | Eclipse bloom orientation angle in degrees (`0` – `360`) |
| `eclipse_intensity`| number | `1.0` | Brightness of the eclipse crescent and corona (`0.0` – `2.0`) |
| `ray_intensity` | number | `0.35` | Outer ray shimmer and corona striation intensity (`0.0` – `1.0`) |
| `amplitude_scale` | number | `1.25` | Global wave height multiplier (`0.4` – `2.0`) |
| `transition_tau` | number | `2.2` | Time constant in seconds for smooth state transitions (`0.2` – `15`) |
| `ring_scale` | number | `0.42` | Inner core radius scale relative to card size (`0.25` – `0.65`) |
| `resolution_scale`| number | `0.65` | Canvas render buffer resolution factor (`0.35` – `1.0`) |
| `fps_idle` | number | `24` | Target framerate when all entities are nominal (`10` – `60`) |
| `fps_active` | number | `45` | Target framerate during active divergence events (`15` – `60`) |
| `divergence_threshold` | number | `0.15` | Global minimum divergence (`0.0` – `1.0`) to show callout indicators |
| `test_divergence` | number | `null` | Optional override (`0.0` – `1.0`) for previewing the eclipse bloom intensity |
| `entities` | list | `[]` | List of entity strings or entity configuration objects (see below) |

### Entity Options

| Parameter | Type | Default | Description |
| --------- | ---- | ------- | ----------- |
| `entity` | string | **Required** | Home Assistant entity ID (e.g. `sensor.cpu_temp`) |
| `name` | string | Friendly name | Custom display label on the anomaly callout |
| `category` | string | `SYSTEM ANOMALY` | Classification label displayed in the callout header |
| `baseline` | number | `0` | Nominal resting state value (0% divergence) |
| `critical` | number | `100` | Critical threshold where divergence reaches 1.0 (100%). If `critical < baseline`, lower values diverge |
| `threshold` | number | `divergence_threshold` | Per-entity divergence threshold (`0.0` – `1.0`) to trigger callout visibility |
| `unit` | string | Entity unit | Display unit override |
| `angle` | number | Auto-spaced | Fixed polar angle in degrees (`0` – `360`, where `0°` = right, counter-clockwise; auto-distribution starts at `22.5°`) |
| `always_visible` | boolean | `false` | If `true`, callout indicator stays visible even when nominal |
| `state_map` | object | `null` | Optional map of raw state strings to divergence values (`0.0` – `1.0`), e.g. `{ "on": 1.0, "off": 0.0 }` |

---

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
