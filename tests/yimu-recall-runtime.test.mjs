import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createYimuStore, chatStorageName} from '../yimu/server-store.mjs';
import {registerYimuRoutes} from '../yimu/server-plugin.mjs';
import {createApi} from '../yimu/client.mjs';
import {createController} from '../yimu/runtime.mjs';
import {createHost} from '../yimu/host.mjs';
import {VERSION, SCHEMA, fingerprintMessages} from '../yimu/contract.mjs';
import {buildPlan} from '../yimu/core.mjs';
import {buildBudgetedMessages, captureCore, byteBudget, memoryMessage} from '../yimu/budget.mjs';
import {recallCandidates} from '../yimu/recall.mjs';
import {excerptRecords, recallBlockReason} from '../yimu/recall-contract.mjs';

// Full local route/client/store/runtime/host flow with synthetic stories and model outputs.
// No browser, real account, server deployment, credentials or paid model calls.
const clone = value => structuredClone(value);
const QUOTE = '甲把蓝色信封放进书桌第二格抽屉，没有告诉乙。';
const REQUEST = {parentId: 'old_fine', question: '蓝色信封当时放在哪里，乙是否已经知道？'};
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
};

async function fixture(t, {floors = 12, longFloors = false, ambiguous = false, requests = [REQUEST]} = {}) {
    const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'yimu-recall-runtime-'));
    const account = path.join(root, 'account'), chats = path.join(account, 'chats');
    const binding = {avatar: 'Recall.png', file: 'Synthetic-recall', integrity: 'synthetic_recall_identity'};
    const messages = Array.from({length: floors}, (_, i) => ({name: i % 2 ? '甲' : '乙', is_user: !(i % 2),
        mes: `第${i + 1}层：他们重新谈到蓝色信封。` + (longFloors && i > 1 && i < floors - 5 ? '叙事继续推进。'.repeat(100) : ''),
        send_date: `2026-10-25T12:${String(i).padStart(2, '0')}:00Z`}));
    messages[0].mes = '旧日的一封信改变了双方的约定；甲尚未作出说明。';
    messages[1].mes = `黄昏时，他们仍未说话。\n${QUOTE}\n${ambiguous ? `后来回忆中重复了这句话：\n${QUOTE}` : '这是那一晚的原文记录。'}`;
    await fs.mkdir(path.join(chats, 'Recall'), {recursive: true});
    const rawPath = path.join(chats, 'Recall', `${binding.file}.jsonl`);
    const writeChat = (items = context.chat) => fs.writeFile(rawPath, [{chat_metadata: {integrity: binding.integrity}}, ...items].map(JSON.stringify).join('\n'), 'utf8');
    await fs.writeFile(rawPath, [{chat_metadata: {integrity: binding.integrity}}, ...messages].map(JSON.stringify).join('\n'), 'utf8');
    const request = {user: {profile: {handle: 'synthetic-fixture'}, directories: {root: account, chats}}};
    const store = createYimuStore({hostCwd: root}), routes = new Map(), calls = [], faults = {};
    registerYimuRoutes({get(route, fn) { routes.set(`GET ${route}`, fn); }, post(route, fn) { routes.set(`POST ${route}`, fn); }}, {store});
    const fetcher = async (url, options) => {
        const route = `/${url.split('/').at(-1)}`, body = options.body ? JSON.parse(options.body) : undefined;
        const call = {route, body: clone(body)}; calls.push(call);
        if (route === '/recall-source' && faults.source) throw new TypeError('synthetic source network failure');
        if (route === '/change' && body.operation.type === 'recall' && faults.recallWrite) throw new TypeError('synthetic recall network failure');
        let status = 200, value;
        const response = {status(next) { status = next; return this; }, json(next) { value = clone(next); return this; }};
        const handler = routes.get(`${options.method} ${route}`); assert.ok(handler, `registered ${route}`);
        await handler({...request, body}, response);
        call.status = status; call.result = clone(value);
        if (route === '/recall-source' && faults.sourceGate) {
            const gate = faults.sourceGate; faults.sourceGate = null;
            gate.started.resolve(); await gate.release.promise;
        }
        if (route === '/change' && body.operation.type === 'recall' && faults.loseRecallReply) {
            faults.loseRecallReply = false; throw new TypeError('synthetic reply lost after commit');
        }
        return {ok: status >= 200 && status < 300, status, json: async () => clone(value)};
    };
    const api = createApi({fetcher, headers: () => ({'X-CSRF-Token': 'synthetic-only'})});
    assert.deepEqual(await api.health(), {version: VERSION, schema: SCHEMA});
    let doc = (await api.change(binding, {id: 'seed_enable', type: 'enable', expectedRevision: 0, enabled: true,
        range: {start: 1, end: floors, total: floors}})).document;
    const hashes = await fingerprintMessages(messages);
    doc = (await api.change(binding, {id: 'seed_fine', type: 'append', expectedEpoch: doc.epoch,
        entry: {id: 'old_fine', kind: 'summary', text: '双方曾处理蓝色信封，甲尚未告知乙其去向。',
            source: {start: 1, end: 2, hashes: hashes.slice(0, 2)}}})).document;
    const generated = [], tasks = [];
    let quoteModel = async () => JSON.stringify({floor: 2, quote: QUOTE, compatible: true});
    let summaryModel = async prompt => {
        const bounds = prompt.match(/完整覆盖第(\d+)至(\d+)层/); assert.ok(bounds);
        return JSON.stringify({slices: [{start: Number(bounds[1]), end: Number(bounds[2]), text: '新叙事继续追问信封去向，未增加已经知情的结论。'}],
            ...(requests === undefined ? {} : {recallRequests: requests})});
    };
    const context = {groupId: null, characterId: 0, characters: [{name: 'Recall', avatar: binding.avatar}],
        chatId: binding.file, chatMetadata: {integrity: binding.integrity}, chat: clone(messages), name1: '乙', mainApi: 'openai', maxContext: 65536,
        chatCompletionSettings: {chat_completion_source: 'custom', openai_max_context: 65536, openai_max_tokens: 1024, names_behavior: 0},
        getChatCompletionModel: () => 'synthetic-model', getTokenCountAsync: async value => Math.ceil(value.length / 3), setExtensionPrompt() {},
        async generateRaw(options) {
            const kind = options.prompt.startsWith('仅检查') ? 'extract' : 'summary'; generated.push({kind, ...clone(options)});
            return kind === 'extract' ? quoteModel(options.prompt) : summaryModel(options.prompt);
        }};
    const host = createHost({getContext: () => context});
    let sequence = 0;
    const controller = createController({host, api, defer: fn => tasks.push(fn), id: () => `runtime_${++sequence}`});
    const read = () => api.read(binding), rawDocument = async () => JSON.parse(await fs.readFile(path.join(account, '.yimu', chatStorageName(binding)), 'utf8')).value;
    const settings = async (values, global = false) => {
        const data = await read();
        if (global) await api.defaults({id: `setting_${++sequence}`, expectedRevision: data.defaults.revision, values});
        else await api.change(binding, {id: `setting_${++sequence}`, type: 'settings', expectedRevision: data.document.configRevision, values});
        await controller.refresh();
    };
    const edit = async (id, text) => {
        const current = (await read()).document.entries.find(entry => entry.id === id);
        return api.change(binding, {id: `edit_${++sequence}`, type: 'edit', entryId: id, expectedRevision: current.revision, text});
    };
    const inject = async () => {
        await controller.event('GENERATION_STARTED', ['normal', {}, false]);
        const core = clone(context.chat).map((message, index) => ({...message, index}));
        await controller.intercept(core, 65536, () => {}, 'normal');
        const payload = {type: 'normal', model: 'synthetic-model', chat_completion_source: 'custom', max_tokens: 1024,
            messages: [{role: 'system', content: 'synthetic character rules'}, ...core.map(message => ({role: message.is_user ? 'user' : 'assistant', content: message.mes}))]};
        const before = clone(payload);
        await controller.event('CHAT_COMPLETION_SETTINGS_READY', [payload]);
        return {payload, before, prompt: payload.messages.find(message => message.content.startsWith('<yimu_memory>'))?.content || ''};
    };
    t.after(async () => {
        controller.destroy(); const real = await fs.realpath(root);
        assert.equal(path.dirname(real), parent); assert.match(path.basename(real), /^yimu-recall-runtime-/);
        await fs.rm(real, {recursive: true});
    });
    await controller.refresh();
    return {api, store, controller, host, binding, context, read, rawDocument, writeChat, generated, calls, faults, settings, edit, inject,
        quoteModel: value => { quoteModel = value; }, summaryModel: value => { summaryModel = value; },
        async flush() { while (tasks.length) await tasks.shift()(); }};
}

