#!/usr/bin/env node
// Sets CARD_VERSION in lovelace-rehoboam.js to the next calendar version (YEAR.MONTH.N):
// N + 1 within the same month, else YEAR.MONTH.0 for the current month.
// Usage: node scripts/next-version.mjs [--dry-run]
import { readFileSync, writeFileSync } from 'node:fs';

const file = new URL('../lovelace-rehoboam.js', import.meta.url);
const source = readFileSync(file, 'utf8');
const match = source.match(/^const CARD_VERSION = '(\d{4})\.(\d{1,2})\.(\d+)';$/m);
if (!match) {
  console.error('CARD_VERSION in lovelace-rehoboam.js is not a calendar version (YEAR.MONTH.N)');
  process.exit(1);
}
const now = new Date();
const year = now.getFullYear();
const month = now.getMonth() + 1;
const sameMonth = Number(match[1]) === year && Number(match[2]) === month;
const next = `${year}.${month}.${sameMonth ? Number(match[3]) + 1 : 0}`;
const current = `${match[1]}.${match[2]}.${match[3]}`;

if (process.argv.includes('--dry-run')) {
  console.log(`${current} -> ${next}`);
} else {
  writeFileSync(file, source.replace(match[0], `const CARD_VERSION = '${next}';`));
  console.log(`CARD_VERSION ${current} -> ${next}`);
}
