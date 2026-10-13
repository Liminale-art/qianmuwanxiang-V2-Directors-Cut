import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as utils from '../qianmu-storyboard-utils.js';
import { groupPresetNames } from '../qianmu-st-context-sources.js';
import { storyboardFunctionSource } from './helpers/storyboard-form-fixture.mjs';

function fixture({ current = '', names = [], selected = [] } = {}) {
  const sandbox = vm.createContext({
    ...utils, groupPresetNames, cleanContextText: value => value,
    contextScanCache: { currentPresetName: current, presetNames: names, worldBookNames: ['世界书'], boundWorldBookNames: [], worldBooks: {} },
    getCurrentPresetName: () => current, listPresetNames: () => names,
    getSelectedPresetNames: () => selected, renderSelectedPresetEntries: () => '',
    getSelectedWorldBookNames: () => [], detectBoundWorldBookNames: () => [],
    lastWorldView: '', isWorldBookGlobal: () => false,
    isPresetItemSelected: () => true, isWorldItemSelected: () => false,
  });
  vm.runInContext(['badge', 'getContextItemId', 'renderPresetSourcePanel', 'renderWorldBookSourcePanel', 'renderContextEntry'].map(storyboardFunctionSource).join('\n'), sandbox);
  return sandbox;
}

test('current preset with an additional numeric release suffix joins its existing series', () => {
  const current = '【照见】Claude-Versatile-5.1.3 5.5';
  const older = '【照见】Claude-Versatile-4.8 (试吃1)';
  const newer = '【照见】Claude-Versatile-5.2.0';
  const groups = groupPresetNames([current, older, newer]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].base, '【照见】Claude-Versatile');
  assert.deepEqual(groups[0].items.map(item => item.name), [newer, current, older]);
});

test('version recognition retains genuine numeric series names before intervening words', () => {
  const groups = groupPresetNames(['Claude-3.5-Sonnet-v2.0 5.5', 'Claude-3.5-Sonnet-v1.0', 'Claude-4.0-Sonnet-v1.0']);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].base, 'Claude-3.5-Sonnet');
  assert.equal(groups[0].items.length, 2);
  assert.deepEqual(groups[1], { grouped: false, name: 'Claude-4.0-Sonnet-v1.0' });
});

test('the current preset has one selectable row within its group and numeric-only count', () => {
  const current = '【照见】Claude-Versatile-5.1.3 5.5';
  const sandbox = fixture({ current, names: [current, '【照见】Claude-Versatile-4.8 (试吃1)'], selected: [current] });
  const html = sandbox.renderPresetSourcePanel();
  assert.equal((html.match(/data-name="【照见】Claude-Versatile-5\.1\.3 5\.5"/g) || []).length, 1);
  assert.match(html, /data-preset-group="【照见】Claude-Versatile" open/);
  assert.match(html, /<small>2<\/small>/);
  assert.doesNotMatch(html, /个版本/);
  assert.match(html, /sd-preset-version-items[\s\S]*data-name="【照见】Claude-Versatile-5\.1\.3 5\.5" checked[\s\S]*当前使用[\s\S]*<\/div><\/details>/);
});

test('preset and world entries remain selectable without expandable content previews', () => {
  const sandbox = fixture();
  for (const kind of ['preset', 'world']) {
    const html = sandbox.renderContextEntry(kind, '来源', { uid: 7, identifier: 'entry-7', name: '选择此条目', content: 'PRIVATE_PREVIEW_CONTENT' }, 0);
    assert.match(html, /sd-context-entry-label/);
    assert.match(html, new RegExp(`data-kind="${kind}" data-group="来源"`));
    assert.match(html, /选择此条目/);
    assert.doesNotMatch(html, /<details|<summary|<pre|data-acc=|PRIVATE_PREVIEW_CONTENT/);
    assert.equal(html.includes('checked'), kind === 'preset');
  }
});

test('world directory keeps independent entry navigation and global-reference controls', () => {
  const html = fixture().renderWorldBookSourcePanel();
  assert.match(html, /sd-toggle-worldbook/);
  assert.match(html, /class="sd-world-name" data-name="世界书"/);
  assert.match(html, /sd-world-global/);
});