const excerpts = data => data.document.entries.filter(entry => entry.kind === 'excerpt');
const sourceCalls = f => f.calls.filter(call => call.route === '/recall-source');
const recallWrites = f => f.calls.filter(call => call.route === '/change' && call.body.operation.type === 'recall');
const summaryCalls = f => f.generated.filter(call => call.kind === 'summary');
const extractionCalls = f => f.generated.filter(call => call.kind === 'extract');
const assertGoodSummary = data => assert.ok(data.document.entries.some(entry => entry.kind === 'summary' && entry.source.start === 3 && entry.status === 'active'));

test('recall full loop scopes originals, persists only a pointer, materializes on read and joins only the next final request', async t => {
    const f = await fixture(t), original = clone(f.context.chat);
    await f.controller.start({force: true});
    assert.equal(summaryCalls(f).length, 1); assert.equal(extractionCalls(f).length, 1);
    assert.equal(sourceCalls(f).length, 1); assert.equal(recallWrites(f).length, 1);
    const source = sourceCalls(f)[0];
    assert.equal(source.body.request.parentId, 'old_fine'); assert.equal(source.body.request.parentRevision, 1);
    assert.deepEqual(source.result.messages.map(message => message.floor), [1, 2]);
    assert.equal(source.body.request.triggerSource.start, 3);
    const data = await f.read(), [excerpt] = excerpts(data); assertGoodSummary(data); assert.ok(excerpt);
    assert.equal(excerpt.quoteText, QUOTE); assert.equal(excerpt.quoteSpeaker, '甲');
    assert.equal(excerpt.parent.id, 'old_fine'); assert.deepEqual([excerpt.source.start, excerpt.source.end], [2, 2]);
    const stored = await f.rawDocument(), pointer = stored.entries.find(entry => entry.id === excerpt.id);
    assert.equal(stored.schema, SCHEMA); assert.equal(pointer.text, '原文补充');
    assert.equal(pointer.quoteText, undefined); assert.equal(pointer.quoteSpeaker, undefined);
    assert.ok(!JSON.stringify(stored).includes(QUOTE), 'operation receipts and history must not persist the original quotation');
    assert.equal(f.controller.state.lastUsed, null);
    const result = await f.inject();
    assert.ok(result.prompt.includes(QUOTE)); assert.match(result.prompt, /原文引证，不是新增事实或共同知识/);
    assert.ok(f.controller.state.lastUsed.entries.some(entry => entry.id === excerpt.id && entry.quoteText === QUOTE));
    assert.deepEqual(f.controller.state.lastUsed.recentFloors, [8, 9, 10, 11, 12]);
    assert.deepEqual(f.context.chat, original); assert.deepEqual(result.payload.messages.slice(-5), result.before.messages.slice(-5));
});

