# Rehoboam Card for Home Assistant

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-41BDF5.svg?style=for-the-badge)](https://github.com/hacs/default)
[![HACS Validation](https://github.com/florian/lovelace-rehoboam/actions/workflows/validate.yml/badge.svg)](https://github.com/florian/lovelace-rehoboam/actions/workflows/validate.yml)
[![GitHub Release](https://img.shields.io/github/v/release/florian/lovelace-rehoboam?style=for-the-badge)](https://github.com/florian/lovelace-rehoboam/releases)

A custom Home Assistant Lovelace card providing a Rehoboam interface visualization.

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
2. Search for **Rehoboam Card**.
3. Configure the card parameters directly in the UI editor.

### YAML Configuration

```yaml
type: custom:lovelace-rehoboam
title: Rehoboam
entity: sensor.example # optional
```

### Options

| Name | Type | Requirement | Default | Description |
| ---- | ---- | ----------- | ------- | ----------- |
| `type` | string | **Required** | `custom:lovelace-rehoboam` | Card type identifier |
| `title` | string | Optional | `Rehoboam` | Header title displayed on the card |
| `entity` | string | Optional | none | Target entity for status or state tracking |

---

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
