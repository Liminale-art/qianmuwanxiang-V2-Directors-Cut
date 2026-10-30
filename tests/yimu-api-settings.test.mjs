import test from 'node:test';
import assert from 'node:assert/strict';
import { apiRoot, createApiSettings } from '../yimu/api-settings.mjs';
import { createHost } from '../yimu/host.mjs';

function fixture() {
    const calls = [], saves = [], raw = [], profile = [];
    const ctx = { extensionSettings: { yimu: { showShortcut: true } }, mainApi: 'openai',
        chatCompletionSettings: { openai_max_context: 32768, openai_max_tokens: 1500 },
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'fixture' }),
        async saveSettingsDebounced() { saves.push(structuredClone(ctx.extensionSettings)); },
        async generateRaw(options) { raw.push(options); return '当前连接'; },
        ConnectionManagerRequestService: { async sendRequest(...args) { profile.push(args); return '预设连接'; } } };
    let answer = () => Response.json({ choices: [{ message: { content: '摘要正文' }, finish_reason: 'stop' }] });
    const fetcher = async (path, options) => { calls.push({ path, options, body: options.body === undefined ? undefined : JSON.parse(options.body) }); return answer(path, options); };
    const api = createApiSettings({ getContext: () => ctx, fetchImpl: fetcher, createId: () => 'preset-fixture' });
    return { ctx, api, calls, saves, raw, profile, fetcher, set answer(value) { answer = value; } };
}
const external = { mode: 'external', apiUrl: 'https://models.example/v1', model: 'fixture-model', apiKey: 'private-fixture-key' };

test('API roots preserve custom/local deployments and strip only recognized endpoint suffixes', () => {
    assert.equal(apiRoot('http://127.0.0.1:1234/v1/chat/completions'), 'http://127.0.0.1:1234/v1');
    assert.equal(apiRoot('https://provider.example/api/models/'), 'https://provider.example/api');
    assert.equal(apiRoot('https://provider.example/custom/base'), 'https://provider.example/custom/base');
    for (const value of ['file:///secret', 'https://u:p@example.com', 'https://example.com?key=secret', 'https://example.com#section']) assert.throws(() => apiRoot(value));
});

test('settings and secrets are scoped to ST account and preserve shortcut settings', async () => {
    const f = fixture(); await f.api.update(external);
    assert.equal(f.ctx.extensionSettings.yimu.showShortcut, true);
    assert.equal(f.ctx.extensionSettings.yimu.api.apiKey, external.apiKey);
    assert.equal(f.saves.length, 1);
    assert.equal(f.api.read().revision, 1);
    const read = f.api.read(); read.models.push('not-saved'); assert.deepEqual(f.api.read().models, []);
    assert.ok(!JSON.stringify(f.api.effectiveConnection()).includes(external.apiKey));
    assert.ok(!JSON.stringify(f.api.effectiveConnection()).includes(external.apiUrl));
});

test('failed saves roll back only the owned settings record and do not break subsequent saves', async () => {
    const f = fixture(), before = f.ctx.extensionSettings.yimu;
    f.ctx.saveSettingsDebounced = async () => { throw Error('private server error'); };
    await assert.rejects(f.api.update(external), /未保存/);
    assert.equal(f.ctx.extensionSettings.yimu, before);
    f.ctx.saveSettingsDebounced = async () => {};
    await f.api.update({ mode: 'external' }); assert.equal(f.api.read().mode, 'external');
});

test('queued field writes preserve each other and never leak unknown settings', async () => {
    const f = fixture(); await Promise.all([f.api.update({ apiUrl: external.apiUrl }), f.api.update({ apiKey: external.apiKey }), f.api.update({ model: external.model })]);
    assert.equal(f.api.read().model, external.model); assert.equal(f.api.read().apiKey, external.apiKey);
    assert.equal(f.api.read().revision, 3);
    assert.throws(() => f.api.update({ chat: [] }), /未知/);
    assert.throws(() => f.api.update({ apiKey: 'x\nAuthorization: leaked' }), /无效/);
});