test('one background start may process several fine batches but performs at most one scoped extraction', async t => {
    const f = await fixture(t, {floors: 15, longFloors: true}); await f.settings({batch: 1800});
    await f.controller.start({force: true});
    assert.ok(summaryCalls(f).length >= 2); assert.equal(sourceCalls(f).length, 1); assert.equal(extractionCalls(f).length, 1);
    assert.equal(recallWrites(f).length, 1); assert.equal(excerpts(await f.read()).length, 1);
    assert.ok(summaryCalls(f).slice(1).every(call => !call.prompt.includes('可回查的旧细摘要目录')));
});

for (const mode of ['chat false', 'global false']) test(`old ${mode} still saves normal summaries without reading or extracting originals`, async t => {
    const f = await fixture(t); await f.settings({recall: false}, mode === 'global false');
    await f.controller.start({force: true});
    assert.equal(sourceCalls(f).length, 0); assert.equal(extractionCalls(f).length, 0); assert.equal(recallWrites(f).length, 0);
    assertGoodSummary(await f.read()); assert.ok(summaryCalls(f).every(call => !call.prompt.includes('可回查的旧细摘要目录')));
});

for (const [name, requests] of [['no request', []], ['two requests', [REQUEST, REQUEST]], ['unlisted ID', [{...REQUEST, parentId: 'not_in_catalog'}]]]) {
    test(`${name} causes no extra original read or model call and preserves valid normal summaries`, async t => {
        const f = await fixture(t, {requests}); await f.controller.start({force: true});
        assert.equal(sourceCalls(f).length, 0); assert.equal(extractionCalls(f).length, 0); assert.equal(recallWrites(f).length, 0);
        assertGoodSummary(await f.read());
    });
}

