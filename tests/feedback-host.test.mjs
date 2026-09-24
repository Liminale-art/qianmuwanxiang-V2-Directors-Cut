import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { mountFeedback } from '../qianmu-feedback-view.js';
import { feedbackFixture, settleFeedback } from './helpers/feedback-fixture.mjs';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
function section(name) {
    const start = source.indexOf(`function ${name}(`), next = source.indexOf('\nfunction ', start + 1);
    assert.ok(start >= 0); return source.slice(start, next < 0 ? undefined : next);
}
function setup({ loader = async () => ({ mountFeedback }), open = false } = {}) {
    const f = feedbackFixture(), root = f.create('div'), card = f.create('details');
    root.className = 'open'; card.className = 'sd-feedback-card'; card.open = open; f.host.className = 'sd-feedback-host';
    card.append(f.host); root.append(card); let loads = 0;
    const scope = {};
    const c = vm.createContext({ settings: scope, extensionSettings: { story_director_liminale: scope }, MODULE_NAME: 'story_director_liminale', feedbackOpenScope: null, initialized: true, isRuntimeOwner: () => true,
        VERSION: '1.59.365', ctx: () => ({ version: '1.12.0', extensionSettings: c.extensionSettings }), optionalServiceState: { status: 'ready', version: '1.2.3', message: 'PRIVATE', services: ['PRIVATE'] },
        featureRuntime: { load: async key => { assert.equal(key, 'feedback'); loads++; return loader(); } }, applyQianmuIcons() {}, ttsDownloadBlob: f.download });
    vm.runInContext(section('bindFeedbackEvents'), c); c.bindFeedbackEvents(root);
    return { ...f, root, card, c, get loads() { return loads; }, async open() { card.open = true; await card.emit('toggle'); }, async close() { card.open = false; await card.emit('toggle'); } };
}
test('actual API renderer puts feedback last and keeps it collapsed until explicitly opened', () => {
    const settings = {}, c = vm.createContext({ settings, feedbackOpenScope: null, uniqueClean: () => [], getFloatSize: () => 48,
        htmlEscape: value => String(value ?? ''), LOG_LIMIT: 20, FLOAT_SIZE_MIN: 32, FLOAT_SIZE_MAX: 80,
        notesFeatureEnabled: () => true, renderQuickWheelSettings: () => '', renderStorageManagementCard: () => '<section>storage-marker</section>' });
    vm.runInContext(section('renderPlugTab'), c);
    const html = c.renderPlugTab(); assert.ok(html.indexOf('sd-feedback-card') > html.indexOf('storage-marker'));
    assert.match(html, /sd-feedback-card" ><summary>问题反馈/); assert.match(html, /<\/details>\s*$/);
    c.feedbackOpenScope = settings; assert.match(c.renderPlugTab(), /sd-feedback-card" open>/);
});
test('actual host only imports after opening and connects real controls with picked environment primitives', async () => {
    const f = setup(); assert.equal(f.loads, 0); await f.open(); assert.equal(f.loads, 1);
    f.get('问题描述').value = 'host问题'; await f.get('问题描述').emit('input');
    await f.button('保存报告').emit('click'); const text = await f.downloaded[0].blob.text();
    assert.match(text, /ST 版本：1.12.0/); assert.doesNotMatch(text, /PRIVATE/);
    await f.close(); assert.equal(f.host.children.length, 0); await f.open(); assert.equal(f.get('问题描述').value, 'host问题');
    f.root._sdFeedbackCleanup(true);
});
test('closing or replacing a host while the chunk loads suppresses a stale mount', async () => {
    let resolve; const f = setup({ loader: () => new Promise(done => { resolve = done; }) });
    const pending = f.open(); await settleFeedback(); f.root._sdFeedbackCleanup(); f.host.isConnected = false;
    resolve({ mountFeedback() { throw Error('stale mount'); } }); await pending;
    assert.equal(f.host.children.length, 0); assert.equal(f.root._sdFeedbackCleanup, null);
});
test('switching settings identity during lazy load prevents old-account data from showing', async () => {
    let resolve, mounts = 0; const f = setup({ loader: () => new Promise(done => { resolve = done; }) });
    const pending = f.open(); await settleFeedback(); f.c.settings = {};
    resolve({ mountFeedback() { mounts++; } }); await pending;
    assert.equal(mounts, 0); f.root._sdFeedbackCleanup();
});
test('account/runtime invalidation prevents already mounted controls from exporting', async () => {
    const f = setup(); await f.open(); f.get('问题描述').value = 'scope'; await f.get('问题描述').emit('input');
    f.c.initialized = false; await f.button('保存报告').emit('click'); await f.button('复制报告').emit('click');
    assert.equal(f.downloaded.length + f.copied.length, 0); f.root._sdFeedbackCleanup(true);
});
test('ST settings replacement blocks stale exports before the Qianmu rerender event runs', async () => {
    const f = setup(); await f.open(); f.get('问题描述').value = '旧范围'; await f.get('问题描述').emit('input');
    const oldScope = f.c.settings; f.c.extensionSettings = { story_director_liminale: {} };
    assert.equal(f.c.settings, oldScope); await f.button('复制报告').emit('click'); await f.button('保存报告').emit('click');
    assert.equal(f.copied.length + f.downloaded.length, 0); f.root._sdFeedbackCleanup(true);
});
test('failed lazy load is retryable and does not expose exception bodies', async () => {
    let tries = 0; const f = setup({ loader: async () => { if (!tries++) throw Error('PRIVATE local path'); return { mountFeedback }; } });
    await f.open(); assert.match(f.host.textContent, /收起后重新展开/); assert.doesNotMatch(f.host.textContent, /PRIVATE/);
    await f.close(); await f.open(); assert.ok(f.get('问题描述')); f.root._sdFeedbackCleanup(true);
});
test('a preserved open card remounts on normal host rerender and keeps same-scope draft', async () => {
    const f = setup({ open: true }); await settleFeedback(); f.get('问题描述').value = 'rerender'; await f.get('问题描述').emit('input');
    f.root._sdFeedbackCleanup(); f.c.bindFeedbackEvents(f.root); await settleFeedback();
    assert.equal(f.get('问题描述').value, 'rerender'); f.root._sdFeedbackCleanup(true);
});
test('entry binds and cleans the feedback controller through actual panel lifecycle', () => {
    assert.match(source, /if \(activeTab === 'plug'\) \{\s*bindFeedbackEvents\(root\);/);
    for (const name of ['renderModal', 'closeModal', 'cleanupRuntime']) assert.match(section(name), /_sdFeedbackCleanup/);
    assert.doesNotMatch(section('bindFeedbackEvents'), /fetch\(|logHistory|apiKey|chat\b|requestHeaders|refreshOptionalService/);
});
test('release includes both feedback modules and CSS is scoped to the actual main panel', async () => {
    const release = JSON.parse(await readFile(new URL('../release-files.json', import.meta.url), 'utf8'));
    for (const file of ['qianmu-feedback-report.js', 'qianmu-feedback-view.js']) assert.ok(release.files.includes(file));
    const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    assert.match(css, /#story-director-modal \.sd-feedback-preview[^}]*white-space:pre-wrap/);
    assert.match(css, /#story-director-modal \.sd-feedback-actions[^}]*flex-wrap:wrap/);
});