test('models and connection test use only the ST status proxy, accepting keyless and irregular model lists', async () => {
    const f = fixture(); await f.api.update({ ...external, apiKey: '', apiUrl: 'http://localhost:1234/v1/models' });
    f.answer = () => Response.json({ data: [{ id: 'a' }, { name: 'b' }, 'a', { bad: 'skip' }] });
    assert.deepEqual(await f.api.fetchModels(), ['a', 'b']);
    assert.equal(f.api.read().model, 'fixture-model', 'discovery does not silently switch models');
    assert.deepEqual(await f.api.testConnection(), { ok: true, scope: 'model-list' });
    assert.equal(f.calls.length, 2);
    for (const call of f.calls) {
        assert.equal(call.path, '/api/backends/chat-completions/status');
        assert.equal(call.body.custom_url, 'http://localhost:1234/v1');
        assert.deepEqual(JSON.parse(call.body.custom_include_headers), { Authorization: '' });
        assert.equal(call.options.headers['X-CSRF-Token'], 'fixture');
        assert.equal(call.body.messages, undefined);
    }
});

test('a late model list cannot attach to a different endpoint', async () => {
    const f = fixture(); await f.api.update(external);
    let finish, started; const ready = new Promise(resolve => { started = resolve; });
    f.answer = () => { started(); return new Promise(resolve => { finish = resolve; }); };
    const pending = f.api.fetchModels(); await ready;
    await f.api.update({ apiUrl: 'https://second.example/v1' }); finish(Response.json({ data: [{ id: 'old' }] }));
    await assert.rejects(pending, /连接已变化/); assert.deepEqual(f.api.read().models, []);
});

test('presets contain the complete API choices and overwrite matching names, not other settings', async () => {
    const f = fixture(); await f.api.update({ ...external, stream: true, temperature: 0.35, contextTokens: 64000, maxTokens: 4096 });
    await f.api.savePreset('整理'); await f.api.update({ model: 'new-model' }); await f.api.savePreset('整理');
    assert.equal(f.api.read().presets.length, 1);
    await f.api.update({ mode: 'st', apiKey: '', model: '' }); await f.api.loadPreset('preset-fixture');
    assert.equal(f.api.read().apiKey, external.apiKey); assert.equal(f.api.read().model, 'new-model');
    assert.equal(f.api.read().stream, true); assert.equal(f.api.read().mode, 'external');
    await f.api.deletePreset('preset-fixture'); assert.deepEqual(f.api.read().presets, []);
    assert.equal(f.api.read().apiKey, external.apiKey, 'deleting a saved preset does not erase the active connection');
});

test('independent generation has a single ST request, explicit authorization and real generation parameters', async () => {
    const f = fixture(); await f.api.update({ ...external, maxTokens: 5000, temperature: 0.2 });
    const result = await f.api.generate('原文', { systemPrompt: '仅依据原文', connection: f.api.effectiveConnection(), maxTokens: 1000 });
    assert.equal(result, '摘要正文'); assert.equal(f.calls.length, 1);
    const call = f.calls[0]; assert.equal(call.path, '/api/backends/chat-completions/generate');
    assert.equal(call.body.max_tokens, 1000); assert.equal(call.body.temperature, 0.2);
    assert.equal(call.body.stream, false); assert.equal(call.body.model, external.model);
    assert.deepEqual(JSON.parse(call.body.custom_include_headers), { Authorization: `Bearer ${external.apiKey}` });
    assert.equal(call.body.messages[1].content, '原文'); assert.equal(f.raw.length, 0);
});

test('a long prompt fails before sending and is never truncated to fit', async () => {
    const f = fixture(); await f.api.update({ ...external, contextTokens: 256, maxTokens: 30 });
    await assert.rejects(f.api.generate('原文'.repeat(1000), { systemPrompt: '规则' }), /上下文容量/);
    assert.equal(f.calls.length, 0);
});