for (const [name, output] of [
    ['not literally in the source', {floor: 2, quote: '乙已经知道信封在哪里。', compatible: true}],
    ['outside the scoped floor', {floor: 3, quote: QUOTE, compatible: true}],
    ['not confirmed compatible', {floor: 2, quote: QUOTE, compatible: false}],
    ['only a fragment of a complete paragraph', {floor: 2, quote: '没有告诉乙。', compatible: true}],
    ['explicitly no evidence', {quote: null}],
]) test(`an extraction ${name} cannot create an excerpt or erase good summaries`, async t => {
    const f = await fixture(t); f.quoteModel(async () => JSON.stringify(output)); await f.controller.start({force: true});
    assert.equal(extractionCalls(f).length, 1); assert.equal(recallWrites(f).length, 0);
    const data = await f.read(); assert.equal(excerpts(data).length, 0); assertGoodSummary(data);
    assert.equal(f.controller.state.error, '');
});

test('an exact quotation occurring twice in one scoped floor remains ambiguous and is not persisted', async t => {
    const f = await fixture(t, {ambiguous: true}); await f.controller.start({force: true});
    assert.equal(extractionCalls(f).length, 1); assert.equal(recallWrites(f).length, 0);
    assert.equal(excerpts(await f.read()).length, 0); assertGoodSummary(await f.read());
});

test('existing manual authority blocks automatic recall without stopping normal summary work', async t => {
    const f = await fixture(t); await f.edit('old_fine', '人工确认：信封的归属尚未确定，不自动补全。'); await f.controller.refresh();
    await f.controller.start({force: true});
    assert.equal(sourceCalls(f).length, 0); assert.equal(extractionCalls(f).length, 0); assertGoodSummary(await f.read());
});

test('a remote manual correction while extraction is pending rejects its late result without undoing completed summaries', async t => {
    const f = await fixture(t), started = deferred(), answer = deferred();
    f.quoteModel(() => { started.resolve(); return answer.promise; });
    const job = f.controller.start({force: true}); await started.promise;
    await f.edit('old_fine', '人工确认：不能沿用该旧说明。');
    answer.resolve(JSON.stringify({floor: 2, quote: QUOTE, compatible: true})); await job;
    const data = await f.read(); assert.equal(excerpts(data).length, 0); assertGoodSummary(data);
    assert.equal(data.document.entries.find(entry => entry.id === 'old_fine').text, '人工确认：不能沿用该旧说明。');
    assert.equal(extractionCalls(f).length, 1);
});

