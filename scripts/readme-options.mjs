#!/usr/bin/env node
// Writes the option tables in README.md from the settings list in lovelace-rehoboam.js, so the
// README, the visual editor and the playground show the same names, ranges and descriptions.
// Usage: node scripts/readme-options.mjs [--check]   (--check exits 1 if README.md is out of date)
import { readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const readmeUrl = new URL('README.md', root);

// Load the card with just enough browser stubs to read the settings list
const registry = new Map();
const context = vm.createContext({
  console: { info() {}, log() {}, warn() {}, error() {} },
  HTMLElement: class {},
  customElements: { define: (name, cls) => registry.set(name, cls), get: name => registry.get(name), whenDefined: () => new Promise(() => {}) },
  window: {},
  document: {},
  navigator: {}
});
vm.runInContext(readFileSync(new URL('lovelace-rehoboam.js', root), 'utf8'), context);
const { card, entity } = registry.get('lovelace-rehoboam-editor').settings;

const TYPES = { number: 'number', plain: 'number', threshold: 'number', select: 'string', text: 'string', entity: 'string', bool: 'boolean', action: 'action', map: 'object' };
const code = v => `\`${v}\``;
const cell = text => String(text).replace(/\|/g, '\\|');

function row(st) {
  const type = st.yamlType || TYPES[st.type];
  let def = '—';
  if (st.required) def = '**Required**';
  // Action names and YAML keywords as code, descriptions as plain text
  else if (st.defaultText) def = st.type === 'action' || st.yamlType ? code(st.defaultText) : st.defaultText;
  else if (st.default !== undefined) def = code(st.default);
  let range = '';
  if (st.type === 'number') range = `${code(st.min)} – ${code(st.max)}`;
  else if (st.type === 'select') range = st.options.map(([v]) => code(v)).join(', ');
  else if (st.type === 'threshold') range = 'baseline – critical';
  return `| ${code(st.key)} | ${type} | ${def} | ${range} | ${cell(st.tip)} |`;
}

const HEAD = '| Option | Type | Default | Range | Description |\n| ------ | ---- | ------- | ----- | ----------- |';
const tables = {
  'card-options': [
    HEAD,
    `| ${code('type')} | string | **Required** | | ${code('custom:lovelace-rehoboam')} |`,
    ...card.map(row),
    `| ${code('entities')} | list | ${code('[]')} | | Entity IDs or entity option objects, see [Entity Options](#entity-options). |`
  ].join('\n'),
  'entity-options': [HEAD, ...entity.map(row)].join('\n')
};

const readme = readFileSync(readmeUrl, 'utf8');
let next = readme;
for (const [name, table] of Object.entries(tables)) {
  const re = new RegExp(`(<!-- BEGIN ${name} -->)[\\s\\S]*?(<!-- END ${name} -->)`);
  if (!re.test(next)) {
    console.error(`README.md has no <!-- BEGIN ${name} --> / <!-- END ${name} --> markers`);
    process.exit(2);
  }
  next = next.replace(re, (all, begin, end) => `${begin}\n${table}\n${end}`);
}

if (process.argv.includes('--check')) {
  if (next !== readme) {
    console.error('README.md option tables are out of date. Run: node scripts/readme-options.mjs');
    process.exit(1);
  }
  console.log('README.md option tables are up to date.');
} else if (next !== readme) {
  writeFileSync(readmeUrl, next);
  console.log('README.md option tables updated.');
} else {
  console.log('README.md option tables are up to date.');
}
