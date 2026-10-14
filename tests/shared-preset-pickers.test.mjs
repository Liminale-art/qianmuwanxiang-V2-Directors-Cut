import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as utils from '../qianmu-storyboard-utils.js';
import { groupPresetNames } from '../qianmu-st-context-sources.js';
import { installPresetPickerFixture, presetPickerSource } from './helpers/preset-picker-fixture.mjs';

function fixture() {
  const sandbox = vm.createContext({ ...utils, groupPresetNames });
  installPresetPickerFixture(sandbox);
  vm.runInContext(presetPickerSource, sandbox);
  return sandbox;
}

test('theater and companion use the materials series groups with current preset inside and digit-only counts', () => {
  const s = fixture();
  for (const html of [s.renderPresetSourcePanel(), s.renderTheaterPresetPicker(s.current), s.renderCompanionSetupBody()]) {
    assert.equal((html.match(/data-preset-group=/g) || []).length, 2);
    assert.equal((html.match(/<small>2<\/small>/g) || []).length, 2);
    assert.doesNotMatch(html, /个版本/);
    assert.match(html, /data-preset-group="【照见】Claude-Versatile"[^>]*open[^]*?sd-preset-version-items[^]*?5\.1\.3 5\.5/);
  }
});

test('theater retains concrete-name single selection and explicit no-preset option', () => {
  const s = fixture();
  const html = s.renderTheaterPresetPicker(s.current);
  assert.equal((html.match(/type="radio"/g) || []).length, 6);
  assert.equal((html.match(/ checked/g) || []).length, 1);
  assert.match(html, /value=""[^>]*><span class="sd-muted">不使用预设/);
  assert.match(s.renderTheaterPresetPicker(''), /value="" checked/);
  assert.doesNotMatch(html, /type="checkbox"|<select/);
});

test('theater real change binding saves concrete selection and initializes entries, including clearing selection', () => {
  const s = fixture();
  const listeners = [];
  s.bindTheaterPresetPicker({ querySelectorAll: () => Array.from({ length: 6 }, () => ({ addEventListener: (_event, handler) => listeners.push(handler) })) });
  listeners[2]({ target: { value: s.older, checked: true } });
  assert.equal(s.theater.presetName, s.older);
  assert.equal(s.calls.saves, 1);
  assert.equal(s.calls.renders, 1);
  assert.ok(s.theater.presetItems[s.older]);
  listeners[0]({ target: { value: '', checked: true } });
  assert.equal(s.theater.presetName, '');
  assert.equal(s.calls.saves, 2);
  listeners[2]({ target: { value: s.older, checked: false } });
  assert.equal(s.calls.saves, 2);
});

test('companion remains independently multi-selectable and no presets is represented by no checked boxes', () => {
  const s = fixture();
  s.coreadToggleCompanionPreset(s.older, true);
  assert.deepEqual(s.cp.presets, [s.current, s.older]);
  const html = s.renderCompanionSetupBody();
  assert.equal((html.match(/class="sd-reader-cps-toggle"[^>]* checked/g) || []).length, 2);
  assert.equal(s.theater.presetName, s.current);
  assert.doesNotMatch(html, /type="radio"/);
  s.coreadToggleCompanionPreset(s.current, false); s.coreadToggleCompanionPreset(s.older, false);
  assert.equal((s.renderCompanionSetupBody().match(/class="sd-reader-cps-toggle"[^>]* checked/g) || []).length, 0);
});

test('companion refresh picks up host names and rehydrates visible independent entries without changing selection', async () => {
  const s = fixture();
  s.cp.presets = [s.older]; s.companionPresetView = s.older;
  s.renderCompanionSetupBody();
  s.fixtureNames.push('【照见】Claude-Versatile-5.2.0');
  const body = { innerHTML: '', querySelector: () => null };
  await s.coreadSetupScanPresets({ querySelector: () => body });
  assert.match(body.innerHTML, /Claude-Versatile-5\.2\.0/);
  assert.match(body.innerHTML, /<small>3<\/small>/);
  assert.match(body.innerHTML, /保留的条目/);
  assert.deepEqual(s.cp.presets, [s.older]);
  assert.equal(s.calls.reads, 2);
});

test('special characters are escaped in group, radio, and companion names', () => {
  const s = fixture();
  s.contextScanCache.presetNames = ['恶意<img src=x>-v1.0', '恶意<img src=x>-v2.0'];
  for (const html of [s.renderTheaterPresetPicker(''), s.renderCompanionSetupBody()]) {
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img/);
  }
});