for (const action of ['disable chat', 'disable recall', 'switch chat', 'start generation']) test(`${action} while extracting discards the late result and does not stop normal chat`, async t => {
    const f = await fixture(t), started = deferred(), answer = deferred();
    f.quoteModel(() => { started.resolve(); return answer.promise; });
    const job = f.controller.start({force: true}); await started.promise;
    if (action === 'disable chat') await f.controller.action('enable', {enabled: false});
    if (action === 'disable recall') await f.controller.action('settings', {values: {recall: false}, global: false});
    if (action === 'switch chat') { f.context.chatId = 'Other synthetic story'; f.context.chatMetadata = {integrity: 'other_synthetic_identity'}; await f.controller.refresh(); }
    if (action === 'start generation') { await f.controller.event('GENERATION_STARTED', ['normal', {}, false]); await f.controller.settled(); }
    answer.resolve(JSON.stringify({floor: 2, quote: QUOTE, compatible: true})); await job;
    assert.equal(recallWrites(f).length, 0); const data = await f.read(); assert.equal(excerpts(data).length, 0); assertGoodSummary(data);
    if (action === 'disable chat') assert.equal(data.document.enabled, false);
    if (action === 'disable recall') assert.equal(data.document.settings.recall, false);
});

test('editing the source during extraction cannot attach a quote to a newer source version', async t => {
    const f = await fixture(t), started = deferred(), answer = deferred();
    f.quoteModel(() => { started.resolve(); return answer.promise; }); const job = f.controller.start({force: true}); await started.promise;
    f.context.chat[1].mes = '新版本原文已没有原来的句子。'; await f.writeChat();
    answer.resolve(JSON.stringify({floor: 2, quote: QUOTE, compatible: true})); await job;
    assert.equal(recallWrites(f).length, 0); assert.equal(excerpts(await f.read()).length, 0); assertGoodSummary(await f.read());
});

test('a chat-change event while scoped reading is pending cancels extraction before the debounced refresh finishes', async t => {
    const f = await fixture(t), gate = {started: deferred(), release: deferred()}; f.faults.sourceGate = gate;
    const job = f.controller.start({force: true}); await gate.started.promise;
    f.context.chatId = 'Other synthetic story'; f.context.chatMetadata = {integrity: 'other_synthetic_identity'};
    await f.controller.event('CHAT_CHANGED'); gate.release.resolve(); await job;
    assert.equal(extractionCalls(f).length, 0, 'the old story must not start an extra model call from the newly selected chat context');
    assert.equal(recallWrites(f).length, 0); assertGoodSummary(await f.read());
});

test('a chat change while the normal summary is pending cannot start a new extraction from its late recall request', async t => {
    const f = await fixture(t), started = deferred(), answer = deferred();
    f.summaryModel(prompt => { started.resolve(prompt.match(/完整覆盖第(\d+)至(\d+)层/)); return answer.promise; });
    const job = f.controller.start({force: true}), bounds = await started.promise;
    f.context.chatId = 'Other synthetic story'; f.context.chatMetadata = {integrity: 'other_synthetic_identity'};
    await f.controller.event('CHAT_CHANGED');
    answer.resolve(JSON.stringify({slices: [{start: Number(bounds[1]), end: Number(bounds[2]), text: '完成且来源未变的旧聊天摘要。'}], recallRequests: [REQUEST]}));
    await job;
    assert.equal(extractionCalls(f).length, 0, 'the recall ticket must belong to the summary run, not be renewed after a chat-change event');
    assert.equal(recallWrites(f).length, 0);
});

for (const fault of ['source', 'recallWrite']) test(`${fault} network failure leaves completed fine summaries intact and does not automatically retry`, async t => {
    const f = await fixture(t); f.faults[fault] = true; await f.controller.start({force: true}); await f.flush();
    assert.equal(sourceCalls(f).length, 1); assert.equal(extractionCalls(f).length, fault === 'source' ? 0 : 1);
    assert.equal(recallWrites(f).length, fault === 'source' ? 0 : 1);
    assert.equal(excerpts(await f.read()).length, 0); assertGoodSummary(await f.read());
    await f.controller.start({force: true}); assert.equal(sourceCalls(f).length, 1);
});

