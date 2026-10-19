# Rehoboam Divergence Card for Home Assistant

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-41BDF5.svg?style=for-the-badge)](https://github.com/hacs/default)
[![HACS Validation](https://github.com/florian/lovelace-rehoboam/actions/workflows/validate.yml/badge.svg)](https://github.com/florian/lovelace-rehoboam/actions/workflows/validate.yml)
[![GitHub Release](https://img.shields.io/github/v/release/florian/lovelace-rehoboam?style=for-the-badge)](https://github.com/florian/lovelace-rehoboam/releases)

A high-performance, WebGL-accelerated custom Lovelace card inspired by the **Westworld Rehoboam** AI system. It visualizes systemic anomalies, metrics, and home state as dynamic predictive divergence waves around a central eclipse.

---

## Features

- **Hardware-Accelerated WebGL Shaders**: 7-layer wave strata with smooth Hann raised-cosine wave peaks and dynamic ray striation.
- **Directional Baseline-to-Critical Clamping**: Automatically handles low-is-good/high-is-bad (e.g. CPU temperature) vs high-is-good/low-is-bad (e.g. battery or disk space).
- **Lovelace Visual Configuration Editor**: Complete graphical editor with built-in entity pickers, sliders, and live preview.
- **Adaptive Frame Rate**: Runs at a low idle FPS and ramps up smoothly during active divergence events.
- **Dark & Light Themes**: Supports both dark mode (night eclipse) and light mode (ink/paper style).
- **Zero Build Step**: Native Web Components with zero external dependencies, 100% offline-ready.

---

## Installation

### Method 1: Via HACS (Recommended)

1. Make sure [HACS](https://hacs.xyz/) is installed in your Home Assistant instance.
2. In Home Assistant, open **HACS** > **Frontend**.
3. Click the three dots in the top right corner and select **Custom repositories**.
4. Enter repository URL: `https://github.com/florian/lovelace-rehoboam`
5. Select Category: **Dashboard** (or **Lovelace**).
6. Click **Add**, then find **Rehoboam Card** and click **Download**.
7. Refresh your browser cache.

### Method 2: Manual Installation

1. Download `lovelace-rehoboam.js` from the [latest release](https://github.com/florian/lovelace-rehoboam/releases).
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
type: custom:rehoboam-card
theme_mode: dark
height: 550px
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
    unit: "°C"
    always_visible: false
```

---

## Configuration Options

### Card Options

| Parameter | Type | Default | Description |
| --------- | ---- | ------- | ----------- |
| `type` | string | **Required** | `custom:rehoboam-card` (or `custom:lovelace-rehoboam`) |
| `theme_mode` | string | `dark` | Visual theme: `dark` (night eclipse) or `light` (ink) |
| `height` | string | `100vh` | Card height in CSS units (e.g. `100vh`, `600px`, `450px`) |
| `eclipse_angle` | number | `180` | Eclipse bloom orientation angle in degrees (`0` - `360`) |
| `eclipse_intensity`| number | `1.0` | Brightness of the eclipse crescent and corona (`0.0` - `2.0`) |
| `ray_intensity` | number | `0.35` | Outer ray shimmer and corona striation intensity (`0.0` - `1.0`) |
| `amplitude_scale` | number | `1.25` | Global wave height multiplier (`0.5` - `3.0`) |
| `transition_tau` | number | `2.2` | Time constant in seconds for smooth state transitions |
| `ring_scale` | number | `0.42` | Inner core radius scale relative to card size |
| `resolution_scale`| number | `0.65` | Canvas render buffer resolution factor (`0.5` - `1.0`) |
| `fps_idle` | number | `24` | Target framerate when all entities are nominal |
| `fps_active` | number | `45` | Target framerate during active divergence events |
| `divergence_threshold` | number | `0.15` | Minimum divergence score to activate callout indicators |
| `test_divergence` | number | `null` | Optional fixed divergence value (`0.0` - `1.0`) for previewing |
| `entities` | list | `[]` | List of entities to monitor (see below) |

### Entity Options

| Parameter | Type | Default | Description |
| --------- | ---- | ------- | ----------- |
| `entity` | string | **Required** | Home Assistant entity ID (e.g. `sensor.cpu_temp`) |
| `name` | string | Friendly name | Custom display label on the anomaly callout |
| `category` | string | `SYSTEM ANOMALY` | Classification label displayed in header |
| `baseline` | number | `0` | Nominal resting state value |
| `critical` | number | `100` | Critical threshold where divergence reaches 1.0 (100%) |
| `unit` | string | Entity unit | Display unit override |
| `angle` | number | Auto-spaced | Fixed polar position angle in degrees (`0` - `360`) |
| `always_visible` | boolean | `false` | If `true`, callout indicator stays visible even when nominal |

---

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
