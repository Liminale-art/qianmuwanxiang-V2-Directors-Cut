import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sourceOptions, secretKeyFor, buildProfile, quickList, rowHtml } from '../qianmu-api-quick.js';

const KEYS = { CUSTOM: 'api_key_custom', OPENAI: 'api_key_openai', MAKERSUITE: 'api_key_makersuite', CLAUDE: 'api_key_claude' };

test('sources come from ST’s own chat-completion dropdown, with a fallback list when it is missing', () => {
  const doc = { getElementById: id => (id === 'chat_completion_source' ? { options: [{ value: 'custom', textContent: 'Custom' }, { value: 'claude', textContent: ' Claude ' }, { value: '', textContent: '-' }] } : null) };
  assert.deepEqual(sourceOptions(doc), [{ value: 'custom', label: 'Custom' }, { value: 'claude', label: 'Claude' }]);
  assert.ok(sourceOptions({ getElementById: () => null }).some(item => item.value === 'custom'));
});

test('each source maps to ST’s key slot; sources without one get no key field', () => {
  assert.equal(secretKeyFor('custom', KEYS), 'api_key_custom');
  assert.equal(secretKeyFor('google', KEYS), 'api_key_makersuite');
  assert.equal(secretKeyFor('vertexai', KEYS), '');
});

test('the form becomes a native ST connection profile holding only what was filled in, never the key itself', () => {
  const made = buildProfile(null, { name: ' 甲 ', source: 'custom', url: 'https://x.test/v1', model: 'm1', preset: '', secretId: 'sec-1', key: 'sk-should-not-appear' }, () => 'id-1');
  assert.deepEqual(made, { id: 'id-1', mode: 'cc', exclude: [], name: '甲', api: 'custom', 'api-url': 'https://x.test/v1', model: 'm1', 'secret-id': 'sec-1' });
  assert.doesNotMatch(JSON.stringify(made), /sk-should-not-appear/);
  const edited = buildProfile({ ...made, proxy: 'p', 'stop-strings': '[]' }, { name: '甲', source: 'claude', url: 'https://x.test/v1', model: '', preset: '长文', secretId: '' });
  assert.equal(edited.id, 'id-1'); assert.equal(edited.api, 'claude');
  assert.equal(edited['api-url'], undefined, 'only the custom source keeps an address');
  assert.equal(edited.model, undefined); assert.equal(edited['secret-id'], undefined);
  assert.equal(edited.preset, '长文'); assert.equal(edited.proxy, 'p', 'fields the form does not edit are kept');
});

test('the fold-out list puts pinned first, then recent use, then the rest by name', () => {
  const profiles = [{ id: 'a', name: '丙' }, { id: 'b', name: '乙' }, { id: 'c', name: '甲' }, { id: 'd', name: 'A' }];
  const list = quickList(profiles, { pinned: ['c', 'gone'], recent: { a: 5, b: 9 } });
  assert.deepEqual(list.map(entry => [entry.item.id, entry.pinned]), [['c', true], ['b', false], ['a', false], ['d', false]]);
});

test('the entry sits next to ST’s test-message button; the toolkit no longer has an API tab', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const quick = await readFile(new URL('../qianmu-api-quick.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /data-floor-tab="api"/);
  assert.match(source, /apiQuick\.attach\(\)/);
  assert.match(source, /CONNECTION_PROFILE_LOADED \|\| 'connection_profile_loaded', apiQuick\.events\.profileLoaded/);
  assert.match(quick, /getElementById\('test_api_button'\)/);
  assert.match(quick, /label.textContent = 'API快切'/);
  const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
  assert.match(css, /\.sd-floor-tabs \{ display: grid; grid-template-columns: repeat\(5,/);
});

test('rows: the fold-out list shows only the model with pin / edit / delete; the panel folds edit and delete behind ⋯', () => {
  const item = { id: 'a', name: '甲<x>', api: 'custom', model: 'm-1', preset: '长文' };
  const tools = html => [...html.matchAll(/class="qm-apiq-icon ([\w-]+)/g)].map(match => match[1]);
  const drop = rowHtml(item, { where: 'drop', pinned: true });
  assert.match(drop, /<span class="qm-apiq-model">m-1<\/span>/); assert.doesNotMatch(drop, /qm-apiq-tag/);
  assert.deepEqual(tools(drop), ['qm-apiq-pin', 'qm-apiq-edit', 'qm-apiq-del']);
  assert.match(drop, /甲&lt;x&gt;/);
  assert.deepEqual(tools(rowHtml(item, { where: 'panel' })), ['qm-apiq-pin', 'qm-apiq-more']);
  assert.deepEqual(tools(rowHtml(item, { where: 'panel', open: true })), ['qm-apiq-pin', 'qm-apiq-edit', 'qm-apiq-del', 'qm-apiq-more']);
  assert.match(rowHtml(item, { where: 'panel' }), /qm-apiq-tag">自定义[\s\S]*预设 长文/);
  assert.deepEqual(tools(rowHtml(item, { where: 'current', active: true })), []);
});