test('a lost successful recall receipt is confirmed by reading once, not by posting the quotation twice', async t => {
    const f = await fixture(t); f.faults.loseRecallReply = true; await f.controller.start({force: true});
    assert.equal(recallWrites(f).length, 1); assert.equal(excerpts(await f.read()).length, 1); assertGoodSummary(await f.read());
});

test('an excerpt edited into a manual record and deleted still counts once toward its original parent quota', async t => {
    const f = await fixture(t); await f.controller.start({force: true}); let data = await f.read();
    const [first] = excerpts(data), triggerSource = sourceCalls(f)[0].body.request.triggerSource;
    const source = await f.api.recallSource(f.binding, {parentId: 'old_fine', parentRevision: 1,
        expectedEpoch: data.document.epoch, expectedDefaultsRevision: data.defaults.revision, triggerSource});
    await f.api.change(f.binding, {id: 'quota_second', type: 'recall', entryId: 'second_excerpt', expectedRevision: source.documentRevision,
        expectedEpoch: data.document.epoch, expectedDefaultsRevision: data.defaults.revision, parent: source.parent, triggerSource,
        quote: {floor: 1, text: f.context.chat[0].mes}});
    await f.edit(first.id, '用户对这条原文补充的人工修订，随后决定删除。'); data = await f.read();
    const manual = data.document.entries.find(entry => entry.id === first.id);
    assert.equal(manual.kind, 'manual');
    await f.api.change(f.binding, {id: 'quota_delete_manual', type: 'entry', entryId: first.id, expectedRevision: manual.revision, action: 'delete'});
    data = await f.read();
    assert.equal(recallBlockReason(data.document), '', 'the check must exercise quota rather than an unrelated active-manual blocker');
    const records = excerptRecords(data.document, 'old_fine');
    assert.equal(new Set(records.map(entry => entry.id)).size, 2);
    assert.ok(records.length > 2, 'an invalidated second excerpt also has history, which must not be double-counted');
    const hashes = await fingerprintMessages(f.context.chat), settings = {...data.defaults.values, ...data.document.settings};
    assert.ok(!recallCandidates(data.document, settings, f.context.chat, {start: 3, end: 7}, hashes).some(entry => entry.id === 'old_fine'));
    const oneSlot = {...data.document, entries: data.document.entries.filter(entry => entry.id !== first.id)};
    assert.equal(new Set(excerptRecords(oneSlot, 'old_fine').map(entry => entry.id)).size, 1);
    assert.ok(recallCandidates(oneSlot, settings, f.context.chat, {start: 3, end: 7}, hashes).some(entry => entry.id === 'old_fine'),
        'multiple historical versions of one pointer consume one slot, not two');
    const sourceReadsBefore = sourceCalls(f).length, extractsBefore = extractionCalls(f).length;
    f.context.chat.push({name: '乙', is_user: true, mes: '第十三层：继续讨论此前的信封。', send_date: '2026-10-25T13:00:00Z'});
    await f.writeChat(); await f.controller.refresh(); await f.controller.start({force: true});
    assert.equal(sourceCalls(f).length, sourceReadsBefore); assert.equal(extractionCalls(f).length, extractsBefore);
});

for (const action of ['exclude', 'delete']) test(`${action} keeps a valid quotation readable for management without reactivating or injecting it`, async t => {
    const f = await fixture(t); await f.controller.start({force: true});
    const [excerpt] = excerpts(await f.read());
    await f.api.change(f.binding, {id: `manage_${action}`, type: 'entry', entryId: excerpt.id, expectedRevision: excerpt.revision, action});
    const data = await f.read(), item = data.document.entries.find(entry => entry.id === excerpt.id);
    assert.equal(item.status, action === 'exclude' ? 'excluded' : 'deleted');
    assert.equal(item.quoteText, QUOTE, 'inactive management records must not pretend the valid source is missing');
    const plan = await buildPlan(data.document, data.defaults, await f.host.snapshot());
    assert.ok(!plan.entries.some(entry => entry.id === excerpt.id));
    const stored = await f.rawDocument(); assert.equal(stored.entries.find(entry => entry.id === excerpt.id).quoteText, undefined);
});

