# Rehoboam Divergence Card for Home Assistant

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-41BDF5.svg?style=for-the-badge)](https://github.com/hacs/default)
[![HACS Validation](https://github.com/FHeilmann/lovelace-rehoboam/actions/workflows/validate.yml/badge.svg)](https://github.com/FHeilmann/lovelace-rehoboam/actions/workflows/validate.yml)
[![GitHub Release](https://img.shields.io/github/v/release/FHeilmann/lovelace-rehoboam?style=for-the-badge)](https://github.com/FHeilmann/lovelace-rehoboam/releases)

A WebGL custom Lovelace card inspired by the **Westworld Rehoboam** AI system. It shows the state of your home as divergence waves around a central eclipse. Each entity pushes up a peak on the ring as it moves from its baseline toward its critical value, and a callout labels it.

---

## Features

- **Layered wave strata**: 7 layers of strata with crisp, anti-aliased edges and rim lines. A diverging entity builds up a gradual mountain with one peak. Fold shadows and concentric rings that wobble in and out give the strata depth.
- **Ambient strata**: small strata rise and fall at random places in the calm parts of the ring, so the ring never looks frozen.
- **Eclipse that follows**: the eclipse corona turns toward the entity with the most divergence, or stays at a fixed angle.
- **Callouts with three states**: hidden, monitoring and divergence, each with its own threshold. The leader line draws out from the marker, and the label fades in when the line turns its corner. Labels stack so they do not overlap, and they stay inside the card edges as far as possible.
- **Tap and hold actions**: the centre of the ring and each callout take the standard Home Assistant actions (`more-info`, `toggle`, `navigate`, `url`, `perform-action`, `fire-dom-event`, for example a browser_mod popup).
- **Directional baseline-to-critical mapping**: both high-is-bad (CPU temperature) and low-is-bad (battery, free disk space) sensors work.
- **Visual editor**: entity pickers, action pickers, a slider and a number box for each ranged setting, a tooltip on each setting, and collapsible entity sections.
- **Dark, light and auto themes**: `auto` follows the dark mode setting of Home Assistant.
- **Made for low-end tablets**: the card renders at a reduced resolution, uses a low frame rate when the ring is calm, and pauses when it is off screen or in a background tab. The per-frame CPU work stays well below 1 ms on a desktop for 5 entities.
- **No build step**: a single native Web Component file with no dependencies. The default label font (Barlow Condensed) loads from Google Fonts. Set `font_family` to a local font to make the card fully offline.

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
3. Configure appearance, callouts, actions and entities directly in the UI editor.

### YAML Configuration Example

```yaml
type: custom:lovelace-rehoboam
theme_mode: auto
height: 500px
eclipse_intensity: 1.0
ray_intensity: 0.35
amplitude_scale: 1.25
divergence_threshold: 0.15
monitoring_threshold: 0.05
center_tap_action:
  action: fire-dom-event
  browser_mod:
    service: browser_mod.popup
    data:
      title: Home
      content:
        type: entities
        entities:
          - sensor.processor_use
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
  - entity: sensor.living_room_humidity
    name: Humidity
    category: ATMOSPHERIC VARIANCE
    baseline: 40
    critical: 100
    monitoring_threshold: 55
    divergence_threshold: 70
    unit: "%"
    always_visible: true
  - entity: binary_sensor.front_door
    name: Front Door
    category: PERIMETER BREACH
    state_map:
      "on": 1.0
      "off": 0.0
    hold_action:
      action: more-info
```

### Callout States

Each entity has a divergence between 0 (at `baseline`) and 1 (at `critical`). Its callout has three states:

| State | When |
| ----- | ---- |
| Hidden | Divergence is below the monitoring threshold. With `always_visible: true` the callout shows as monitoring instead. |
| Monitoring | Divergence is at or above the monitoring threshold and below the divergence threshold. |
| Divergence | Divergence is at or above the divergence threshold. |

The card-level `monitoring_threshold` and `divergence_threshold` are fractions (`0.0` – `1.0`) of the range between baseline and critical. The entity-level thresholds are values in the sensor's own unit, for example `70` for 70% humidity. They work in both directions. Without any monitoring threshold there is no monitoring state, and the callout is hidden below the divergence threshold.

---

## Configuration Options

### Card Options

| Parameter | Type | Default | Description |
| --------- | ---- | ------- | ----------- |
| `type` | string | **Required** | `custom:lovelace-rehoboam` |
| `theme_mode` | string | `dark` | `dark` (night eclipse), `light` (ink on paper) or `auto` (follows the Home Assistant dark mode) |
| `height` | string | `500px` | Card height in CSS units (e.g. `500px`, or `100vh` for full-screen panel views) |
| `font_family` | string | Barlow Condensed | CSS font family of the callout labels. The default loads from Google Fonts |
| `font_size` | number | `13` | Callout label font size in px (`8` – `32`) |
| `eclipse_angle` | number or `auto` | `auto` | Empty or `auto`: the eclipse turns toward the most diverged entity. A number fixes the angle in degrees (`0` – `360`) |
| `eclipse_intensity` | number | `1.0` | Brightness of the eclipse crescent and corona (`0.0` – `2.0`) |
| `ray_intensity` | number | `0.35` | Outer ray shimmer intensity (`0.0` – `1.0`) |
| `facet_shading` | number | `0.6` | Strength of the fold shadows on the strata (`0.0` – `1.0`) |
| `ring_shading` | boolean | `true` | Concentric shading rings that wobble in and out across the strata |
| `amplitude_scale` | number | `1.25` | Global wave height multiplier (`0.1` – `3.0`) |
| `strata_width` | number | `1.0` | Width of the strata below a peak (`0.3` – `2.5`) |
| `peak_width` | number | `1.0` | Width of the peak (`0.4` – `3.0`) |
| `peak_sharpness` | number | `0` | `0` gives a flat-topped dome, `1` a pointed tip (`0.0` – `1.0`) |
| `peak_height` | number | `1.0` | How far the peak stands out from the strata (`0.3` – `1.43`) |
| `baseline_height` | number | `1.0` | Height of the thin band of waves around the full ring (`0` – `5`, `0` turns it off) |
| `ambient_count` | number | `3` | Maximum number of ambient strata at one time (`0` – `12`, `0` turns them off) |
| `ambient_size` | number | `0.3` | Maximum height of one ambient stratum (`0.0` – `1.0`) |
| `ambient_width` | number | `1.0` | Width of one ambient stratum (`0.3` – `2.5`) |
| `ambient_lifetime` | number | `25` | Seconds one ambient stratum takes to rise and fall (`4` – `300`) |
| `transition_tau` | number | `2.2` | Time constant in seconds for smooth state transitions (`0.2` – `60`) |
| `ring_scale` | number | `0.42` | Ring radius relative to the card size (`0.1` – `1.0`) |
| `resolution_scale` | number | `0.65` | Canvas render resolution factor (`0.1` – `2.0`) |
| `fps_idle` | number | `24` | Target frame rate when all entities are nominal (`1` – `120`) |
| `fps_active` | number | `45` | Target frame rate during divergence (`1` – `120`) |
| `monitoring_threshold` | number | none | Card-level monitoring threshold (`0.0` – `1.0`). See [Callout States](#callout-states) |
| `divergence_threshold` | number | `0.15` | Card-level divergence threshold (`0.0` – `1.0`). See [Callout States](#callout-states) |
| `test_divergence` | number | none | Override (`0.0` – `1.0`) to preview the eclipse bloom |
| `center_entity` | string | none | Entity that the centre actions use, for example for `more-info` or `toggle` |
| `center_tap_action` | action | `none` | Action on a tap at the centre of the ring |
| `center_hold_action` | action | `none` | Action on a hold at the centre of the ring |
| `hold_time` | number | `500` | Milliseconds a press must last to count as a hold (`150` – `5000`), for the centre and the callouts |
| `entities` | list | `[]` | List of entity IDs or entity configuration objects (see below) |

### Entity Options

| Parameter | Type | Default | Description |
| --------- | ---- | ------- | ----------- |
| `entity` | string | **Required** | Home Assistant entity ID (e.g. `sensor.cpu_temp`) |
| `name` | string | Friendly name | Display label on the callout |
| `category` | string | `SYSTEM ANOMALY` | Classification label in the callout header |
| `baseline` | number | `0` | Nominal value (divergence 0) |
| `critical` | number | `100` | Critical value (divergence 1). If `critical < baseline`, lower values diverge |
| `monitoring_threshold` | number | card value | Monitoring threshold in the sensor's unit. See [Callout States](#callout-states) |
| `divergence_threshold` | number | card value | Divergence threshold in the sensor's unit. See [Callout States](#callout-states) |
| `unit` | string | Entity unit | Display unit override |
| `angle` | number | Auto-spaced | Fixed angle in degrees (`0` – `360`, `0°` = right, counter-clockwise; auto-spacing starts at `22.5°`) |
| `always_visible` | boolean | `false` | Show the callout as monitoring when it would be hidden |
| `state_map` | object | none | Map of raw state strings to divergence values (`0.0` – `1.0`), e.g. `{ "on": 1.0, "off": 0.0 }` |
| `tap_action` | action | `more-info` | Action on a tap on the callout |
| `hold_action` | action | `none` | Action on a hold on the callout |

---

## Development

`harness.html` is a test page that runs the card outside Home Assistant with fake entities. It has controls for every option, live divergence sliders and a button that copies the config as YAML. Serve the repository folder and open the page:

```bash
python3 -m http.server 8766 --bind 127.0.0.1
```

Then open `http://127.0.0.1:8766/harness.html`.

---

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
