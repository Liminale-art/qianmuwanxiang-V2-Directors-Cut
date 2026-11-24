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
import {buildBudgetedMessages, captureCore, tokenEstimate, memoryMessage} from '../yimu/budget.mjs';
import {recallCandidates} from '../yimu/recall.mjs';
import {excerptRecords, recallBlockReason} from '../yimu/recall-contract.mjs';
import {seedLegacyDefaults} from './helpers/yimu-legacy-defaults.mjs';
import {plantExcerpt} from './helpers/yimu-excerpt-fixture.mjs';

// Full local route/client/store/runtime/host flow with synthetic stories and model outputs.
// No browser, real account, server deployment, credentials or paid model calls.
// 「原文回查与补充」已去掉（用户 2026-11-24）：总结之后不再回查原文、不再新建摘录。这里验两件事：
// 总结链路无论模型回什么、旧设置写什么都不再发起回查；早先已存下的摘录照常读取、注入、屏蔽、删除与计数。
const clone = value => structuredClone(value);
const QUOTE = '甲把蓝色信封放进书桌第二格抽屉，没有告诉乙。';
const REQUEST = {parentId: 'old_fine', question: '蓝色信封当时放在哪里，乙是否已经知道？'};

async function fixture(t, {floors = 12, longFloors = false, legacyRecall = false} = {}) {
    const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'yimu-recall-runtime-'));
    const account = path.join(root, 'account'), chats = path.join(account, 'chats');
    const binding = {avatar: 'Recall.png', file: 'Synthetic-recall', integrity: 'synthetic_recall_identity'};
    const messages = Array.from({length: floors}, (_, i) => ({name: i % 2 ? '甲' : '乙', is_user: !(i % 2),
        mes: `第${i + 1}层：他们重新谈到蓝色信封。` + (longFloors && i > 1 && i < floors - 5 ? '叙事继续推进。'.repeat(100) : ''),
        send_date: `2026-10-25T12:${String(i).padStart(2, '0')}:00Z`}));
    messages[0].mes = '旧日的一封信改变了双方的约定；甲尚未作出说明。';
    messages[1].mes = `黄昏时，他们仍未说话。\n${QUOTE}\n这是那一晚的原文记录。`;
    await fs.mkdir(path.join(chats, 'Recall'), {recursive: true});
    const rawPath = path.join(chats, 'Recall', `${binding.file}.jsonl`);
    const writeChat = (items = context.chat) => fs.writeFile(rawPath, [{chat_metadata: {integrity: binding.integrity}}, ...items].map(JSON.stringify).join('\n'), 'utf8');
    await fs.writeFile(rawPath, [{chat_metadata: {integrity: binding.integrity}}, ...messages].map(JSON.stringify).join('\n'), 'utf8');
    const request = {user: {profile: {handle: 'synthetic-fixture'}, directories: {root: account, chats}}};
    // 旧账户里可能还存着「回查开着」：它不再有任何作用。
    await seedLegacyDefaults(account, legacyRecall ? {recall: true} : {});
    const store = createYimuStore({hostCwd: root}), routes = new Map(), calls = [];
    registerYimuRoutes({get(route, fn) { routes.set(`GET ${route}`, fn); }, post(route, fn) { routes.set(`POST ${route}`, fn); }}, {store});
    const fetcher = async (url, options) => {
        const route = `/${url.split('/').at(-1)}`, body = options.body ? JSON.parse(options.body) : undefined;
        const call = {route, body: clone(body)}; calls.push(call);
        let status = 200, value;
        const response = {status(next) { status = next; return this; }, json(next) { value = clone(next); return this; }};
        const handler = routes.get(`${options.method} ${route}`); assert.ok(handler, `registered ${route}`);
        await handler({...request, body}, response);
        call.status = status; call.result = clone(value);
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
    // 模型照旧可能回 recallRequests（旧提示词、旧习惯）：现在一律不理会。
    let summaryModel = async prompt => {
        const bounds = prompt.match(/完整覆盖第(\d+)至(\d+)层/); assert.ok(bounds);
        return JSON.stringify({slices: [{start: Number(bounds[1]), end: Number(bounds[2]), text: '新叙事继续追问信封去向，未增加已经知情的结论。'}], recallRequests: [REQUEST]});
    };
    const context = {groupId: null, characterId: 0, characters: [{name: 'Recall', avatar: binding.avatar}],
        chatId: binding.file, chatMetadata: {integrity: binding.integrity}, chat: clone(messages), name1: '乙', mainApi: 'openai', maxContext: 65536,
        chatCompletionSettings: {chat_completion_source: 'custom', openai_max_context: 65536, openai_max_tokens: 1024, names_behavior: 0},
        getChatCompletionModel: () => 'synthetic-model', getTokenCountAsync: async value => Math.ceil(value.length / 3), setExtensionPrompt() {},
        async generateRaw(options) {
            // 旧的原文提取请求以这句任务行开头；它不应再出现。
            const kind = options.prompt.includes('仅检查本次明确问题') ? 'extract' : 'summary'; generated.push({kind, ...clone(options)});
            assert.equal(kind, 'summary', 'no extraction call is ever made');
            return summaryModel(options.prompt);
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
    // 早先回查存下的一条摘录（第 2 层那句引文，挂在 old_fine 下）：直接写进资料，见 helpers/yimu-excerpt-fixture.mjs。
    const plant = async ({floor = 2, text = QUOTE, entryId = `planted_${++sequence}`} = {}) => {
        const entry = await plantExcerpt({account, binding, messages: context.chat, parentId: 'old_fine', floor, text, entryId});
        await controller.refresh();
        return entry;
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
    return {api, store, controller, host, binding, context, read, rawDocument, writeChat, generated, calls, settings, edit, inject, plant,
        summaryModel: value => { summaryModel = value; },
        async flush() { while (tasks.length) await tasks.shift()(); }};
}

const excerpts = data => data.document.entries.filter(entry => entry.kind === 'excerpt');
const sourceCalls = f => f.calls.filter(call => call.route === '/recall-source');
const recallWrites = f => f.calls.filter(call => call.route === '/change' && call.body.operation.type === 'recall');
const summaryCalls = f => f.generated.filter(call => call.kind === 'summary');
const assertGoodSummary = data => assert.ok(data.document.entries.some(entry => entry.kind === 'summary' && entry.source.start === 3 && entry.status === 'active'));

for (const [name, options, setup] of [
    ['default settings', {}, async () => {}],
    ['an old global recall-on value', {legacyRecall: true}, async () => {}],
    ['an old chat recall-on value', {}, f => f.settings({recall: true})],
]) test(`summaries with ${name} never offer a catalog, read originals or extract, even when the model returns a recall request`, async t => {
    const f = await fixture(t, options); await setup(f);
    await f.controller.start({force: true}); await f.flush();
    assertGoodSummary(await f.read());
    assert.ok(summaryCalls(f).length >= 1);
    assert.ok(summaryCalls(f).every(call => !call.prompt.includes('可回查的旧细摘要目录') && !call.prompt.includes('recallRequests')));
    assert.equal(sourceCalls(f).length, 0); assert.equal(recallWrites(f).length, 0);
    assert.equal(excerpts(await f.read()).length, 0);
    assert.equal(f.controller.state.retrieval.sourceRecall, false);
    assert.equal(f.controller.state.error, '');
});

test('several fine batches in one background start still make no recall call', async t => {
    const f = await fixture(t, {floors: 15, longFloors: true}); await f.settings({trigger: 1800}, true);
    await f.controller.start({force: true}); await f.flush();
    assert.ok(summaryCalls(f).length >= 2); assert.equal(sourceCalls(f).length, 0); assert.equal(recallWrites(f).length, 0);
    assert.equal(excerpts(await f.read()).length, 0);
});

test('a stored excerpt persists only a pointer, materializes on read and joins the next final request', async t => {
    const f = await fixture(t), original = clone(f.context.chat);
    await f.controller.start({force: true}); await f.flush();
    const planted = await f.plant();
    const data = await f.read(), [excerpt] = excerpts(data); assertGoodSummary(data); assert.ok(excerpt);
    assert.equal(excerpt.id, planted.id);
    assert.equal(excerpt.quoteText, QUOTE); assert.equal(excerpt.quoteSpeaker, '甲');
    assert.equal(excerpt.parent.id, 'old_fine'); assert.deepEqual([excerpt.source.start, excerpt.source.end], [2, 2]);
    const stored = await f.rawDocument(), pointer = stored.entries.find(entry => entry.id === excerpt.id);
    assert.equal(stored.schema, SCHEMA); assert.equal(pointer.text, '原文补充');
    assert.equal(pointer.quoteText, undefined); assert.equal(pointer.quoteSpeaker, undefined);
    assert.ok(!JSON.stringify(stored).includes(QUOTE), 'operation receipts and history must not persist the original quotation');
    const result = await f.inject();
    assert.ok(result.prompt.includes(QUOTE)); assert.match(result.prompt, /原文引证，不是新增事实或共同知识/);
    assert.ok(f.controller.state.lastUsed.entries.some(entry => entry.id === excerpt.id && entry.quoteText === QUOTE));
    assert.deepEqual(f.controller.state.lastUsed.recentFloors, [8, 9, 10, 11, 12]);
    assert.deepEqual(f.context.chat, original); assert.deepEqual(result.payload.messages.slice(-5), result.before.messages.slice(-5));
    assert.equal(sourceCalls(f).length, 0, 'using a stored excerpt reads no recall source');
});

test('an excerpt edited into a manual record and deleted still counts once toward its original parent quota', async t => {
    const f = await fixture(t); await f.controller.start({force: true}); await f.flush();
    const first = await f.plant({entryId: 'first_excerpt'});
    await f.plant({floor: 1, text: f.context.chat[0].mes, entryId: 'second_excerpt'});
    await f.edit(first.id, '用户对这条原文补充的人工修订，随后决定删除。'); let data = await f.read();
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
});

for (const action of ['exclude', 'delete']) test(`${action} keeps a valid quotation readable for management without reactivating or injecting it`, async t => {
    const f = await fixture(t); await f.controller.start({force: true}); await f.flush();
    const excerpt = await f.plant();
    await f.api.change(f.binding, {id: `manage_${action}`, type: 'entry', entryId: excerpt.id, expectedRevision: excerpt.revision, action});
    const data = await f.read(), item = data.document.entries.find(entry => entry.id === excerpt.id);
    assert.equal(item.status, action === 'exclude' ? 'excluded' : 'deleted');
    assert.equal(item.quoteText, QUOTE, 'inactive management records must not pretend the valid source is missing');
    const plan = await buildPlan(data.document, data.defaults, await f.host.snapshot());
    assert.ok(!plan.entries.some(entry => entry.id === excerpt.id));
    const stored = await f.rawDocument(); assert.equal(stored.entries.find(entry => entry.id === excerpt.id).quoteText, undefined);
});

test('a previously saved excerpt is not materialized from changed source and remains absent from the next request', async t => {
    const f = await fixture(t); await f.controller.start({force: true}); await f.flush();
    const excerpt = await f.plant();
    f.context.chat[1].mes = '源楼层已经改写，没有旧的引文。'; await f.writeChat();
    const data = await f.read(), item = data.document.entries.find(entry => entry.id === excerpt.id);
    assert.equal(item.quoteText, undefined); assert.ok(data.invalidSourceIds.includes(excerpt.id));
    const plan = await buildPlan(data.document, data.defaults, await f.host.snapshot());
    assert.ok(!plan.entries.some(entry => entry.id === excerpt.id)); assertGoodSummary(data);
});

test('final admission requires the excerpt parent, gives the excerpt no raw-removal coverage and can omit it alone for budget', async t => {
    const f = await fixture(t); await f.controller.start({force: true}); await f.flush();
    await f.plant();
    const data = await f.read(), [excerpt] = excerpts(data);
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
    const small = await buildBudgetedMessages(payload, {...options, budget: tokenEstimate([memoryMessage([parent])]), entries: [parent, excerpt]});
    assert.deepEqual(small.entries.map(entry => entry.id), [parent.id]); assert.deepEqual(small.removedFloors, [1, 2]);
    const plan = await buildPlan(data.document, data.defaults, snapshot);
    assert.deepEqual(plan.coveredRanges, plan.entries.filter(entry => entry.kind !== 'excerpt').map(entry => entry.source));
});

test('an already saved excerpt may accompany its valid stage reading layer without any recall call', async t => {
    const f = await fixture(t); await f.controller.start({force: true}); await f.flush();
    // 强制总结现在到「总层数 − 3」（第 3–9 层）为止；阶段总结不得含保留区原文，所以这里把正文保留层数设为 3（账户设置）。
    await f.settings({recent: 3}, true);
    const excerpt = await f.plant(); let data = await f.read();
    const fine = data.document.entries.filter(entry => entry.kind === 'summary');
    assert.deepEqual(fine.map(entry => [entry.source.start, entry.source.end]), [[1, 2], [3, 9]]);
    // 阶段写明了细切片里的蓝色信封与去向：正文问到的细节阶段已经答得上，所以不用细切片顶替（顶替自 2026-11-24 起始终生效）。
    await f.api.change(f.binding, {id: 'stage_saved', type: 'append', expectedEpoch: data.document.epoch, expectedDefaultsRevision: data.defaults.revision,
        entry: {id: 'stage_saved', kind: 'stage', text: '双方曾处理蓝色信封，新叙事继续追问信封去向；甲尚未告知乙，此前未公开的细节仍未变成共同知识。',
            source: {parents: fine.map(entry => ({id: entry.id, revision: entry.revision}))}}});
    await f.controller.refresh(); data = await f.read();
    const plan = await buildPlan(data.document, data.defaults, await f.host.snapshot());
    assert.deepEqual(plan.entries.map(entry => entry.id), ['stage_saved', excerpt.id]);
    const callsBefore = f.generated.length, result = await f.inject();
    assert.match(result.prompt, /stage_saved/); assert.ok(result.prompt.includes(QUOTE));
    assert.deepEqual(f.controller.state.lastUsed.removedFloors, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.equal(f.generated.length, callsBefore, 'using an existing supplement cannot schedule another model call');
    assert.equal(sourceCalls(f).length, 0);
});
