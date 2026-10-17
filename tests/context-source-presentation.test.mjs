import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as utils from '../qianmu-storyboard-utils.js';
import { groupPresetNames } from '../qianmu-st-context-sources.js';
import { renderCoreadIdentityView } from '../qianmu-reader-identity-view.js';
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

test('context identities reuse archive tag markup, escape names, and follow the current host without writes', () => {
  const names = { char: '秦铎"<&', user: 'User<script>' };
  const settings = { contextOptions: {} }, before = JSON.stringify(settings);
  const sandbox = vm.createContext({ ...utils, settings, contextScanCache: {},
    getCharacterName: () => names.char, getPersonaName: () => names.user,
    maybeAutoScanContext() {}, renderTagRules: () => '', renderPresetSourcePanel: () => '', renderWorldBookSourcePanel: () => '',
  });
  vm.runInContext(storyboardFunctionSource('renderContextTab'), sandbox);
  const tagPattern = /<span class="sd-reader-setup-tag">[\s\S]*?<\/span>/g;
  for (const charName of [names.char, '切换后的角色']) {
    names.char = charName;
    const html = sandbox.renderContextTab();
    const actual = html.match(tagPattern);
    const expected = [['CHAR', names.char], ['USER', names.user]].map(([role, name]) =>
      renderCoreadIdentityView({ role, name, avatar: '', icon: '' }, utils.htmlEscape).match(tagPattern)[0]);
    assert.deepEqual(actual, expected);
    assert.doesNotMatch(html, /当前角色|当前用户|sd-fixed-ref-label|sd-reader-identity-avatar|data-coread-identity|<script>/);
  }
  assert.equal(JSON.stringify(settings), before);
});

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

test('preset guidance replaces only its read status in the section heading without changing selections', () => {
  for (const selected of [[], ['文风预设']]) {
    const sandbox = fixture({ current: '文风预设', names: ['文风预设'], selected });
    const panel = sandbox.renderPresetSourcePanel();
    assert.doesNotMatch(panel, /sd-preset-guidance|千幕负责栏目与输出格式/);
    assert.equal((panel.match(/<input /g) || []).length, 2);
    assert.equal((panel.match(/ checked/g) || []).length, 1);
    assert.deepEqual(sandbox.getSelectedPresetNames(), selected);
    Object.assign(sandbox, { settings: { contextOptions: {} }, maybeAutoScanContext() {}, getCharacterName: () => '角色', getPersonaName: () => '用户', renderTagRules: () => '', renderWorldBookSourcePanel: () => '' });
    vm.runInContext(storyboardFunctionSource('renderContextTab'), sandbox);
    for (const scanned of [false, true]) {
      sandbox.contextScanCache.presetScannedAt = sandbox.contextScanCache.worldScannedAt = scanned ? 1 : 0;
      const html = sandbox.renderContextTab();
      assert.equal((html.match(/sd-preset-guidance/g) || []).length, 1);
      assert.match(html, /data-acc="acc-presets" open>\s*<summary><b>预设<\/b><span class="sd-summary-note sd-preset-guidance">按需勾选，乱选只会左右脑互搏哦\(ˉ▽ˉ；\)<\/span><\/summary>/);
      const preset = html.slice(html.indexOf('data-acc="acc-presets"'), html.indexOf('data-acc="acc-worlds"'));
      assert.doesNotMatch(preset, /已读取|待读取|冲突扫描|自动分类/);
      assert.match(html, new RegExp(`<b>世界书</b><span>${scanned ? '已读取' : '待读取'}</span>`));
    }
  }
  assert.match(fixture().renderPresetSourcePanel(), /未读取到预设。/);
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
