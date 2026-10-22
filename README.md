# Rehoboam Divergence Card for Home Assistant

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-41BDF5.svg?style=for-the-badge)](https://github.com/hacs/default)
[![HACS Validation](https://github.com/FHeilmann/lovelace-rehoboam/actions/workflows/validate.yml/badge.svg)](https://github.com/FHeilmann/lovelace-rehoboam/actions/workflows/validate.yml)
[![GitHub Release](https://img.shields.io/github/v/release/FHeilmann/lovelace-rehoboam?style=for-the-badge)](https://github.com/FHeilmann/lovelace-rehoboam/releases)

A WebGL custom Lovelace card inspired by the **Westworld Rehoboam** AI system. It shows the state of your home as divergence waves around a central eclipse. Each entity pushes up a peak on the ring as it moves from its baseline toward its critical value, and a callout labels it.

**[Try it in the playground](https://fheilmann.github.io/lovelace-rehoboam/)**: change every setting, simulate sensor values and copy the YAML config for your dashboard, without Home Assistant.

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

### Playground
The [playground](https://fheilmann.github.io/lovelace-rehoboam/) runs the card in your browser with example sensors. Change the settings, replace the example entities with your own, then click **Copy YAML** and paste the result into a manual card. **Share link** copies a link that opens the playground with your current settings.

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

The card-level `monitoring_threshold` and `divergence_threshold` are fractions (`0.0` – `1.0`) of the range between baseline and critical. The entity-level thresholds are values in the sensor's own unit, for example `70` for 70% humidity. They work in both directions. For an entity with a `state_map`, the entity-level thresholds are divergence values (`0.0` – `1.0`) instead, the same scale as the map. Without any monitoring threshold there is no monitoring state, and the callout is hidden below the divergence threshold.

---

## Configuration Options

The editor, the playground and these tables use the same settings list in `lovelace-rehoboam.js`. Values outside a range are clamped to it.

### Card Options

<!-- BEGIN card-options -->
| Option | Type | Default | Range | Description |
| ------ | ---- | ------- | ----- | ----------- |
| `type` | string | **Required** | | `custom:lovelace-rehoboam` |
| `theme_mode` | string | `dark` | `dark`, `light`, `auto` | Dark shows a night eclipse, light shows ink on paper. Auto follows the dark mode setting of Home Assistant. |
| `eclipse_angle` | number or auto | `auto` | `0` – `360` | Direction of the eclipse glow in degrees (0 = right, counter-clockwise). Leave empty to turn the glow toward the entity with the most divergence. |
| `eclipse_intensity` | number | `1` | `0` – `2` | Brightness of the eclipse crescent and its corona. |
| `ray_intensity` | number | `0.35` | `0` – `1` | Strength of the thin rays that shimmer outward from the ring. |
| `test_divergence` | number | none | `0` – `1` | Preview only: forces the eclipse glow to this divergence. Leave empty to use the live values. |
| `amplitude_scale` | number | `1.25` | `0.1` – `3` | Height multiplier for all waves and strata. |
| `peak_width` | number | `1` | `0.4` – `3` | Width of the peak that rises above a diverging entity. |
| `peak_sharpness` | number | `0` | `0` – `1` | Shape of the peak: 0 is a flat-topped dome, 1 is a pointed tip. |
| `peak_height` | number | `1` | `0.3` – `1.43` | How far the peak stands out above the strata below it. |
| `strata_width` | number | `1` | `0.3` – `2.5` | Width of the strata below each peak. |
| `baseline_height` | number | `1` | `0` – `5` | Height of the thin band of waves around the full ring. 0 gives a flat ring. |
| `facet_shading` | number | `0.6` | `0` – `1` | Strength of the fold shadows that make the strata look 3D. |
| `ring_shading` | boolean | `true` |  | Concentric shading rings that wobble inward and outward across the strata. |
| `ambient_count` | number | `3` | `0` – `12` | Maximum number of small ambient strata that rise and fall at random places in the calm parts of the ring. 0 turns them off. |
| `ambient_size` | number | `0.3` | `0` – `1` | Maximum height of one ambient stratum. |
| `ambient_width` | number | `1` | `0.3` – `2.5` | Width of one ambient stratum. |
| `ambient_lifetime` | number | `25` | `4` – `300` | Seconds one ambient stratum takes to rise and fall again. |
| `divergence_threshold` | number | `0.15` | `0` – `1` | Fraction (0-1) of the way from baseline to critical where a callout changes to DIVERGENCE. |
| `monitoring_threshold` | number | none | `0` – `1` | Fraction (0-1) of the way from baseline to critical where a callout appears as MONITORING. Leave empty for no monitoring state. |
| `transition_tau` | number | `2.2` | `0.2` – `20` | Time constant in seconds of the smooth change when a value changes. Higher values give slower, calmer motion. |
| `font_family` | string | Barlow Condensed |  | CSS font family of the callout labels. The default Barlow Condensed loads from Google Fonts. Set a local font to keep the card offline. |
| `font_size` | number | `13` | `8` – `32` | Size of the callout label text in px. The leader lines and label spacing scale with it. |
| `hold_time` | number | `500` | `150` – `5000` | Milliseconds a press must last to count as a hold. Applies to the centre and to the callouts. |
| `center_entity` | string | none |  | Entity that the centre actions use, for example for more-info or toggle. |
| `center_tap_action` | action | `none` |  | Action when you tap the centre of the ring. For a browser_mod popup use fire-dom-event with a browser_mod block in YAML. |
| `center_hold_action` | action | `none` |  | Action when you press and hold the centre of the ring. |
| `height` | string | `500px` |  | Card height in CSS units, for example 500px, or 100vh for a full-screen panel view. |
| `ring_scale` | number | `0.42` | `0.2` – `0.9` | Ring radius relative to the card size. |
| `resolution_scale` | number | `0.65` | `0.25` – `1` | Render resolution relative to the screen. Lower values save GPU time on slow tablets. |
| `fps_idle` | number | `24` | `5` – `60` | Frame rate while all entities are calm. |
| `fps_active` | number | `45` | `10` – `120` | Frame rate while an entity diverges or a value changes. |
| `entities` | list | `[]` | | Entity IDs or entity option objects, see [Entity Options](#entity-options). |
<!-- END card-options -->

### Entity Options

<!-- BEGIN entity-options -->
| Option | Type | Default | Range | Description |
| ------ | ---- | ------- | ----- | ----------- |
| `entity` | string | **Required** |  | Home Assistant entity that drives this callout. |
| `name` | string | Friendly name |  | Label text on the callout. Empty uses the friendly name of the entity. |
| `category` | string | `SYSTEM ANOMALY` |  | Header text above the label, for example THERMAL VARIANCE. |
| `baseline` | number | `0` |  | Value at which the entity is calm (divergence 0). |
| `critical` | number | `100` |  | Value at which the entity is fully diverged (divergence 1). If it is below the baseline, lower values diverge. |
| `state_map` | object | none | state: `0` – `1` | Divergence (0-1) for each listed state, for example home 0 and not_home 1. A listed state ignores baseline and critical. With a map, the entity thresholds are divergence values (0-1). |
| `unit` | string | Entity unit |  | Unit shown after the value. Empty uses the unit of the entity. |
| `angle` | number | auto-spaced | `0` – `360` | Position of the callout on the ring in degrees (0 = right, counter-clockwise). Leave empty to space the callouts evenly. |
| `monitoring_threshold` | number | card setting | baseline – critical, or `0` – `1` with a state map | Sensor value where this callout appears as MONITORING; with a state map, a divergence value (0-1). Leave empty to use the card setting. |
| `divergence_threshold` | number | card setting | baseline – critical, or `0` – `1` with a state map | Sensor value where this callout changes to DIVERGENCE; with a state map, a divergence value (0-1). Leave empty to use the card setting. |
| `always_visible` | boolean | `false` |  | Show the callout as MONITORING also when it would be hidden. |
| `tap_action` | action | `more-info` |  | Action when you tap this callout. The default opens more-info. |
| `hold_action` | action | `none` |  | Action when you press and hold this callout. |
<!-- END entity-options -->

---

## Development

The settings list (`CARD_SETTINGS` and `ENTITY_SETTINGS` in `lovelace-rehoboam.js`) holds the label, range, default and tooltip of every option. The card, the visual editor and the playground read it. After a change to it, run `node scripts/readme-options.mjs` to update the option tables in this README; CI fails when they are out of date.

`harness.html` is the playground page. The `Playground` workflow publishes it to GitHub Pages as `index.html`, together with `lovelace-rehoboam.js`, on every push to `main`. To run it locally, serve the repository folder and open the page:

```bash
python3 -m http.server 8766 --bind 127.0.0.1
```

Then open `http://127.0.0.1:8766/harness.html`. URL options for testing: `grid=1` shows the 4 theme and eclipse presets side by side, `one=0` to `one=3` shows one preset, `panel=0` hides the settings panel, and `v=<name>` loads `<name>.js` instead of the card.

---

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
