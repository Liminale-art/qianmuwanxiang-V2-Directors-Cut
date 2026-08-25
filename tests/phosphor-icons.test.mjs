import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  QIANMU_CURRENT_FA_ICON_COUNT,
  QIANMU_FA_ICON_MAP,
  QIANMU_PHOSPHOR_VERSION,
  QIANMU_SEMANTIC_ICONS,
  qianmuClassMutationAffectsBoundary,
  resolveQianmuIcon,
} from '../qianmu-icons.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const source = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const iconSource = fs.readFileSync(path.join(root, 'qianmu-icons.js'), 'utf8');
const sprite = fs.readFileSync(path.join(root, 'assets', 'qianmu-phosphor-icons.svg'), 'utf8');
const license = fs.readFileSync(path.join(root, 'assets', 'PHOSPHOR-LICENSE.txt'), 'utf8');
const symbolIds = new Set([...sprite.matchAll(/<symbol id="([^"]+)"/g)].map((match) => match[1]));

function mappedSymbols(value) {
  if (typeof value === 'string') return [value];
  return Object.values(value || {}).filter((item) => typeof item === 'string');
}

assert.equal(QIANMU_PHOSPHOR_VERSION, '2.1.1');
assert.equal(QIANMU_CURRENT_FA_ICON_COUNT, 133);
assert.equal(Object.keys(QIANMU_FA_ICON_MAP).length, 133);
assert.ok(symbolIds.size >= 140, 'sprite should contain the complete Qianmu icon set');

const usedFaIcons = [...new Set([...source.matchAll(/fa-[a-z0-9-]+/g)].map((match) => match[0]))]
  .filter((name) => !['fa-solid', 'fa-regular', 'fa-brands', 'fa-spin'].includes(name) && !/^fa-[a-f]$/.test(name))
  .sort();
assert.deepEqual(usedFaIcons, Object.keys(QIANMU_FA_ICON_MAP).sort(), 'every emitted Qianmu icon must have one mapping');

for (const [name, value] of Object.entries(QIANMU_FA_ICON_MAP)) {
  for (const symbol of mappedSymbols(value)) {
    assert.ok(symbolIds.has(symbol), `${name} points to missing symbol ${symbol}`);
  }
}
for (const [name, symbol] of Object.entries(QIANMU_SEMANTIC_ICONS)) {
  assert.ok(symbolIds.has(symbol), `${name} points to missing semantic symbol ${symbol}`);
}

const selectedSymbols = [
  'qm-user-coread-entry', 'qm-user-character-profile', 'qm-user-floor-tools',
  'qm-user-backstage', 'qm-user-clear', 'qm-user-context', 'qm-user-tasks',
  'qm-user-screening', 'qm-user-world', 'qm-user-world-map', 'qm-user-bookmarks',
  'qm-user-voice-lines', 'qm-user-voice-regenerate-all', 'qm-user-image-regenerate',
  'qm-user-voice-reextract', 'qm-user-focus',
];
selectedSymbols.forEach((symbol) => assert.ok(symbolIds.has(symbol), `missing user-selected symbol ${symbol}`));

const explicitIcons = [
  ...source.matchAll(/data-qm-icon="([^"$]+)"/g),
  ...source.matchAll(/phosphor:\s*'([^']+)'/g),
].map((match) => match[1]);
for (const icon of explicitIcons) {
  const symbol = resolveQianmuIcon(icon);
  assert.ok(symbol, `unresolved explicit icon ${icon}`);
  assert.ok(symbolIds.has(symbol), `explicit icon ${icon} points to missing symbol ${symbol}`);
}

assert.match(source, /sd-preserve-external-icon/);
assert.match(source, /installQianmuIconSystem\(document\)/);
assert.match(source, /uninstallQianmuIconSystem\(\)/);
assert.match(iconSource, /if \(!icon\.classList\.contains\(ICON_CLASS\)\) icon\.classList\.add\(ICON_CLASS\)/);
assert.match(iconSource, /if \(icon\.getAttribute\(ICON_DATA\) !== symbol\) icon\.setAttribute\(ICON_DATA, symbol\)/);
assert.match(iconSource, /!root\.matches\(ICON_HOST_SELECTOR\) && !root\.querySelector\(ICON_HOST_SELECTOR\)/);
assert.doesNotMatch(iconSource, /icon\.closest\('\[class\^="sd-"/);
assert.match(iconSource, /attributeOldValue:\s*true/);
assert.equal(qianmuClassMutationAffectsBoundary('mes selected', 'mes'), false);
assert.equal(qianmuClassMutationAffectsBoundary('sd-quick-docked-origin', ''), true);
assert.equal(qianmuClassMutationAffectsBoundary('', 'sd-preserve-external-icon fa-solid'), true);
assert.doesNotMatch(css, /font-family:\s*['"]Font Awesome/i);
assert.match(css, /data:image\/svg\+xml/);
assert.match(license, /MIT License/);
assert.match(license, /Phosphor Icons/);

console.log(`Phosphor icon contract OK (${symbolIds.size} symbols, ${QIANMU_CURRENT_FA_ICON_COUNT} mapped semantics)`);
