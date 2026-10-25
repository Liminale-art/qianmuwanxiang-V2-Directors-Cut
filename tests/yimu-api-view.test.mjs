import test from 'node:test';
import assert from 'node:assert/strict';
import { textCollectionDom } from './helpers/text-collection-dom.mjs';
import { createApiSettings } from '../yimu/api-settings.mjs';
import { mountApiView } from '../yimu/api-view.mjs';

function fixture({ onLegacyChange } = {}) {
    const dom = textCollectionDom(), create = dom.doc.createElement;
    // Only the reviewed bundled icon renderer has a markup sink; all user data remains text/value.
    dom.doc.createElement = tag => {
        const node = create(tag);
        if (tag === 'span') Object.defineProperty(node, 'innerHTML', { set(value) { assert.match(value, /^<svg xmlns=/); }, configurable: true });
        return node;
    };
    const calls = [], errors = [], legacyChanges = [], ctx = { extensionSettings: {}, async saveSettingsDebounced() {}, getRequestHeaders: () => ({}) };
    let legacy = { profileId: '', model: '' };
    const api = createApiSettings({ getContext: () => ctx, createId: () => 'preset-id', fetchImpl: async (path, options) => {
        calls.push({ path, body: JSON.parse(options.body) }); return Response.json({ data: [{ id: 'first-model' }, { id: 'second-model' }] });
    } });
    const view = mountApiView(dom.parent, { api, document: dom.doc, onError: error => errors.push(error),
        getLegacy: () => legacy, getProfiles: () => [{ id: 'saved-a', name: '现有 ST 连接' }],
        onLegacyChange: async values => { legacyChanges.push(values); if (onLegacyChange) return onLegacyChange(values); legacy = values; } });
    const change = async (label, value, complete = () => true) => {
        const node = dom.get(label); node.value = value; node.emit('change');
        await dom.wait(() => !node.disabled && complete());
    };
    return { ...dom, api, view, calls, errors, legacyChanges, change, ctx };
}

test('API card starts on native ST without network and exposes all three connection modes', async () => {
    const f = fixture(); assert.deepEqual(f.calls, []);
    const mode = f.get('整理连接方式'); assert.equal(mode.value, 'st');
    assert.deepEqual(mode.children.map(item => item.value), ['st', 'profile', 'external']);
    assert.equal(f.visible(f.get('API URL')), false); assert.equal(f.visible(f.get('ST 连接预设')), false);
    assert.match(f.parent.textContent, /整理 API/); f.view.destroy(); assert.equal(f.parent.children.length, 0);
});

test('saved ST profiles are selectable for new users and do not auto-select or modify global ST settings', async () => {
    const f = fixture(); await f.change('整理连接方式', 'profile', () => f.api.read().mode === 'profile');
    assert.equal(f.visible(f.get('ST 连接预设')), true); assert.deepEqual(f.legacyChanges, []);
    await f.change('ST 连接预设', 'saved-a', () => f.legacyChanges.length === 1);
    assert.deepEqual(f.legacyChanges[0], { profileId: 'saved-a', model: '' });
    await f.change('ST 连接模型', 'custom-model', () => f.legacyChanges.length === 2);
    assert.deepEqual(f.legacyChanges[1], { profileId: 'saved-a', model: 'custom-model' });
    assert.equal(f.calls.length, 0); assert.equal(f.ctx.mainApi, undefined);
});

test('external fields, model pull and selection all persist actual controls', async () => {
    const f = fixture(); await f.change('整理连接方式', 'external', () => f.api.read().mode === 'external');
    assert.equal(f.visible(f.get('API URL')), true); assert.equal(f.get('API Key').type, 'password');
    await f.change('API URL', 'http://127.0.0.1:1234/v1', () => !!f.api.read().apiUrl);
    assert.equal(f.get('拉取模型').disabled, false, 'keyless local provider remains usable');
    f.get('拉取模型').click(); await f.wait(() => !f.get('拉取模型').disabled && f.api.read().models.length === 2);
    assert.equal(f.calls[0].path, '/api/backends/chat-completions/status');
    assert.equal(f.api.read().model, '', 'fetching does not select a paid model implicitly');
    await f.change('整理模型', 'second-model', () => f.api.read().model === 'second-model');
    await f.change('整理温度', '0.35', () => f.api.read().temperature === 0.35);
    await f.change('最大输出 Token', '4096', () => f.api.read().maxTokens === 4096);
    await f.change('上下文 Token', '64000', () => f.api.read().contextTokens === 64000);
    f.get('流式接收整理结果').click(); await f.wait(() => f.api.read().stream && !f.get('流式接收整理结果').disabled);
    assert.deepEqual(f.errors, []);
});

test('manual model and presets work without a model-list endpoint', async () => {
    const f = fixture(); await f.change('整理连接方式', 'external');
    await f.change('整理模型', '__manual__', () => f.visible(f.get('手动填写整理模型')));
    f.get('手动填写整理模型').value = 'manual-model'; f.get('确认模型').click();
    await f.wait(() => !f.get('确认模型').disabled && f.api.read().model === 'manual-model');
    assert.equal(f.visible(f.get('手动填写整理模型')), false);
    f.get('保存预设').click(); await f.wait(() => f.visible(f.get('连接预设名称')) && !f.get('确认保存预设').disabled);
    f.get('连接预设名称').value = '<img onerror=alert(1)>总结'; f.get('确认保存预设').click();
    await f.wait(() => f.api.read().presets.length === 1 && !f.get('删除连接预设').disabled);
    assert.equal(f.api.read().selectedPreset, 'preset-id');
    assert.ok(f.get('忆幕连接预设').textContent.includes('<img onerror=alert(1)>总结'));
    f.get('删除连接预设').click(); await f.wait(() => f.api.read().presets.length === 0);
    assert.equal(f.api.read().model, 'manual-model'); assert.equal(f.calls.length, 0);
});

