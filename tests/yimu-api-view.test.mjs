import test from 'node:test';
import assert from 'node:assert/strict';
import { textCollectionDom } from './helpers/text-collection-dom.mjs';
import { createApiSettings } from '../yimu/api-settings.mjs';
import { mountApiView } from '../yimu/api-view.mjs';

function fixture({ onLegacyChange, accountOnly = false } = {}) {
    const dom = textCollectionDom(), create = dom.doc.createElement;
    // Only the reviewed bundled icon renderer has a markup sink; all user data remains text/value.
    dom.doc.createElement = tag => {
        const node = create(tag);
        if (tag === 'span') Object.defineProperty(node, 'innerHTML', { set(value) { assert.match(value, /^<svg xmlns=/); }, configurable: true });
        return node;
    };
    const calls = [], errors = [], legacyChanges = [], ctx = { extensionSettings: { story_director_liminale: { apiProfiles: [{ id: 'saved-a', name: '千幕已有预设', model: 'qianmu-model', apiUrl: 'https://qianmu.example/v1', apiKey: 'synthetic-shared-key', temperature: 0.4 }] } }, async saveSettingsDebounced() {}, getRequestHeaders: () => ({}) };
    let legacy = { profileId: '', model: '' };
    const api = createApiSettings({ getContext: () => ctx, createId: () => 'preset-id', fetchImpl: async (path, options) => {
        calls.push({ path, body: JSON.parse(options.body) }); return Response.json({ data: [{ id: 'first-model' }, { id: 'second-model' }] });
    } });
    const view = mountApiView(dom.parent, { api, document: dom.doc, onError: error => errors.push(error), accountOnly,
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
    assert.deepEqual(mode.children.map(item => item.value), ['st', 'qianmu', 'external']);
    assert.equal(f.visible(f.get('API URL')), false); assert.equal(f.visible(f.get('千幕 API 预设')), false);
    assert.match(f.parent.textContent, /API设置/); f.view.destroy(); assert.equal(f.parent.children.length, 0);
});

test('Qianmu presets use the live shared owner without copying credentials or modifying global connections', async () => {
    const f = fixture(), owner = structuredClone(f.ctx.extensionSettings.story_director_liminale);
    await f.change('整理连接方式', 'qianmu', () => f.api.read().mode === 'qianmu');
    assert.equal(f.visible(f.get('千幕 API 预设')), true);
    await f.change('千幕 API 预设', 'saved-a', () => f.api.read().qianmuPresetId === 'saved-a');
    assert.deepEqual(f.ctx.extensionSettings.story_director_liminale, owner);
    assert.ok(!JSON.stringify(f.ctx.extensionSettings.yimu).includes('synthetic-shared-key'));
    assert.equal(f.api.read().apiUrl, ''); assert.equal(f.calls.length, 0);
    assert.equal(f.ctx.mainApi, undefined); assert.deepEqual(f.legacyChanges, []);
});

test('external fields, model pull and selection all persist actual controls', async () => {
    const f = fixture(); await f.change('整理连接方式', 'external', () => f.api.read().mode === 'external');
    assert.equal(f.visible(f.get('API URL')), true); assert.equal(f.get('API Key').type, 'password'); assert.equal(f.get('API Key').placeholder, '');
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
    assert.equal(f.api.read().maxTokens, 32000); assert.match(f.byClass('ym-api-status').textContent, /Token 数值/);
});

test('clearing API numeric fields restores factory defaults while an explicit zero temperature remains zero', async () => {
    const f = fixture(); await f.change('整理连接方式', 'external');
    await f.change('整理温度', '0', () => f.api.read().temperature === 0);
    await f.change('整理温度', '', () => f.api.read().temperature === 1);
    await f.change('最大输出 Token', '1024'); await f.change('最大输出 Token', '', () => f.api.read().maxTokens === 32000);
    await f.change('上下文 Token', '8000'); await f.change('上下文 Token', '', () => f.api.read().contextTokens === 1000000);
    assert.deepEqual(f.errors, []);
});

const scoped = (file = 'one', isGlobal = false, overrides = { profileId: 'saved-a', model: 'own' }) => ({
    snapshot: { binding: { avatar: 'actor.png', file, integrity: file } }, isGlobal, overrides,
    settings: { profileId: 'saved-a', model: file + '-model' }, profiles: [{ id: 'saved-a', name: '已有连接' }],
});

test('historic ST profile stays preserved without a fourth mode or an implicit switch', async () => {
    const f = fixture(); await f.api.update({ mode: 'profile', profileId: 'old', profileModel: 'old-model', profileConfigured: true });
    f.view.render(scoped());
    assert.equal(f.get('ST 连接模型'), undefined); assert.equal(f.get('ST 连接预设'), undefined);
    assert.equal(f.api.read().mode, 'profile'); assert.match(f.parent.textContent, /旧版 ST 连接已保留/);
    assert.equal(f.get('整理连接方式').children.length, 3);
    await f.change('整理连接方式', 'st');
    assert.equal(f.api.effectiveConnection().mode, 'st'); assert.equal(f.api.read().profileId, 'old');
});

test('Qianmu metadata refreshes live across scopes without exposing credentials or saving copies', async () => {
    const f = fixture(); await f.api.update({ mode: 'qianmu', qianmuPresetId: 'saved-a' });
    const before = JSON.stringify(f.ctx.extensionSettings.yimu);
    f.ctx.extensionSettings.story_director_liminale.apiProfiles[0].name = '已更新预设';
    f.view.render(scoped('two', true));
    assert.match(f.get('千幕 API 预设').textContent, /已更新预设/);
    assert.ok(!f.parent.textContent.includes('synthetic-shared-key'));
    assert.equal(JSON.stringify(f.ctx.extensionSettings.yimu), before); assert.deepEqual(f.legacyChanges, []);
});

test('independent account operations keep their result and busy state across chat and settings scope switches', async () => {
    const f = fixture(); await f.api.update({ mode: 'external', apiUrl: 'http://localhost:1234' });
    let finish; f.api.testConnection = () => new Promise(resolve => { finish = resolve; });
    f.view.render(scoped()); f.get('测试连接').click();
    f.view.render(scoped('two', true)); assert.equal(f.get('测试连接').disabled, true);
    finish({ ok: true }); await f.wait(() => !f.get('测试连接').disabled);
    assert.equal(f.byClass('ym-api-status').textContent, '连接可用'); assert.deepEqual(f.errors, []);
});

test('the new account-owned API surface has no per-chat follow-default controls', async () => {
    const f = fixture(); await f.api.update({ mode: 'profile' }); f.view.render(scoped());
    assert.equal(f.get('连接预设跟随默认'), undefined); assert.equal(f.get('连接模型跟随默认'), undefined);
    assert.deepEqual(f.legacyChanges, []);
});

test('account-owned Qianmu selection does not follow numeric chat/global scope or invoke legacy writers', async () => {
    const f = fixture({ accountOnly: true }); f.view.render(scoped('one'));
    assert.equal(f.api.read().mode, 'inherit'); assert.equal(f.ctx.extensionSettings.yimu, undefined);
    await f.change('整理连接方式', 'qianmu');
    await f.change('千幕 API 预设', 'saved-a', () => f.api.read().qianmuPresetId === 'saved-a');
    const revision = f.api.read().revision;
    f.view.render(scoped('two', true));
    assert.equal(f.get('千幕 API 预设').value, 'saved-a'); assert.equal(f.api.read().revision, revision);
    await f.change('千幕 API 预设', '', () => f.api.read().qianmuPresetId === '');
    f.view.render(scoped('three'));
    assert.equal(f.get('千幕 API 预设').value, ''); assert.throws(() => f.api.effectiveConnection(), /请选择千幕/);
    assert.deepEqual(f.legacyChanges, []); assert.equal(f.calls.length, 0); f.view.destroy();
});