test('a previously saved excerpt is not materialized from changed source and remains absent from the next request', async t => {
    const f = await fixture(t); await f.controller.start({force: true}); const [excerpt] = excerpts(await f.read());
    f.context.chat[1].mes = '源楼层已经改写，没有旧的引文。'; await f.writeChat();
    const data = await f.read(), item = data.document.entries.find(entry => entry.id === excerpt.id);
    assert.equal(item.quoteText, undefined); assert.ok(data.invalidSourceIds.includes(excerpt.id));
    const plan = await buildPlan(data.document, data.defaults, await f.host.snapshot());
    assert.ok(!plan.entries.some(entry => entry.id === excerpt.id)); assertGoodSummary(data);
});

test('final admission requires the excerpt parent, gives the excerpt no raw-removal coverage and can omit it alone for budget', async t => {
    const f = await fixture(t); await f.controller.start({force: true}); const data = await f.read(), [excerpt] = excerpts(data);
    const snapshot = await f.host.snapshot(), parent = data.document.entries.find(entry => entry.id === excerpt.parent.id);
    const core = clone(snapshot.messages).map((message, index) => ({...message, index}));
    const {processed} = captureCore(core, snapshot, {namesBehavior: 0, userName: '乙'}), hashes = await fingerprintMessages(snapshot.messages);
    const payload = {type: 'normal', model: 'synthetic-model', chat_completion_source: 'custom', max_tokens: 1024,
        messages: [{role: 'system', content: 'synthetic character'}, ...processed.map(item => item.request)]};
    const options = {processed, sourceHashes: hashes, recent: 5, contextTokens: 65536, responseTokens: 1024, budget: 8192};
    const alone = await buildBudgetedMessages(payload, {...options, entries: [excerpt]});
    assert.equal(alone.applied, false); assert.deepEqual(alone.removedFloors, []);
    const together = await buildBudgetedMessages(payload, {...options, entries: [parent, excerpt]});
    assert.deepEqual(together.entries.map(entry => entry.id), [parent.id, excerpt.id]);
    assert.deepEqual(together.removedFloors, [1, 2]);
    const small = await buildBudgetedMessages(payload, {...options, budget: byteBudget([memoryMessage([parent])]), entries: [parent, excerpt]});
    assert.deepEqual(small.entries.map(entry => entry.id), [parent.id]); assert.deepEqual(small.removedFloors, [1, 2]);
    const plan = await buildPlan(data.document, data.defaults, snapshot);
    assert.deepEqual(plan.coveredRanges, plan.entries.filter(entry => entry.kind !== 'excerpt').map(entry => entry.source));
});

test('an already saved excerpt may accompany its valid stage reading layer without reactivating automatic recall', async t => {
    const f = await fixture(t); await f.controller.start({force: true}); let data = await f.read();
    const fine = data.document.entries.filter(entry => entry.kind === 'summary'), [excerpt] = excerpts(data);
    await f.api.change(f.binding, {id: 'stage_saved', type: 'append', expectedEpoch: data.document.epoch, expectedDefaultsRevision: data.defaults.revision,
        entry: {id: 'stage_saved', kind: 'stage', text: '两人再次讨论信封，但此前未公开的细节仍未变成共同知识。',
            source: {parents: fine.map(entry => ({id: entry.id, revision: entry.revision}))}}});
    await f.settings({recall: false}); data = await f.read();
    const plan = await buildPlan(data.document, data.defaults, await f.host.snapshot());
    assert.deepEqual(plan.entries.map(entry => entry.id), ['stage_saved', excerpt.id]);
    const callsBefore = f.generated.length, result = await f.inject();
    assert.match(result.prompt, /stage_saved/); assert.ok(result.prompt.includes(QUOTE));
    assert.deepEqual(f.controller.state.lastUsed.removedFloors, [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(f.generated.length, callsBefore, 'using an existing supplement cannot schedule another recall call');
});