test('connection test is an explicit read-only status request with inline feedback', async () => {
    const f = fixture(); await f.api.update({ mode: 'external', apiUrl: 'http://localhost:1234' });
    f.get('测试连接').click(); await f.wait(() => f.byClass('ym-api-status').textContent === '连接可用');
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].body.messages, undefined);
    assert.equal(f.get('测试连接').disabled, false); assert.deepEqual(f.errors, []);
});

test('invalid numeric change reports a factual inline error and leaves the last valid setting', async () => {
    const f = fixture(); await f.change('整理连接方式', 'external');
    await f.change('最大输出 Token', '-1', () => f.errors.length === 1);
    assert.equal(f.api.read().maxTokens, 2048); assert.match(f.byClass('ym-api-status').textContent, /Token 数值/);
});

const scoped = (file = 'one', isGlobal = false, overrides = { profileId: 'saved-a', model: 'own' }) => ({
    snapshot: { binding: { avatar: 'actor.png', file, integrity: file } }, isGlobal, overrides,
    settings: { profileId: 'saved-a', model: file + '-model' }, profiles: [{ id: 'saved-a', name: '已有连接' }],
});

test('late legacy save cannot report a false error or release a newer operation after changing chats', async () => {
    const finishes = [], f = fixture({ onLegacyChange: () => new Promise(resolve => finishes.push(resolve)) });
    await f.api.update({ mode: 'profile' }); f.view.render(scoped());
    f.get('ST 连接模型').value = 'old-edit'; f.get('ST 连接模型').emit('change');
    assert.equal(f.get('ST 连接模型').disabled, true);
    f.get('ST 连接模型').focus(); f.view.render(scoped('two'));
    assert.equal(f.get('ST 连接模型').value, 'two-model', 'focused legacy drafts do not transfer to a different chat');
    assert.equal(f.get('ST 连接模型').disabled, false);
    f.get('ST 连接模型').value = 'new-edit'; f.get('ST 连接模型').emit('change');
    finishes[0](false); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(f.get('ST 连接模型').disabled, true, 'old finally cannot release the new operation');
    assert.equal(f.byClass('ym-api-status').textContent, ''); assert.deepEqual(f.errors, []);
    finishes[1](false); await f.wait(() => f.errors.length === 1);
    assert.match(f.byClass('ym-api-status').textContent, /连接模型未保存/);
    assert.equal(f.get('ST 连接模型').disabled, false, 'real current-scope failures remain actionable');
});

test('switching between current chat and global defaults invalidates only the old legacy action', async () => {
    let rejectOld; const f = fixture({ onLegacyChange: () => new Promise((_resolve, reject) => { rejectOld = reject; }) });
    await f.api.update({ mode: 'profile' }); f.view.render(scoped());
    f.get('ST 连接预设').emit('change');
    f.view.render(scoped('one', true, {})); assert.equal(f.get('ST 连接预设').disabled, false);
    rejectOld(new Error('旧范围写入失败')); await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(f.errors, []); assert.equal(f.byClass('ym-api-status').textContent, '');
});

test('independent account operations keep their result and busy state across chat and settings scope switches', async () => {
    const f = fixture(); await f.api.update({ mode: 'external', apiUrl: 'http://localhost:1234' });
    let finish; f.api.testConnection = () => new Promise(resolve => { finish = resolve; });
    f.view.render(scoped()); f.get('测试连接').click();
    f.view.render(scoped('two', true)); assert.equal(f.get('测试连接').disabled, true);
    finish({ ok: true }); await f.wait(() => !f.get('测试连接').disabled);
    assert.equal(f.byClass('ym-api-status').textContent, '连接可用'); assert.deepEqual(f.errors, []);
});

test('per-chat connection and model reset icons submit null only for overridden values', async () => {
    const f = fixture(); await f.api.update({ mode: 'profile' }); f.view.render(scoped());
    assert.equal(f.visible(f.get('连接预设跟随默认')), true); assert.equal(f.visible(f.get('连接模型跟随默认')), true);
    f.get('连接预设跟随默认').click(); await f.wait(() => f.legacyChanges.length === 1 && !f.get('连接预设跟随默认').disabled);
    assert.deepEqual(f.legacyChanges[0], { profileId: null });
    f.get('连接模型跟随默认').click(); await f.wait(() => f.legacyChanges.length === 2);
    assert.deepEqual(f.legacyChanges[1], { model: null });
    f.view.render(scoped('one', false, {}));
    assert.equal(f.visible(f.get('连接预设跟随默认')), false); assert.equal(f.visible(f.get('连接模型跟随默认')), false);
    f.view.render(scoped('one', true));
    assert.equal(f.visible(f.get('连接预设跟随默认')), false); assert.equal(f.visible(f.get('连接模型跟随默认')), false);
});
