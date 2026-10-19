/**
 * Lovelace Rehoboam Card
 * https://github.com/florian/lovelace-rehoboam
 */

console.info(
  `%c REHOBOAM-CARD %c Initialized `,
  "color: white; background: #03a9f4; font-weight: 700;",
  "color: #03a9f4; background: white; font-weight: 700;"
);

class LovelaceRehoboamCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = null;
  }

  setConfig(config) {
    if (!config) {
      throw new Error("Invalid configuration");
    }
    this._config = {
      title: "Rehoboam",
      ...config,
    };
    this.render();
  }

  set hass(hass) {
    this._hass = hass;
    this.update();
  }

  getCardSize() {
    return 3;
  }

  static async getConfigElement() {
    return document.createElement("lovelace-rehoboam-editor");
  }

  static getStubConfig() {
    return {
      title: "Rehoboam",
      entity: "",
    };
  }

  render() {
    if (!this.shadowRoot) return;

    this.shadowRoot.innerHTML = `
      <style>
        ha-card {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 16px;
          position: relative;
          overflow: hidden;
        }
        .header {
          width: 100%;
          font-size: 1.2rem;
          font-weight: 500;
          margin-bottom: 12px;
          color: var(--primary-text-color);
        }
        .content {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 100%;
          min-height: 120px;
          color: var(--secondary-text-color);
        }
      </style>
      <ha-card>
        ${this._config.title ? `<div class="header">${this._config.title}</div>` : ""}
        <div class="content">
          <span>Rehoboam Card Placeholder</span>
        </div>
      </ha-card>
    `;
  }

  update() {
    // React to hass updates if an entity is specified
    if (!this._config || !this._hass) return;
  }
}

class LovelaceRehoboamCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = null;
  }

  setConfig(config) {
    this._config = config || {};
    this.render();
  }

  set hass(hass) {
    this._hass = hass;
  }

  render() {
    if (!this.shadowRoot) return;

    this.shadowRoot.innerHTML = `
      <style>
        .card-config {
          display: flex;
          flex-direction: column;
          gap: 12px;
          padding: 8px 0;
        }
        .form-row {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        label {
          font-size: 0.9rem;
          color: var(--secondary-text-color);
        }
        input {
          padding: 8px;
          border-radius: 4px;
          border: 1px solid var(--divider-color, #ccc);
          background: var(--card-background-color, #fff);
          color: var(--primary-text-color, #000);
        }
      </style>
      <div class="card-config">
        <div class="form-row">
          <label for="title">Title</label>
          <input id="title" type="text" value="${this._config.title || ""}">
        </div>
        <div class="form-row">
          <label for="entity">Entity (optional)</label>
          <input id="entity" type="text" value="${this._config.entity || ""}">
        </div>
      </div>
    `;

    const titleInput = this.shadowRoot.querySelector("#title");
    if (titleInput) {
      titleInput.addEventListener("change", (e) => this._valueChanged("title", e.target.value));
    }
    const entityInput = this.shadowRoot.querySelector("#entity");
    if (entityInput) {
      entityInput.addEventListener("change", (e) => this._valueChanged("entity", e.target.value));
    }
  }

  _valueChanged(key, value) {
    if (!this._config) return;
    const newConfig = { ...this._config, [key]: value };
    const event = new CustomEvent("config-changed", {
      detail: { config: newConfig },
      bubbles: true,
      composed: true,
    });
    this.dispatchEvent(event);
  }
}

if (!customElements.get("lovelace-rehoboam-editor")) {
  customElements.define("lovelace-rehoboam-editor", LovelaceRehoboamCardEditor);
}

if (!customElements.get("lovelace-rehoboam")) {
  customElements.define("lovelace-rehoboam", LovelaceRehoboamCard);
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: "lovelace-rehoboam",
  name: "Rehoboam Card",
  description: "A custom Home Assistant Lovelace card visualizing the Rehoboam interface.",
  preview: true,
  documentationURL: "https://github.com/florian/lovelace-rehoboam",
});
