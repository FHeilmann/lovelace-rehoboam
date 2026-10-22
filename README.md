<div align="center">

<img src="https://raw.githubusercontent.com/FHeilmann/lovelace-rehoboam/main/images/hero.webp" alt="The Rehoboam card: a dark ring with an eclipse glow, peaks rising where sensors diverge, and labelled callouts" width="100%">

# Rehoboam

**A living divergence ring for your Home Assistant dashboard, after the Rehoboam AI in Westworld.**

[![HACS](https://img.shields.io/badge/HACS-Custom-41BDF5?style=for-the-badge)](https://hacs.xyz)
[![Release](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fapi.github.com%2Frepos%2FFHeilmann%2Flovelace-rehoboam%2Freleases%2Flatest&query=%24.tag_name&label=release&color=blue&style=for-the-badge)](https://github.com/FHeilmann/lovelace-rehoboam/releases/latest)
[![Validation](https://img.shields.io/github/actions/workflow/status/FHeilmann/lovelace-rehoboam/validate.yml?branch=main&style=for-the-badge&label=validation)](https://github.com/FHeilmann/lovelace-rehoboam/actions/workflows/validate.yml)
[![License](https://img.shields.io/github/license/FHeilmann/lovelace-rehoboam?style=for-the-badge&label=license)](https://github.com/FHeilmann/lovelace-rehoboam/blob/main/LICENSE)

[**Try the playground**](https://fheilmann.github.io/lovelace-rehoboam/) · [Install](#installation) · [Quick start](#quick-start) · [All options](#configuration-options)

</div>

---

Every entity you add gets its own place on the ring. While its value stays near its baseline, the ring is calm. When the value moves toward critical, strata build up into a peak, the eclipse turns toward it, and a callout draws out to name it. Small ambient strata rise and fall in the calm parts, so the ring never looks frozen.

This card is a fan project. See [Credits](#credits) for the work that inspired it.

## Highlights

<table>
<tr>
<td width="50%" valign="top">

**Made to look like the show**
- 7 layers of strata with crisp edges, fold shadows and slowly wobbling shading rings
- An eclipse glow that follows the entity with the most divergence
- Callouts that draw their leader line, then fade in their label
- Dark, light and auto themes

</td>
<td width="50%" valign="top">

**Made for Home Assistant**
- Visual editor with sliders, tooltips and entity and action pickers
- Tap and hold actions on the centre and on each callout, browser_mod popups included
- A title with a live template subtitle
- Six languages, with Home Assistant's own number and state format

</td>
</tr>
<tr>
<td width="50%" valign="top">

**Clear states**
- Hidden, monitoring and divergence, each with its own threshold
- Works for high-is-bad and low-is-bad sensors
- State maps for text states such as `home` and `not_home`

</td>
<td width="50%" valign="top">

**Light on old tablets**
- Lower render resolution and frame rate while the ring is calm
- Pauses when it is off screen or in a background tab
- One file, no dependencies, no build step, no external requests

</td>
</tr>
</table>

## Gallery

<table>
<tr>
<td width="50%"><img src="https://raw.githubusercontent.com/FHeilmann/lovelace-rehoboam/main/images/hero-dark.png" alt="The card in the dark theme"></td>
<td width="50%"><img src="https://raw.githubusercontent.com/FHeilmann/lovelace-rehoboam/main/images/light.png" alt="The card in the light theme"></td>
</tr>
<tr>
<td align="center"><b>Dark</b> (night eclipse)</td>
<td align="center"><b>Light</b> (ink on paper)</td>
</tr>
<tr>
<td width="50%"><img src="https://raw.githubusercontent.com/FHeilmann/lovelace-rehoboam/main/images/german.png" alt="The card with German callouts and German number format"></td>
<td width="50%"><img src="https://raw.githubusercontent.com/FHeilmann/lovelace-rehoboam/main/images/playground.png" alt="The playground: the card with its settings panel"></td>
</tr>
<tr>
<td align="center"><b>Localized</b>: German callouts and number format</td>
<td align="center"><b><a href="https://fheilmann.github.io/lovelace-rehoboam/">Playground</a></b>: try every setting, then copy the YAML</td>
</tr>
</table>

<details>
<summary><b>The visual editor</b></summary>
<br>
<table>
<tr>
<td width="50%" valign="top"><img src="https://raw.githubusercontent.com/FHeilmann/lovelace-rehoboam/main/images/editor.png" alt="The visual editor: sections with sliders, number boxes and tooltips"></td>
<td width="50%" valign="top"><img src="https://raw.githubusercontent.com/FHeilmann/lovelace-rehoboam/main/images/editor-entity.png" alt="An entity in the visual editor, with a state map"></td>
</tr>
<tr>
<td align="center">Sections with a slider, a number box and a tooltip for each setting</td>
<td align="center">Each entity in four groups, here with a state map</td>
</tr>
</table>
</details>

## Quick start

1. Install the card with HACS (see [Installation](#installation)).
2. Add a manual card to a dashboard and paste:

```yaml
type: custom:lovelace-rehoboam
title: Home
subtitle: "{{ states('sensor.outside_temperature') }} °C outside"
entities:
  - entity: sensor.living_room_temperature
    category: THERMAL VARIANCE
    baseline: 21
    critical: 30
  - entity: sensor.living_room_humidity
    category: HUMIDITY
    baseline: 45
    critical: 80
  - entity: sensor.phone_battery
    category: BATTERY
    baseline: 100
    critical: 15
```

3. Open the visual editor to fine-tune it, or build the whole config in the [playground](https://fheilmann.github.io/lovelace-rehoboam/) and paste it.

---

## Installation

### HACS (recommended)

[![Open your Home Assistant instance and open this repository in HACS](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=FHeilmann&repository=lovelace-rehoboam&category=plugin)

Click the button above, or add the repository by hand:

1. Open **HACS** in Home Assistant.
2. Open the menu (three dots, top right) and select **Custom repositories**.
3. Enter `https://github.com/FHeilmann/lovelace-rehoboam`, select the type **Dashboard**, and click **Add**.
4. Search for **Rehoboam Card**, open it and click **Download**.
5. Reload the browser page.

### Manual

1. Download `lovelace-rehoboam.js` from the [latest release](https://github.com/FHeilmann/lovelace-rehoboam/releases).
2. Copy it to `<config>/www/lovelace-rehoboam.js`.
3. Go to **Settings** > **Dashboards**, open the menu (three dots, top right) and select **Resources**.
4. Add the resource `/local/lovelace-rehoboam.js` with the type **JavaScript module**.
5. Reload the browser page.

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
title: Home
subtitle: "{{ states('sensor.outside_temperature') }} °C outside · {{ states('person.alex') }}"
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

### Title and Subtitle

`title` and `subtitle` show in the top left corner of the card. The subtitle accepts [Home Assistant templates](https://www.home-assistant.io/docs/configuration/templating/): Home Assistant renders the template and sends a new result whenever it changes, so the card does no polling. The variable `user` holds the name of the current user. A template error leaves the subtitle empty and logs a warning in the browser console. The playground renders only `states('…')` and `state_attr('…', '…')`.

### Localization

The card shows its callout text in the Home Assistant language of the user, or in the language that `language` sets. It ships English, German, French, Spanish, Dutch and Italian; other languages fall back to English.

- `monitoring_label` and `divergence_label` replace the words MONITORING and DIVERGENCE in the callout header, for example `divergence_label: ALARM`. The `category` of each entity is your own text.
- Callout values use the Home Assistant state format (Home Assistant 2023.12 or newer): localized numbers (`27,9 °C`) and translated states (`Abwesend` instead of `not_home`). With a `unit` override, the number keeps the local format and the unit is replaced.
- The visual editor shows its labels and tooltips in the language of the Home Assistant user.

To add a language, copy one block in `TRANSLATIONS` (and in `PAGE_TEXT` in `harness.html` for the playground), translate it, and add the language to `LANGUAGES` and to the `language` option. Missing entries fall back to English.

---

## Configuration Options

The editor, the playground and these tables use the same settings list in `lovelace-rehoboam.js`. Values outside a range are clamped to it.

### Card Options

<!-- BEGIN card-options -->
| Option | Type | Default | Range | Description |
| ------ | ---- | ------- | ----- | ----------- |
| `type` | string | **Required** | | `custom:lovelace-rehoboam` |
| **Title** | | | | |
| `title` | string | — |  | Text in the top left corner of the card. Empty shows no title. |
| `subtitle` | template | — |  | Text below the title. Accepts Home Assistant templates, for example {{ states("sensor.outside_temperature") }}; the card updates it when the result changes. |
| **Appearance** | | | | |
| `theme_mode` | string | `dark` | `dark`, `light`, `auto` | Dark shows a night eclipse, light shows ink on paper. Auto follows the dark mode setting of Home Assistant. |
| `height` | string | `500px` |  | Card height in CSS units, for example 500px, or 100vh for a full-screen panel view. |
| `ring_scale` | number | `0.42` | `0.2` – `0.9` | Ring radius relative to the card size. |
| **Eclipse** | | | | |
| `eclipse_angle` | number or auto | `auto` | `0` – `360` | Direction of the eclipse glow in degrees (0 = right, counter-clockwise). Leave empty to turn the glow toward the entity with the most divergence. |
| `eclipse_intensity` | number | `1` | `0` – `2` | Brightness of the eclipse crescent and its corona. |
| `ray_intensity` | number | `0.35` | `0` – `1` | Strength of the thin rays that shimmer outward from the ring. |
| `test_divergence` | number | none | `0` – `1` | Preview only: forces the eclipse glow to this divergence. Leave empty to use the live values. |
| **Peak** | | | | |
| `peak_width` | number | `1` | `0.4` – `3` | Width of the peak that rises above a diverging entity. |
| `peak_sharpness` | number | `0` | `0` – `1` | Shape of the peak: 0 is a flat-topped dome, 1 is a pointed tip. |
| `peak_height` | number | `1` | `0.3` – `1.43` | How far the peak stands out above the strata below it. |
| **Strata and waves** | | | | |
| `amplitude_scale` | number | `1.25` | `0.1` – `3` | Height multiplier for all waves and strata. |
| `strata_width` | number | `1` | `0.3` – `2.5` | Width of the strata below each peak. |
| `baseline_height` | number | `1` | `0` – `5` | Height of the thin band of waves around the full ring. 0 gives a flat ring. |
| `facet_shading` | number | `0.6` | `0` – `1` | Strength of the fold shadows that make the strata look 3D. |
| `ring_shading` | boolean | `true` |  | Concentric shading rings that wobble inward and outward across the strata. |
| **Ambient strata** | | | | |
| `ambient_count` | number | `3` | `0` – `12` | Maximum number of small ambient strata that rise and fall at random places in the calm parts of the ring. 0 turns them off. |
| `ambient_size` | number | `0.3` | `0` – `1` | Maximum height of one ambient stratum. |
| `ambient_width` | number | `1` | `0.3` – `2.5` | Width of one ambient stratum. |
| `ambient_lifetime` | number | `25` | `4` – `300` | Seconds one ambient stratum takes to rise and fall again. |
| **Divergence** | | | | |
| `divergence_threshold` | number | `0.15` | `0` – `1` | Fraction (0-1) of the way from baseline to critical where a callout changes to DIVERGENCE. |
| `monitoring_threshold` | number | none | `0` – `1` | Fraction (0-1) of the way from baseline to critical where a callout appears as MONITORING. Leave empty for no monitoring state. |
| `transition_tau` | number | `2.2` | `0.2` – `20` | Time constant in seconds of the smooth change when a value changes. Higher values give slower, calmer motion. |
| **Callout text** | | | | |
| `language` | string | auto | empty, `en`, `de`, `fr`, `es`, `nl`, `it` | Language of the callout text and the value format. Auto follows the Home Assistant language. |
| `monitoring_label` | string | MONITORING, translated |  | Text before the category on a monitoring callout. Empty uses the translation for the card language. |
| `divergence_label` | string | DIVERGENCE, translated |  | Text before the category on a diverging callout. Empty uses the translation for the card language. |
| `font_family` | string | Roboto |  | CSS font family of the callout labels and the title. The default is Roboto, the font of Home Assistant. A font that is not installed falls back to the next one in the list. "Barlow Condensed" loads from Google Fonts. |
| `font_size` | number | `13` | `8` – `32` | Size of the callout label text in px. The leader lines and label spacing scale with it. |
| **Interaction** | | | | |
| `hold_time` | number | `500` | `150` – `5000` | Milliseconds a press must last to count as a hold. Applies to the centre and to the callouts. |
| `center_entity` | string | none |  | Entity that the centre actions use, for example for more-info or toggle. |
| `center_tap_action` | action | `none` |  | Action when you tap the centre of the ring. For a browser_mod popup use fire-dom-event with a browser_mod block in YAML. |
| `center_hold_action` | action | `none` |  | Action when you press and hold the centre of the ring. |
| **Performance** | | | | |
| `resolution_scale` | number | `0.65` | `0.25` – `1` | Render resolution relative to the screen. Lower values save GPU time on slow tablets. |
| `fps_idle` | number | `24` | `5` – `60` | Frame rate while all entities are calm. |
| `fps_active` | number | `45` | `10` – `120` | Frame rate while an entity diverges or a value changes. |
| `entities` | list | `[]` | | Entity IDs or entity option objects, see [Entity Options](#entity-options). |
<!-- END card-options -->

### Entity Options

<!-- BEGIN entity-options -->
| Option | Type | Default | Range | Description |
| ------ | ---- | ------- | ----- | ----------- |
| **Entity** | | | | |
| `entity` | string | **Required** |  | Home Assistant entity that drives this callout. |
| `name` | string | Friendly name |  | Label text on the callout. Empty uses the friendly name of the entity. |
| `category` | string | SYSTEM ANOMALY, translated |  | Header text above the label, for example THERMAL VARIANCE. |
| `unit` | string | Entity unit |  | Unit shown after the value. Empty uses the unit of the entity. |
| **Value range** | | | | |
| `baseline` | number | `0` |  | Value at which the entity is calm (divergence 0). |
| `critical` | number | `100` |  | Value at which the entity is fully diverged (divergence 1). If it is below the baseline, lower values diverge. |
| `state_map` | object | none | state: `0` – `1` | Divergence (0-1) for each listed state, for example home 0 and not_home 1. A listed state ignores baseline and critical. With a map, the entity thresholds are divergence values (0-1). |
| **Callout** | | | | |
| `angle` | number | auto-spaced | `0` – `360` | Position of the callout on the ring in degrees (0 = right, counter-clockwise). Leave empty to space the callouts evenly. |
| `monitoring_threshold` | number | card setting | baseline – critical, or `0` – `1` with a state map | Sensor value where this callout appears as MONITORING; with a state map, a divergence value (0-1). Leave empty to use the card setting. |
| `divergence_threshold` | number | card setting | baseline – critical, or `0` – `1` with a state map | Sensor value where this callout changes to DIVERGENCE; with a state map, a divergence value (0-1). Leave empty to use the card setting. |
| `always_visible` | boolean | `false` |  | Show the callout as MONITORING also when it would be hidden. |
| **Actions** | | | | |
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

Then open `http://127.0.0.1:8766/harness.html`. URL options for testing: `grid=1` shows the 4 theme and eclipse presets side by side, `one=0` to `one=3` shows one preset, and `panel=0` hides the settings panel.

The README images come from the playground. With the server running, `node scripts/screenshots.mjs <tmp dir>` captures them with headless Chromium, and `python3 scripts/build-images.py <tmp dir> images` turns them into `images/hero.webp` and the PNGs (needs Pillow).

---

## Credits

- **Westworld**, the HBO series created by Jonathan Nolan and Lisa Joy. Rehoboam, its divergence ring and its look come from the show. This project is not affiliated with or endorsed by HBO or the creators of Westworld.
- **Emil Besirevic**, whose Rehoboam builds inspired this card:
  - [thebosniandiycorner](https://www.youtube.com/@thebosniandiycorner4632) on YouTube, in particular [Rehoboam (3d print and dashboard)](https://www.youtube.com/watch?v=L245YQNlLZg)
  - [Emil Besirevic](https://www.artstation.com/ebes) on ArtStation, in particular [his Rehoboam artwork](https://www.artstation.com/artwork/188PBG)

---

## License

This project is licensed under the MIT License - see the [LICENSE](https://github.com/FHeilmann/lovelace-rehoboam/blob/main/LICENSE) file for details.
