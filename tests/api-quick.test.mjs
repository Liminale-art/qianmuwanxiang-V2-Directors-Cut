import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sourceOptions, secretKeyFor, buildProfile, quickList, rowHtml, copyProfile, copyName, snapshotItems, applySnapshotChoice } from '../qianmu-api-quick.js';

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

test('the fold-out list puts the active connection first, then pinned, then recent use, then the rest by name', () => {
  const profiles = [{ id: 'a', name: '丙' }, { id: 'b', name: '乙' }, { id: 'c', name: '甲' }, { id: 'd', name: 'A' }, { id: 'e', name: '戊' }];
  const state = { pinned: ['c', 'gone', 'e'], recent: { a: 5, b: 9 } };
  const row = entry => [entry.item.id, entry.pinned, entry.active];
  assert.deepEqual(quickList(profiles, state).map(row), [['c', true, false], ['e', true, false], ['b', false, false], ['a', false, false], ['d', false, false]]);
  assert.deepEqual(quickList(profiles, state, 'a').map(row), [['a', false, true], ['c', true, false], ['e', true, false], ['b', false, false], ['d', false, false]], 'lifted out of recent, not repeated');
  assert.deepEqual(quickList(profiles, state, 'e').map(row), [['e', true, true], ['c', true, false], ['b', false, false], ['a', false, false], ['d', false, false]], 'a pinned active row keeps its pin and leaves the pinned block');
  assert.deepEqual(quickList(profiles, state, 'gone').map(row)[0], ['c', true, false], 'an unknown active id adds nothing');
});

test('copying deep-clones the raw ST profile under a new id and applies the form; the copy name is unique', () => {
  const original = { id: 'o', mode: 'cc', name: '甲', api: 'custom', 'api-url': 'https://x.test/v1', model: 'm1', preset: '长文', proxy: 'p1', exclude: ['stop-strings'], 'regex-preset': 'rx', 'secret-id': 'sec-1' };
  const copy = copyProfile(original, { name: '甲 副本', source: 'custom', url: 'https://x.test/v1', model: 'm2', preset: '长文', secretId: 'sec-1' }, () => 'n1');
  assert.deepEqual(copy, { ...original, id: 'n1', name: '甲 副本', model: 'm2' });
  copy.exclude.push('x');
  assert.deepEqual(original.exclude, ['stop-strings'], 'nested values are not shared with the original');
  assert.equal(original.id, 'o'); assert.equal(original.model, 'm1');
  assert.equal(copyName('甲', [{ name: '甲' }]), '甲 副本');
  assert.equal(copyName('甲', [{ name: '甲' }, { name: '甲 副本' }, { name: '甲 副本 2' }]), '甲 副本 3');
});

test('save-as-plan: unchecked binding items are dropped and excluded like ST’s own popup; the key is always kept', () => {
  assert.deepEqual(snapshotItems('cc').map(item => item.label), ['预设', '代理', '停止字符串', '回复开头', '推理模板', '提示词后处理', '正则预设']);
  assert.deepEqual(snapshotItems('tc').map(item => item.label), ['预设', '系统提示词', '指令模板', '上下文模板', '分词器', '停止字符串', '回复开头', '推理模板', '正则预设']);
  assert.deepEqual(snapshotItems('tc').find(item => item.id === 'instruct').keys, ['instruct', 'instruct-state']);
  const made = () => ({ id: 'p', mode: 'cc', name: '方案', exclude: [], api: 'custom', 'api-url': 'u', model: 'm', preset: '长文', proxy: 'px', 'stop-strings': '[]', 'start-reply-with': '', 'reasoning-template': 'r', 'prompt-post-processing': 'merge', 'regex-preset': 'rx' });
  const none = applySnapshotChoice(made(), [], 'sec-active');
  assert.deepEqual(Object.keys(none).sort(), ['api', 'api-url', 'exclude', 'id', 'mode', 'model', 'name', 'secret-id'].sort());
  assert.deepEqual(none.exclude, ['preset', 'proxy', 'stop-strings', 'start-reply-with', 'reasoning-template', 'prompt-post-processing', 'regex-preset']);
  assert.equal(none['secret-id'], 'sec-active', 'a missing key is filled from the active key of that source');
  const some = applySnapshotChoice({ ...made(), 'secret-id': 'sec-own', exclude: ['secret-id'] }, ['preset', 'regex-preset'], 'sec-active');
  assert.deepEqual([some.preset, some['regex-preset'], some.proxy], ['长文', 'rx', undefined]);
  assert.equal(some['secret-id'], 'sec-own', 'the key ST read is kept'); assert.ok(!some.exclude.includes('secret-id'));
  assert.equal(applySnapshotChoice(made(), [], '')['secret-id'], undefined, 'no active key, nothing invented');
  const tc = applySnapshotChoice({ id: 't', mode: 'tc', exclude: [], api: 'ooba', instruct: 'Alpaca', 'instruct-state': 'true', context: 'Default', sysprompt: 'S', 'sysprompt-state': 'true' }, ['instruct']);
  assert.deepEqual([tc.instruct, tc['instruct-state'], tc.context, tc.sysprompt, tc['sysprompt-state']], ['Alpaca', 'true', undefined, undefined, undefined]);
  assert.ok(tc.exclude.includes('sysprompt-state') && tc.exclude.includes('context') && !tc.exclude.includes('instruct'));
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
  assert.deepEqual(tools(rowHtml(item, { where: 'panel', open: true })), ['qm-apiq-pin', 'qm-apiq-edit', 'qm-apiq-copy', 'qm-apiq-del', 'qm-apiq-more']);
  assert.match(rowHtml(item, { where: 'panel' }), /qm-apiq-tag">自定义[\s\S]*预设 长文/);
});

test('the quick switch no longer follows the Qianmu theme: no portal theme mounting, colours from ST theme variables', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const quick = await readFile(new URL('../qianmu-api-quick.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../qianmu-api-quick.css', import.meta.url), 'utf8');
  const call = source.match(/const apiQuick=createApiQuick\(\{[^\n]*\}\);/)?.[0] || '';
  assert.ok(call); assert.doesNotMatch(call, /mountPortal/);
  assert.doesNotMatch(quick, /mountPortal|paintEntries|--sd-/);
  assert.doesNotMatch(css, /--sd-|--qm-apiq-/);
  assert.match(css, /--SmartThemeBodyColor/); assert.match(css, /--SmartThemeBlurTintColor/); assert.match(css, /--SmartThemeBorderColor/);
  assert.match(quick, />新建连接<\/button><button[^>]*>新建分组<\/button><button[^>]*>将当前ST设置存为方案<\/button>/);
  assert.doesNotMatch(quick, />＋|当前连接<\/h4>|<datalist/);
});