test('HTTP, provider and network failures neither fall back nor retry and redact known secrets', async () => {
    for (const response of [() => new Response('', { status: 403 }), () => Response.json({ error: { message: `bad ${external.apiKey} at ${external.apiUrl}` } }), () => { throw Error(`network ${external.apiKey}`); }]) {
        const f = fixture(); await f.api.update(external); f.answer = response;
        await assert.rejects(f.api.generate('原文'), error => !error.message.includes(external.apiKey) && !error.message.includes(external.apiUrl));
        assert.equal(f.calls.length, 1); assert.equal(f.raw.length, 0); assert.equal(f.profile.length, 0);
    }
});

test('connection changes after generation starts discard late results without retry', async () => {
    const f = fixture(); await f.api.update(external);
    let finish, started; const ready = new Promise(resolve => { started = resolve; });
    f.answer = () => { started(); return new Promise(resolve => { finish = resolve; }); };
    const pending = f.api.generate('原文', { connection: f.api.effectiveConnection() }); await ready;
    await f.api.update({ mode: 'st' }); finish(Response.json({ choices: [{ message: { content: 'old' } }] }));
    await assert.rejects(pending, /连接已变化/); assert.equal(f.calls.length, 1);
});

test('streaming accepts chunked UTF-8 and keeps reasoning out of summary content', async () => {
    const f = fixture(); await f.api.update({ ...external, stream: true });
    const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"reasoning_content":"private","content":"两人"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"初见"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    f.answer = () => new Response(new ReadableStream({ start(controller) { for (let n = 0; n < bytes.length; n += 7) controller.enqueue(bytes.slice(n, n + 7)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
    const chunks = [];
    assert.equal(await f.api.generate('原文', { onChunk: (delta, accumulated) => chunks.push([delta, accumulated]) }), '两人初见'); assert.equal(f.calls[0].body.stream, true);
    assert.deepEqual(chunks, [['两人', '两人'], ['初见', '两人初见']]);
});

test('truncated stream and output-length stops never become usable memory', async () => {
    for (const body of ['data: {"choices":[{"delta":{"content":"半截"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"半截"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n']) {
        const f = fixture(); await f.api.update({ ...external, stream: true });
        f.answer = () => new Response(body, { headers: { 'content-type': 'text/event-stream' } });
        await assert.rejects(f.api.generate('原文'), /未完整确认|输出上限/); assert.equal(f.calls.length, 1);
    }
});

test('legacy ST presets remain usable; explicit independent/profile choices never silently fall back', async () => {
    const f = fixture(), host = createHost({ getContext: () => f.ctx, fetcher: f.fetcher });
    assert.equal(await host.generate('原文', { profileId: 'old-profile', model: 'old-model' }), '预设连接');
    assert.equal(f.profile[0][0], 'old-profile'); assert.deepEqual(f.profile[0][4], { model: 'old-model' });
    await host.connectionApi.update({ mode: 'st' });
    assert.equal(await host.generate('原文', { profileId: 'old-profile', model: 'old-model' }), '当前连接');
    await host.connectionApi.update({ mode: 'profile' }); await assert.rejects(host.generate('原文'), /请选择 ST/);
    await host.connectionApi.update({ mode: 'external' }); await assert.rejects(host.generate('原文', { profileId: 'old-profile' }), /请选择或填写/);
    assert.equal(f.calls.length, 0); assert.equal(f.profile.length, 1); assert.equal(f.raw.length, 1);
});

test('snapshot avatar uses ST thumbnail API and encoded native fallback without touching chat', async () => {
    const f = fixture(); Object.assign(f.ctx, { groupId: null, characterId: 0, chatId: 'story', chatMetadata: { integrity: 'id' }, chat: [], characters: [{ name: '秦铎', avatar: '秦 铎.png' }] });
    const host = createHost({ getContext: () => f.ctx });
    assert.equal((await host.snapshot()).avatarUrl, '/thumbnail?type=avatar&file=%E7%A7%A6%20%E9%93%8E.png');
    f.ctx.getThumbnailUrl = (type, file) => `native:${type}:${file}`;
    assert.equal((await host.snapshot()).avatarUrl, 'native:avatar:秦 铎.png'); assert.equal(f.saves.length, 0);
});

test('status requests have bounded cancellation and never reveal endpoint credentials in errors', async () => {
    const f = fixture(); await f.api.update(external);
    const calls = [];
    const api = createApiSettings({ getContext: () => f.ctx, statusTimeoutMs: 5, fetchImpl: async (_path, options) => {
        calls.push(options); return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    } });
    await assert.rejects(api.testConnection(), /请求超时/); assert.equal(calls.length, 1);
    f.answer = () => { throw Error(`unable to reach ${external.apiUrl} with ${external.apiKey}`); };
    await assert.rejects(f.api.fetchModels(), error => !error.message.includes(external.apiKey) && !error.message.includes(external.apiUrl));
});

test('pre-cancelled generation and incomplete provider endings do not return summary text', async () => {
    const f = fixture(); await f.api.update(external);
    const controller = new AbortController(); controller.abort(new Error('已取消'));
    await assert.rejects(f.api.generate('原文', { signal: controller.signal }), /已取消/); assert.equal(f.calls.length, 0);
    f.answer = () => Response.json({ choices: [{ message: { content: '不完整' }, finish_reason: 'content_filter' }] });
    await assert.rejects(f.api.generate('原文'), /未完整结束/); assert.equal(f.calls.length, 1);
});

test('model discovery and saving a preset do not invalidate an unchanged active connection', async () => {
    const f = fixture(); await f.api.update(external);
    const connection = f.api.effectiveConnection();
    f.answer = () => Response.json({ data: [{ id: 'available' }] });
    await f.api.fetchModels(); await f.api.savePreset('当前连接');
    assert.equal(f.api.read().revision, connection.revision);
    f.answer = () => Response.json({ choices: [{ message: { content: '结果' } }] });
    assert.equal(await f.api.generate('原文', { connection }), '结果');
});

test('account profile migration is explicit and an explicitly empty profile never revives a legacy connection', async () => {
    const f = fixture(), old = { profileId: 'legacy-chat', model: 'legacy-model' };
    assert.equal(f.api.effectiveConnection(old).profileId, 'legacy-chat'); assert.equal(f.saves.length, 0);
    await f.api.update({ mode: 'profile' });
    assert.equal(f.api.effectiveConnection(old).profileId, 'legacy-chat', 'historic profile mode without ownership preserves old configuration');
    await f.api.update({ mode: 'profile', profileId: 'account-profile', profileModel: 'account-model', profileConfigured: true });
    const connection = f.api.effectiveConnection(old);
    assert.equal(connection.profileId, 'account-profile'); assert.equal(connection.model, 'account-model');
    assert.equal(f.api.effectiveConnection({ profileId: 'other-chat', model: 'other-model' }).profileId, 'account-profile');
    await f.api.update({ profileId: '', profileModel: '', profileConfigured: true });
    assert.equal(f.api.effectiveConnection(old).profileId, '');
    assert.throws(() => f.api.assertCurrent(connection), /连接已变化/);
    const host = createHost({ getContext: () => f.ctx, fetcher: f.fetcher });
    await assert.rejects(host.generate('synthetic prompt', { connection: host.summaryConnection(old) }), /请选择 ST 连接预设/);
    assert.deepEqual(f.raw, []); assert.deepEqual(f.profile, []); assert.deepEqual(f.calls, []);
});

test('vector provider settings stay account-scoped and rank candidates without persisting vectors', async () => {
    const f = fixture();
    await f.api.updateVector({ apiUrl: 'https://vector.example/v1/embeddings', apiKey: 'vector-secret', model: 'embed-fixture' });
    assert.equal(f.ctx.extensionSettings.yimu.showShortcut, true);
    assert.deepEqual(f.api.vectorRead(), { apiUrl: 'https://vector.example/v1', apiKey: 'vector-secret', model: 'embed-fixture', presets: [], selectedPreset: '', revision: 1 });
    f.answer = () => Response.json({ data: [{ index: 0, embedding: [1, 0] }, { index: 1, embedding: [0.9, 0.1] }, { index: 2, embedding: [0, 1] }] });
    const ranked = await f.api.vectorCandidates({ query: '当前', candidates: [{ id: 'near', text: '近', title: '近' }, { id: 'far', text: '远', title: '远' }] });
    assert.deepEqual(ranked.map(item => item.id), ['near', 'far']);
    assert.equal('vector' in ranked[0], false); assert.equal('apiKey' in ranked[0], false);
    assert.equal(f.calls.at(-1).path, 'https://vector.example/v1/embeddings');
    assert.deepEqual(f.calls.at(-1).options.headers, { 'Content-Type': 'application/json', Authorization: 'Bearer vector-secret' });
    assert.deepEqual(JSON.parse(f.calls.at(-1).options.body).input, ['当前', '近', '远']);
});

test('vector and rerank provider presets save, load and delete without leaking into the other provider', async () => {
    const f = fixture();
    await f.api.updateVector({ apiUrl: 'https://vector.example/v1', apiKey: 'vector-secret', model: 'embed-fixture' });
    await f.api.saveVectorPreset('向量本地');
    assert.equal(f.api.vectorRead().presets.length, 1); assert.equal(f.api.vectorRead().selectedPreset, 'preset-fixture');
    await f.api.updateVector({ model: 'another-model' }); assert.equal(f.api.vectorRead().selectedPreset, '');
    await f.api.loadVectorPreset('preset-fixture'); assert.equal(f.api.vectorRead().model, 'embed-fixture');
    await f.api.deleteVectorPreset('preset-fixture'); assert.deepEqual(f.api.vectorRead().presets, []);
    await f.api.updateRerank({ apiUrl: 'https://rank.example/v1', model: 'rank-fixture', topN: 3 });
    await f.api.saveRerankPreset('重排本地');
    assert.equal(f.api.rerankRead().presets.length, 1); assert.equal(f.api.vectorRead().presets.length, 0);
    await f.api.updateRerank({ topN: 2 }); await f.api.loadRerankPreset('preset-fixture'); assert.equal(f.api.rerankRead().topN, 3);
});

test('vector and rerank provider controls test explicit endpoints and discover model lists without changing settings', async () => {
    const f = fixture();
    await f.api.updateVector({ apiUrl: 'https://vector.example/v1/embeddings', apiKey: 'vector-secret', model: 'embed-fixture' });
    await f.api.updateRerank({ apiUrl: 'https://rank.example/v1/rerank', apiKey: 'rank-secret', model: 'rank-fixture' });
    f.answer = (_path, options) => options.method === 'GET'
        ? Response.json({ data: [{ id: 'one' }, { name: 'two' }, 'one'] })
        : Response.json({ data: [{ index: 0, embedding: [1, 0] }] });
    assert.deepEqual(await f.api.fetchVectorModels(), ['one', 'two']);
    assert.deepEqual(await f.api.fetchRerankModels(), ['one', 'two']);
    assert.deepEqual(await f.api.testVectorConnection(), { ok: true, provider: 'vector' });
    assert.deepEqual(await f.api.testRerankConnection(), { ok: true, provider: 'rerank' });
    assert.equal(f.calls[0].path, 'https://vector.example/v1/models');
    assert.equal(f.calls[1].path, 'https://rank.example/v1/models');
    assert.equal(f.calls[2].path, 'https://vector.example/v1/embeddings');
    assert.equal(f.calls[3].path, 'https://rank.example/v1/rerank');
    assert.equal(f.calls[2].options.method, 'POST');
    assert.deepEqual(JSON.parse(f.calls[2].options.body), { model: 'embed-fixture', input: ['忆幕连接测试'] });
    assert.deepEqual(JSON.parse(f.calls[3].options.body), { model: 'rank-fixture', query: '忆幕连接测试', documents: ['忆幕连接测试'], top_n: 1 });
    assert.equal(f.api.vectorRead().model, 'embed-fixture');
    assert.equal(f.api.rerankRead().model, 'rank-fixture');
});

test('candidate request timeout is a shared account setting with a fifteen-second default', async () => {
    const f = fixture();
    assert.deepEqual(f.api.retrievalTimeoutRead(), { ms: 15000, seconds: 15, revision: 0 });
    await f.api.updateRetrievalTimeout(20);
    assert.deepEqual(f.api.retrievalTimeoutRead(), { ms: 20000, seconds: 20, revision: 1 });
    assert.equal(f.ctx.extensionSettings.yimu.retrievalTimeoutMs, 20000);
    assert.equal(f.saves.length, 1);
    assert.throws(() => f.api.updateRetrievalTimeout(4), /5—60 秒/);
    assert.throws(() => f.api.updateRetrievalTimeout(61), /5—60 秒/);
    await f.api.updateRetrievalTimeout('');
    assert.deepEqual(f.api.retrievalTimeoutRead(), { ms: 15000, seconds: 15, revision: 2 });
});

test('vector provider is quiet until URL and model exist and redacts endpoint failures', async () => {
    const f = fixture();
    assert.deepEqual(await f.api.vectorCandidates({ query: '当前', candidates: [{ id: 'a', text: '记忆' }] }), []);
    await f.api.updateVector({ apiUrl: 'https://vector.example/v1', apiKey: 'vector-secret', model: 'embed-fixture' });
    f.answer = () => { throw Error('network https://vector.example/v1 with vector-secret'); };
    await assert.rejects(f.api.vectorCandidates({ query: '当前', candidates: [{ id: 'a', text: '记忆' }] }), error => !error.message.includes('vector-secret') && !error.message.includes('vector.example'));
});

test('vector and rerank requests have a bounded wait and return a factual fallback reason', async () => {
    const f = fixture();
    await f.api.updateVector({ apiUrl: 'https://vector.example/v1', model: 'embed-fixture' });
    await f.api.updateRerank({ apiUrl: 'https://rank.example/v1', model: 'rank-fixture' });
    const hanging = async (_path, options) => new Promise((_resolve, reject) => {
        assert.ok(options.signal, 'candidate providers must receive a cancellable signal');
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
    const bounded = createApiSettings({ getContext: () => f.ctx, fetchImpl: hanging, retrievalTimeoutMs: 5 });
    await assert.rejects(bounded.vectorCandidates({ query: '当前', candidates: [{ id: 'a', text: '记忆' }] }), /向量候选请求超时，已回退关键词召回/);
    await assert.rejects(bounded.rerankCandidates({ query: '当前', candidates: [{ id: 'a', text: '记忆' }] }), /重排候选请求超时，已保留当前顺序/);
});

test('account API and vector writes serialize without dropping each other', async () => {
    const f = fixture();
    await Promise.all([
        f.api.update({ mode: 'external', apiUrl: 'https://summary.example/v1', model: 'summary-fixture' }),
        f.api.updateVector({ apiUrl: 'https://vector.example/v1', model: 'embed-fixture' }),
    ]);
    assert.equal(f.api.read().model, 'summary-fixture');
    assert.equal(f.api.vectorRead().model, 'embed-fixture');
    assert.equal(f.ctx.extensionSettings.yimu.api.model, 'summary-fixture');
    assert.equal(f.ctx.extensionSettings.yimu.vector.model, 'embed-fixture');
});

test('rerank provider settings are account-scoped and map OpenAI/Cohere-style results', async () => {
    const f = fixture();
    await f.api.updateRerank({ apiUrl: 'https://rank.example/v1/rerank', apiKey: 'rank-secret', model: 'rank-fixture', topN: 2 });
    assert.deepEqual(f.api.rerankRead(), { apiUrl: 'https://rank.example/v1', apiKey: 'rank-secret', model: 'rank-fixture', topN: 2, presets: [], selectedPreset: '', revision: 1 });
    assert.equal(f.ctx.extensionSettings.yimu.rerank.model, 'rank-fixture');
    f.answer = () => Response.json({ results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.2 }, { index: 9, relevance_score: 1 }] });
    const ranked = await f.api.rerankCandidates({ query: '当前', candidates: [{ id: 'a', text: '第一条' }, { id: 'b', text: '第二条' }] });
    assert.deepEqual(ranked.map(item => item.id), ['b', 'a']);
    assert.equal(f.calls.at(-1).path, 'https://rank.example/v1/rerank');
    assert.deepEqual(f.calls.at(-1).options.headers, { 'Content-Type': 'application/json', Authorization: 'Bearer rank-secret' });
    assert.deepEqual(JSON.parse(f.calls.at(-1).options.body), { model: 'rank-fixture', query: '当前', documents: ['第一条', '第二条'], top_n: 2 });
    assert.equal('relevance_score' in ranked[0], false); assert.equal(typeof ranked[0].score, 'number');
});

test('rerank provider stays quiet until URL/model exist and redacts endpoint credentials', async () => {
    const f = fixture();
    assert.deepEqual(await f.api.rerankCandidates({ query: '当前', candidates: [{ id: 'a', text: '记忆' }] }), []);
    assert.equal(f.calls.length, 0);
    await f.api.updateRerank({ apiUrl: 'https://rank.example/v1', apiKey: 'rank-secret', model: 'rank-fixture' });
    f.answer = () => { throw Error('network https://rank.example/v1 with rank-secret'); };
    await assert.rejects(f.api.rerankCandidates({ query: '当前', candidates: [{ id: 'a', text: '记忆' }] }), error => !error.message.includes('rank-secret') && !error.message.includes('rank.example'));
});

test('rerank authorization retries once with a raw key after an auth rejection', async () => {
    const f = fixture(); await f.api.updateRerank({ apiUrl: 'https://rank.example/v1', apiKey: 'rank-secret', model: 'rank-fixture' });
    let attempts = 0;
    f.answer = () => {
        attempts++;
        if (attempts === 1) return new Response('', { status: 401 });
        return Response.json({ results: [{ index: 0, relevance_score: 0.8 }] });
    };
    const ranked = await f.api.rerankCandidates({ query: '当前', candidates: [{ id: 'a', text: '记忆' }] });
    assert.deepEqual(ranked.map(item => item.id), ['a']);
    assert.equal(attempts, 2); assert.equal(f.calls[0].options.headers.Authorization, 'Bearer rank-secret'); assert.equal(f.calls[1].options.headers.Authorization, 'rank-secret');
});

test('rerank settings validate bounded topN and preserve vector writes', async () => {
    const f = fixture();
    assert.throws(() => f.api.updateRerank({ topN: 0 }), /1—64/);
    assert.throws(() => f.api.updateRerank({ topN: 65 }), /1—64/);
    await Promise.all([
        f.api.updateRerank({ apiUrl: 'https://rank.example/v1', model: 'rank-fixture', topN: 4 }),
        f.api.updateVector({ apiUrl: 'https://vector.example/v1', model: 'embed-fixture' }),
    ]);
    assert.equal(f.api.rerankRead().model, 'rank-fixture'); assert.equal(f.api.vectorRead().model, 'embed-fixture');
    assert.equal(f.ctx.extensionSettings.yimu.rerank.model, 'rank-fixture'); assert.equal(f.ctx.extensionSettings.yimu.vector.model, 'embed-fixture');
});
