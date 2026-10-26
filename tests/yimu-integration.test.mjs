import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createYimuStore} from '../yimu/server-store.mjs';
import {registerYimuRoutes} from '../yimu/server-plugin.mjs';
import {createApi} from '../yimu/client.mjs';
import {createController} from '../yimu/runtime.mjs';
import {createHost, MEMORY_PROMPT_KEY} from '../yimu/host.mjs';
import {effectiveSettings, fingerprintMessages} from '../yimu/contract.mjs';
import {summaryPrompt} from '../yimu/core.mjs';
import {summaryRequestBudget} from '../yimu/budget.mjs';

const clone = value => structuredClone(value);
const binding = {avatar: 'Integration.png', file: 'Synthetic-chat', integrity: 'integration_identity'};
const messages = Array.from({length: 7}, (_, i) => ({name: i % 2 ? '角色' : '用户', is_user: !(i % 2),
    mes: `合成原文第 ${i + 1} 层。` + '只有已告知的事实才是角色所知。重要经历保留，未告知的秘密不推定知情。'.repeat(20), send_date: `2026-10-25T10:0${i}:00.000Z`}));
const deferredValue = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
};

async function fixture(t) {
    const parent = await fs.realpath(os.tmpdir());
    const root = await fs.mkdtemp(path.join(parent, 'yimu-integration-test-'));
    const account = path.join(root, 'account');
    const chats = path.join(account, 'chats');
    await fs.mkdir(path.join(chats, 'Integration'), {recursive: true});
    const request = {user: {profile: {handle: 'fixture'}, directories: {root: account, chats}}};
    const writeChat = async (items = messages, identity = binding.integrity, name = binding.file) => fs.writeFile(
        path.join(chats, 'Integration', `${name}.jsonl`), [{chat_metadata: {integrity: identity}}, ...items].map(JSON.stringify).join('\n'), 'utf8');
    await writeChat();
    const store = createYimuStore({hostCwd: root});
    const routes = new Map(), faults = {loseChangeReply: false, failRead: false, delayChangeReply: null, delayReadReply: null};
    registerYimuRoutes({get(route, fn) { routes.set(`GET ${route}`, fn); }, post(route, fn) { routes.set(`POST ${route}`, fn); }}, {store});
    const fetcher = async (url, options) => {
        const route = `/${url.split('/').at(-1)}`;
        if (route === '/read' && faults.failRead) throw new Error('合成读取故障');
        let status = 200, body;
        const response = {status(value) { status = value; return this; }, json(value) { body = clone(value); return this; }};
        await routes.get(`${options.method} ${route}`)({...request, body: options.body ? JSON.parse(options.body) : undefined}, response);
        const delayed = route === '/change' ? faults.delayChangeReply : route === '/read' ? faults.delayReadReply : route === '/defaults' && options.method === 'POST' ? faults.delayDefaultsReply : null;
        if (delayed) {
            if (route === '/change') faults.delayChangeReply = null; else if (route === '/read') faults.delayReadReply = null; else faults.delayDefaultsReply = null;
            delayed.started.resolve(); await delayed.release.promise;
        }
        if (route === '/change' && faults.loseChangeReply) { faults.loseChangeReply = false; throw new Error('合成回执丢失'); }
        if (route === '/defaults' && options.method === 'POST' && faults.loseDefaultsReply) { faults.loseDefaultsReply = false; throw new Error('合成默认设置回执丢失'); }
        return {ok: status >= 200 && status < 300, status, json: async () => clone(body)};
    };
    const api = createApi({fetcher, headers: () => ({'X-CSRF-Token': 'synthetic-only'})});
    const prompts = new Map(), tasks = [];
    let generated = 0, model = async prompt => {
        const match = prompt.match(/完整覆盖第(\d+)至(\d+)层/);
        assert.ok(match, 'fixture model receives a bounded original range');
        return JSON.stringify({slices: [{start: Number(match[1]), end: Number(match[2]), text: '已确认的合成经历。秘密仍只有实际得知的人知晓。'}]});
    };
    const context = {
        groupId: null, characterId: 0, characters: [{name: 'Integration', avatar: binding.avatar}],
        chatId: binding.file, chatMetadata: {integrity: binding.integrity}, chat: clone(messages), maxContext: 65536,
        mainApi: 'openai', name1: '用户',
        chatCompletionSettings: {chat_completion_source: 'custom', openai_max_context: 65536, openai_max_tokens: 1024, names_behavior: 0},
        getChatCompletionModel: () => 'fixture-model', getTokenCountAsync: async text => Math.ceil(text.length / 3),
        setExtensionPrompt(key, prompt) { prompts.set(key, prompt); },
        async generateRaw({prompt}) { generated++; return model(prompt); },
    };
    const host = createHost({getContext: () => context});
    let nextId = 0;
    const controller = createController({host, api, defer: fn => tasks.push(fn), id: () => `fixture_${++nextId}`});
    t.after(async () => {
        controller.destroy();
        const real = await fs.realpath(root);
        assert.equal(path.dirname(real), parent);
        assert.match(path.basename(real), /^yimu-integration-test-/);
        await fs.rm(real, {recursive: true});
    });
    const flush = async () => { while (tasks.length) await tasks.shift()(); };
    const enable = async () => {
        await controller.refresh();
        await controller.action('enable', {enabled: true, range: {start: 1, end: context.chat.length, total: context.chat.length}});
        await controller.action('autoSummary', {value: true});
    };
    const inject = async ({finish = true, transform = null} = {}) => {
        await controller.event('GENERATION_STARTED', ['normal', {}, false]);
        const coreChat = clone(context.chat).filter(message => !message.is_system).map((message, index) => ({...message, index}));
        await controller.intercept(coreChat, 65536, () => {}, 'normal');
        const payload = {type: 'normal', model: 'fixture-model', chat_completion_source: 'custom', max_tokens: 1024,
            messages: [{role: 'system', content: '合成角色设定'}, ...coreChat.map(message => ({role: message.is_user ? 'user' : 'assistant', content: message.mes}))]};
        if (transform) transform(payload);
        const originalPayload = clone(payload);
        await controller.event('GENERATE_AFTER_DATA', [{prompt: payload.messages}, false]);
        if (finish) await controller.event('CHAT_COMPLETION_SETTINGS_READY', [payload]);
        const prompt = payload.messages.find(message => message.content.includes('<yimu_memory>'))?.content || '';
        return {coreChat, prompt, payload, originalPayload};
    };
    return {root, account, chats, request, writeChat, store, api, faults, context, host, controller, tasks, flush, enable, inject,
        prompts, model: value => { model = value; }, generated: () => generated};
}

test('single-chat loop: explicit enable, fixture summary, durable save, next prompt, manual edit, and off', async t => {
    const f = await fixture(t);
    await f.enable();
    assert.equal(f.controller.state.document.enabled, true);
    assert.equal(f.generated(), 0, 'enabling does not block on model completion');
    await f.flush();
    assert.equal(f.generated(), 1);
    const saved = (await f.api.read(binding)).document;
    assert.equal(saved.entries.length, 1);
    assert.deepEqual([saved.entries[0].source.start, saved.entries[0].source.end], [1, 2]);
    const {coreChat, prompt, payload} = await f.inject();
    assert.ok(prompt.includes(saved.entries[0].text));
    assert.equal(coreChat.length, messages.length, 'interception retains the original core chat');
    assert.deepEqual(f.controller.state.lastUsed.removedFloors, [1, 2]);
    assert.deepEqual(payload.messages.filter(message => message.role !== 'system').map(message => message.content), messages.slice(2).map(message => message.mes));
    assert.equal(f.controller.state.lastUsed.entries.length, 1);
    await f.controller.action('edit', {entryId: saved.entries[0].id, text: '人工确认的合成修订，不允许自动覆盖。'});
    assert.equal((await f.api.read(binding)).document.entries[0].edited, true);
    assert.ok((await f.inject()).prompt.includes('人工确认的合成修订'));
    await f.controller.action('enable', {enabled: false});
    assert.equal((await f.api.read(binding)).document.enabled, false);
    assert.equal((await f.api.read(binding)).document.entries.length, 1);
    assert.equal((await f.inject()).prompt, '');
});

test('lost save acknowledgement is checked once and never repeats the completed mutation', async t => {
    const f = await fixture(t);
    await f.controller.refresh();
    f.faults.loseChangeReply = true;
    assert.equal(await f.controller.action('manual', {text: '保存成功但回执丢失的人工补充'}), true);
    const read = await f.api.read(binding);
    assert.equal(read.document.entries.length, 1);
    assert.equal(read.document.revision, 1);
    assert.equal(f.controller.state.document.entries.length, 1);
});

test('server source unavailability preserves stored memory but does not inject or call the fixture model', async t => {
    const f = await fixture(t);
    await f.enable();
    await f.flush();
    await fs.unlink(path.join(f.chats, 'Integration', `${binding.file}.jsonl`));
    await f.controller.refresh();
    assert.equal(f.controller.state.sourceAvailable, false);
    assert.equal(f.controller.state.document.entries.length, 1);
    await f.controller.start({force: true});
    assert.equal(f.generated(), 1);
    assert.equal((await f.inject()).prompt, '');
});

test('late fixture generation after disabling cannot append memory or resume another job', async t => {
    const f = await fixture(t);
    const answer = deferredValue(), started = deferredValue();
    f.model(async () => { started.resolve(); return answer.promise; });
    await f.enable();
    const job = f.flush();
    await started.promise;
    await f.controller.action('enable', {enabled: false});
    answer.resolve(JSON.stringify({slices: [{start: 1, end: 2, text: '不应被迟到采纳'}]}));
    await job;
    const saved = await f.api.read(binding);
    assert.equal(saved.document.enabled, false);
    assert.equal(saved.document.entries.length, 0);
    assert.equal(f.prompts.get(MEMORY_PROMPT_KEY), '');
});

test('cross-device disable is reread before injection instead of trusting the browser cache', async t => {
    const f = await fixture(t);
    await f.enable();
    await f.flush();
    const old = (await f.api.read(binding)).document;
    await f.store.change(f.request, binding, {id: 'remote_off', type: 'enable', enabled: false, expectedRevision: old.configRevision});
    assert.equal(f.controller.state.document.enabled, true, 'fixture starts with stale browser state');
    assert.equal((await f.inject()).prompt, '');
    assert.equal(f.controller.state.document.enabled, false);
});

test('a partial global settings edit preserves earlier connection and preference choices', async t => {
    const f = await fixture(t);
    await f.controller.refresh();
    await f.controller.action('settings', {global: true, values: {profileId: 'chosen_profile', model: 'chosen_model', preference: '关注关系改变'}});
    await f.controller.action('settings', {global: true, values: {recent: 9}});
    const defaults = (await f.api.read(binding)).defaults;
    assert.equal(defaults.values.recent, 9);
    assert.equal(defaults.values.profileId, 'chosen_profile');
    assert.equal(defaults.values.model, 'chosen_model');
    assert.equal(defaults.values.preference, '关注关系改变');
});

test('API failures display factual backend messages rather than internal error codes', async () => {
    const api = createApi({fetcher: async () => ({ok: false, status: 409, json: async () => ({error: 'yimu_source_changed', message: '对应聊天原文已改变，未采用整理结果'})})});
    await assert.rejects(api.read(binding), /对应聊天原文已改变/);
});

test('a save acknowledgement arriving after switching chats cannot leave the new chat busy or claim its save succeeded', async t => {
    const f = await fixture(t);
    await f.controller.refresh();
    const delayed = {started: deferredValue(), release: deferredValue()};
    f.faults.delayChangeReply = delayed;
    const saving = f.controller.action('manual', {text: '只属于旧聊天的修改'});
    await delayed.started.promise;
    const next = {...binding, file: 'Second-chat', integrity: 'second_identity'};
    await f.writeChat(messages, next.integrity, next.file);
    f.context.chatId = next.file; f.context.chatMetadata.integrity = next.integrity;
    await f.controller.refresh();
    delayed.release.resolve();
    await saving;
    assert.equal(f.controller.state.snapshot.binding.file, next.file);
    assert.equal(f.controller.state.document.entries.length, 0);
    assert.equal(f.controller.state.busy, false);
    assert.notEqual(f.controller.state.status, '已保存');
    assert.equal((await f.api.read(binding)).document.entries.length, 1);
});

test('a slow old refresh cannot replace a newer confirmed save in the same chat', async t => {
    const f = await fixture(t);
    await f.controller.refresh();
    const delayed = {started: deferredValue(), release: deferredValue()};
    f.faults.delayReadReply = delayed;
    const refreshing = f.controller.refresh({quiet: true});
    await delayed.started.promise;
    await f.controller.action('manual', {text: '刷新在途时已保存的新内容'});
    assert.equal(f.controller.state.document.entries.length, 1);
    delayed.release.resolve();
    await refreshing;
    assert.equal(f.controller.state.document.entries.length, 1);
    assert.equal(f.controller.state.document.entries[0].text, '刷新在途时已保存的新内容');
});

test('stale browser originals cannot reactivate a disk-invalidated slice while an unaffected slice remains usable', async t => {
    const f = await fixture(t);
    f.model(async () => JSON.stringify({slices: [
        {start: 1, end: 1, text: '旧第一层记忆应停止使用'},
        {start: 2, end: 2, text: '第二层记忆仍有效'},
    ]}));
    await f.enable(); await f.flush();
    assert.equal(f.controller.state.document.entries.length, 2);
    await f.writeChat([{...messages[0], mes: '由另一设备修改了第一层，浏览器仍未重读聊天'}, ...messages.slice(1)]);
    assert.equal(f.context.chat[0].mes, messages[0].mes, 'browser fixture intentionally retains its old original');
    const injected = await f.inject();
    assert.ok(injected.prompt.includes('第二层记忆仍有效'));
    assert.ok(!injected.prompt.includes('旧第一层记忆应停止使用'));
    const stored = (await f.api.read(binding)).document;
    assert.equal(stored.entries[0].status, 'invalid');
    assert.equal(stored.entries[1].status, 'active');
});

test('remote defaults changes while the fixture model is running discard the old-policy result', async t => {
    const f = await fixture(t);
    const answer = deferredValue(), started = deferredValue();
    f.model(async () => { started.resolve(); return answer.promise; });
    await f.enable();
    const job = f.flush();
    await started.promise;
    const prior = (await f.api.read(binding)).defaults;
    await f.store.defaults(f.request, {id: 'remote_policy_change', expectedRevision: prior.revision, values: {...prior.values, preference: '新的人工整理偏好'}});
    answer.resolve(JSON.stringify({slices: [{start: 1, end: 2, text: '不应接受旧整理策略的迟到输出'}]}));
    await job;
    assert.equal((await f.api.read(binding)).document.entries.length, 0);
    assert.match(f.controller.state.error, /设置|策略|默认/);
});

test('ST rename still transfers memory when its new chat name is loaded before CHAT_RENAMED fires', async t => {
    const f = await fixture(t);
    await f.controller.refresh();
    await f.controller.action('manual', {text: '改名前保留的人工记忆'});
    const renamed = {...binding, file: 'Renamed-before-event'};
    await fs.rename(path.join(f.chats, 'Integration', `${binding.file}.jsonl`), path.join(f.chats, 'Integration', `${renamed.file}.jsonl`));
    f.context.chatId = renamed.file;
    await f.controller.refresh();
    assert.equal(f.controller.state.snapshot.binding.file, renamed.file);
    assert.equal(f.controller.state.document.entries.length, 0, 'the new path initially has no independent memory document');
    await f.controller.event('CHAT_RENAMED', [{oldFileName: binding.file, newFileName: renamed.file, avatarId: binding.avatar}]);
    await f.controller.refresh();
    assert.equal(f.controller.state.document.entries[0].text, '改名前保留的人工记忆');
    assert.deepEqual(f.controller.state.document.binding, renamed);
    const retained = await f.api.read(binding);
    assert.deepEqual(retained.document.movedTo, renamed);
    assert.equal(retained.document.entries[0].text, '改名前保留的人工记忆');
    assert.equal(retained.sourceAvailable, false);
});

test('leaving the loaded single chat for a group or home page clears its visible memory state', async t => {
    const f = await fixture(t);
    await f.controller.refresh();
    await f.controller.action('manual', {text: '不能残留在首页或群聊中的角色资料'});
    for (const destination of ['group', 'home']) {
        f.context.groupId = null; f.context.characterId = 0;
        await f.controller.refresh();
        assert.equal(f.controller.state.document.entries.length, 1);
        if (destination === 'group') f.context.groupId = 'synthetic_group';
        else f.context.characterId = undefined;
        await f.controller.refresh();
        assert.equal(f.controller.state.snapshot, null);
        assert.equal(f.controller.state.document, null);
        assert.ok(f.controller.state.defaults, 'homepage retains only account defaults, never a previous chat document');
        assert.equal(f.controller.state.lastUsed, null);
        assert.equal(f.controller.state.sourceAvailable, false);
        assert.equal(f.prompts.get(MEMORY_PROMPT_KEY), '');
    }
    assert.equal((await f.api.read(binding)).document.entries.length, 1, 'navigation never deletes saved memories');
});

test('latest-request diagnostics require the complete final memory payload and retain an immutable used snapshot', async t => {
    const f = await fixture(t);
    await f.enable(); await f.flush();
    await f.inject();
    assert.equal(f.controller.state.lastUsed.entries.length, 1);
    const second = await f.inject({finish: false});
    assert.equal(f.controller.state.lastUsed, null, 'new foreground generation clears the preceding request record');
    const unsupported = {messages: [{role: 'user', content: '最终请求不包含忆幕资料'}]};
    await f.controller.event('CHAT_COMPLETION_SETTINGS_READY', [unsupported]);
    assert.equal(f.controller.state.lastUsed, null);
    await f.controller.event('GENERATE_AFTER_DATA', [{prompt: '文本模式请求没有可验证边界'}]);
    assert.equal(f.controller.state.lastUsed, null, 'truncated or candidate-only content is not complete prompt proof');
    await f.controller.event('CHAT_COMPLETION_SETTINGS_READY', [second.payload]);
    assert.equal(f.controller.state.lastUsed, null, 'text-mode fallback expires the prepared session');
    await f.inject();
    const used = clone(f.controller.state.lastUsed);
    assert.equal(used.entries.length, 1);
    await f.controller.action('edit', {entryId: used.entries[0].id, text: '请求组装之后的新修订'});
    assert.equal(f.controller.state.document.entries[0].text, '请求组装之后的新修订');
    assert.deepEqual(f.controller.state.lastUsed, used, 'diagnostics keep the actual earlier request snapshot, not the latest edited row');
});

test('insufficient final-request capacity leaves every original message and latest-use diagnostics untouched', async t => {
    const f = await fixture(t);
    await f.enable(); await f.flush();
    f.context.chatCompletionSettings.openai_max_context = 1100;
    const result = await f.inject();
    assert.deepEqual(result.payload, result.originalPayload);
    assert.equal(result.prompt, '');
    assert.equal(f.controller.state.lastUsed, null);
    assert.deepEqual(f.context.chat, messages);
});

test('disabling after interception expires the prepared final payload without removing source text', async t => {
    const f = await fixture(t);
    await f.enable(); await f.flush();
    const result = await f.inject({finish: false});
    await f.controller.action('enable', {enabled: false});
    await f.controller.event('CHAT_COMPLETION_SETTINGS_READY', [result.payload]);
    assert.deepEqual(result.payload, result.originalPayload);
    assert.equal(f.controller.state.lastUsed, null);
});

test('fine summaries become a durable stage and the next actual request substitutes it only for covered old floors', async t => {
    const f = await fixture(t);
    f.model(async () => JSON.stringify({slices: [
        {start: 1, end: 1, text: '第一层保留的重要相遇。'},
        {start: 2, end: 2, text: '第二层形成了尚未履行的约定。'},
    ]}));
    await f.enable(); await f.flush();
    f.model(async () => JSON.stringify({text: '相遇之后形成了尚未履行的约定。'}));
    await f.controller.action('stage', {start: 1, end: 2}); await f.flush();
    const saved = (await f.api.read(binding)).document;
    assert.equal(saved.entries.filter(entry => entry.kind === 'summary').length, 2);
    const stage = saved.entries.find(entry => entry.kind === 'stage');
    assert.ok(stage);
    await f.controller.action('settings', {global: true, values: {recall: false}});
    const result = await f.inject();
    assert.ok(result.prompt.includes(stage.text));
    assert.ok(!result.prompt.includes(saved.entries[0].text));
    assert.deepEqual(f.controller.state.lastUsed.entries.map(entry => entry.id), [stage.id]);
    assert.deepEqual(f.controller.state.lastUsed.removedFloors, [1, 2]);
    assert.deepEqual(result.payload.messages.filter(message => message.role !== 'system').map(message => message.content), messages.slice(2).map(message => message.mes));
    assert.deepEqual(f.context.chat, messages, 'original ST chat is never replaced or mutated');
});

async function manualReady(f) {
    await f.controller.refresh();
    await f.controller.action('enable', {enabled: true});
    await f.flush();
}
async function manualRange(f, start, end, expectedRange = {start, end}) {
    await f.controller.action('summarizeRange', {range: {start, end}, expectedRange});
    await f.flush();
}

test('manual-only range works without enabling automatic work and stored memory still joins the next request', async t => {
    const f = await fixture(t); await manualReady(f);
    assert.equal(f.generated(), 0);
    assert.equal(f.controller.state.document.autoSummary, false);
    await manualRange(f, 1, 2);
    const saved = (await f.api.read(binding)).document;
    assert.equal(f.generated(), 1); assert.equal(saved.autoSummary, false); assert.equal(saved.enabled, true);
    assert.deepEqual(saved.entries.map(e => [e.source.start, e.source.end]), [[1, 2]]);
    assert.equal(saved.initialRange, null, 'manual work does not silently choose initial history');
    const result = await f.inject();
    assert.ok(result.prompt.includes(saved.entries[0].text));
    assert.deepEqual(f.controller.state.lastUsed.removedFloors, [1, 2]);
    assert.deepEqual(result.payload.messages.filter(message => message.role !== 'system').map(message => message.content), messages.slice(2).map(message => message.mes));
    await f.controller.start(); assert.equal(f.generated(), 1, 'background work stays off');
});

test('master-off rejects manual/auto/history model jobs instead of silently turning memory on', async t => {
    const f = await fixture(t); await f.controller.refresh();
    for (const [action, payload] of [
        ['autoSummary', {value: true}], ['summarizeRange', {range: {start: 1, end: 2}, expectedRange: {start: 1, end: 2}}],
        ['history', {range: {start: 1, end: 7, total: 7}}], ['summarize', {}],
    ]) await assert.rejects(f.controller.action(action, payload), /先启用/);
    await f.flush(); assert.equal(f.generated(), 0); assert.equal(f.controller.state.document.enabled, false);
});

test('history confirmation fills only selected old floors with auto off and cancellation stays dismissed after reload', async t => {
    const f = await fixture(t); await manualReady(f);
    await f.controller.action('history', {range: {start: 1, end: 6, total: 7}}); await f.flush();
    assert.equal(f.generated(), 1); assert.equal(f.controller.state.document.autoSummary, false);
    assert.deepEqual(f.controller.state.document.entries.map(e => [e.source.start, e.source.end]), [[1, 2]], 'five recent originals remain untouched');
    const other = await fixture(t); await manualReady(other);
    await other.controller.action('history', {range: {start: 1, end: 0, total: 7}}); await other.flush();
    await other.controller.refresh();
    assert.deepEqual(other.controller.state.document.initialRange, {start: 1, end: 0, total: 7});
    assert.equal(other.generated(), 0);
    await manualRange(other, 1, 2); assert.equal(other.generated(), 1, 'cancelled initial history remains available through explicit manual work');
});

test('history containing only recent originals finishes with a factual state rather than a permanent pending label', async t => {
    const f = await fixture(t); f.context.chat = clone(messages.slice(0, 3));
    await f.writeChat(f.context.chat); await manualReady(f);
    await f.controller.action('history', {range: {start: 1, end: 3, total: 3}}); await f.flush();
    assert.equal(f.generated(), 0); assert.equal(f.controller.state.document.entries.length, 0);
    assert.equal(f.controller.state.status, '所选楼层保留为近期原文，暂不整理');
});

test('hidden original floors are summarized without unhiding them and only actual visible prompt rows are removed', async t => {
    const f = await fixture(t); f.context.chat[0].is_system = true;
    await f.writeChat(f.context.chat); await manualReady(f);
    const original = clone(f.context.chat);
    await manualRange(f, 1, 2);
    assert.equal(f.generated(), 1); assert.equal(f.controller.state.document.entries.length, 1);
    assert.deepEqual(f.context.chat, original);
    const result = await f.inject();
    assert.ok(result.prompt.includes(f.controller.state.document.entries[0].text));
    assert.deepEqual(f.controller.state.lastUsed.removedFloors, [2]);
    assert.deepEqual(result.payload.messages.slice(-5).map(message => message.content), messages.slice(-5).map(message => message.mes));
});

test('manual partial overlap requires visible expanded bounds, replaces whole automatic slices and preserves outside memory', async t => {
    const f = await fixture(t); await manualReady(f);
    await manualRange(f, 1, 3); await manualRange(f, 4, 5); await manualRange(f, 6, 7);
    const before = clone(f.controller.state.document.entries), count = f.generated();
    await assert.rejects(f.controller.action('summarizeRange', {range: {start: 2, end: 4}, expectedRange: {start: 2, end: 4}}), /1—5/);
    assert.equal(f.generated(), count);
    f.model(async prompt => {
        const m = prompt.match(/完整覆盖第(\d+)至(\d+)层/);
        return JSON.stringify({slices: [{start: Number(m[1]), end: Number(m[2]), text: '明确重整后的完整切片。'}]});
    });
    await manualRange(f, 2, 4, {start: 1, end: 5});
    const after = f.controller.state.document.entries;
    assert.equal(f.generated(), count + 2);
    assert.deepEqual(after.map(e => [e.id, e.source.start, e.source.end]), before.map(e => [e.id, e.source.start, e.source.end]));
    assert.equal(after[0].text, '明确重整后的完整切片。'); assert.equal(after[1].text, '明确重整后的完整切片。');
    assert.deepEqual(after[2], before[2]);
});

test('manual overwrite keeps hand revisions as the active version and stores the generated result for a choice', async t => {
    const f = await fixture(t); await manualReady(f); await manualRange(f, 1, 2);
    const entry = f.controller.state.document.entries[0];
    await f.controller.action('edit', {entryId: entry.id, text: '用户修订：两人仍有隔阂，并未和解。'});
    await manualRange(f, 1, 2);
    const saved = f.controller.state.document.entries[0];
    assert.equal(saved.text, '用户修订：两人仍有隔阂，并未和解。');
    assert.equal(saved.edited, true); assert.ok(saved.candidate?.text); assert.equal(saved.status, 'active');
});

test('manual range respects deletion/exclusion choices rather than resurrecting them', async t => {
    const f = await fixture(t); await manualReady(f); await manualRange(f, 1, 2);
    const entry = f.controller.state.document.entries[0], before = f.generated();
    await f.controller.action('entry', {entryId: entry.id, action: 'delete'});
    await assert.rejects(f.controller.action('summarizeRange', {range: {start: 1, end: 2}, expectedRange: {start: 1, end: 2}}), /已删除/);
    await f.flush(); assert.equal(f.generated(), before); assert.equal(f.controller.state.document.entries[0].status, 'deleted');
});

test('failed manual re-summary leaves the existing slice intact and does not retry automatically', async t => {
    const f = await fixture(t); await manualReady(f); await manualRange(f, 1, 2);
    const before = clone(f.controller.state.document.entries);
    f.model(async () => { throw new Error('synthetic model failure'); });
    await manualRange(f, 1, 2);
    assert.deepEqual(f.controller.state.document.entries, before);
    assert.match(f.controller.state.error, /synthetic model failure/);
    const count = f.generated(); await f.controller.start(); assert.equal(f.generated(), count);
});

test('manual range batches continuously until complete without using or removing recent originals early', async t => {
    const f = await fixture(t);
    f.context.chat = f.context.chat.map((message, i) => ({...message, mes: `第${i + 1}层` + '原文'.repeat(140)}));
    await f.writeChat(f.context.chat); await manualReady(f);
    await f.controller.action('settings', {values: {trigger: 256}}); await f.flush();
    await manualRange(f, 1, 7);
    assert.equal(f.generated(), 7);
    assert.deepEqual(f.controller.state.document.entries.map(e => [e.source.start, e.source.end]), Array.from({length: 7}, (_, i) => [i + 1, i + 1]));
    const result = await f.inject();
    assert.deepEqual(f.controller.state.lastUsed.removedFloors, [1, 2]);
    assert.deepEqual(result.payload.messages.slice(-5).map(message => message.content), f.context.chat.slice(-5).map(message => message.mes));
});

test('stopping a redo preserves the chat switch and original slice, discards late output and requires an explicit new attempt', async t => {
    const f = await fixture(t); await f.enable(); await f.flush();
    const entry = clone(f.controller.state.document.entries[0]);
    const answer = deferredValue(), started = deferredValue();
    f.model(async () => { started.resolve(); return answer.promise; });
    await f.controller.action('redo', {entryId: entry.id});
    const running = f.tasks.shift()(); await started.promise;
    assert.equal(f.controller.state.activeEntryId, entry.id); assert.equal(f.controller.state.busy, true);
    assert.equal(await f.controller.action('stop', {entryId: entry.id}), true);
    assert.equal(f.controller.state.busy, false); assert.equal(f.controller.state.document.enabled, true);
    assert.equal(f.controller.state.document.autoSummary, true); assert.equal(f.controller.state.failedWork, null);
    answer.resolve(JSON.stringify({slices: [{start: 1, end: 2, text: '停止后返回的结果不能保存'}]}));
    await running; await f.flush(); await f.controller.start(); await f.controller.startStage();
    assert.deepEqual((await f.api.read(binding)).document.entries[0], entry);
    assert.equal(f.generated(), 2, 'no background restart or retry after stop');
    assert.equal(f.controller.state.error, '');
    f.model(async () => JSON.stringify({slices: [{start: 1, end: 2, text: '用户再次明确开始的新版'}]}));
    await f.controller.action('redo', {entryId: entry.id}); await f.flush();
    assert.equal(f.generated(), 3); assert.equal(f.controller.state.document.entries[0].text, '用户再次明确开始的新版');
});

test('a threshold needing multiple admitted batches keeps its frozen range despite new arriving floors', async t => {
    const f = await fixture(t); await f.controller.refresh();
    await f.controller.action('enable', {enabled: true, range: {start: 1, end: 0, total: 7}});
    await f.controller.action('autoSummary', {value: true});
    await f.controller.action('settings', {values: {recent: 1, trigger: 600}});
    f.context.chat.push(...Array.from({length: 4}, (_, index) => ({name: '角色', mes: '文'.repeat(300), send_date: `later-${index}`})));
    await f.writeChat(f.context.chat); await f.controller.refresh();
    const settings = effectiveSettings(f.controller.state.document, f.controller.state.defaults);
    const contextTokens = summaryRequestBudget(summaryPrompt(f.context.chat, {start: 8, end: 8}, settings)) + 356;
    f.host.summaryConnection = () => ({mode: 'external', contextTokens, maxTokens: 256});
    const seen = [], started = deferredValue(), release = deferredValue();
    f.host.generate = async prompt => {
        const match = prompt.match(/完整覆盖第(\d+)至(\d+)层/), start = Number(match[1]), end = Number(match[2]);
        seen.push([start, end]); if (seen.length === 1) { started.resolve(); await release.promise; }
        return JSON.stringify({slices: [{start, end, text: '本批有据经历'}]});
    };
    const running = f.controller.start(); await started.promise;
    f.context.chat.push({name: '角色', mes: '新'.repeat(300), send_date: 'arrived-1'}, {name: '角色', mes: '新'.repeat(300), send_date: 'arrived-2'});
    await f.writeChat(f.context.chat); release.resolve(); await running;
    assert.deepEqual(seen, [[8, 8], [9, 9]]);
    assert.deepEqual(f.controller.state.document.entries.map(entry => [entry.source.start, entry.source.end]), [[8, 8], [9, 9]]);
});

test('homepage prompts use read-only defaults, confirm a lost write receipt and reject a stale concurrent save', async t => {
    const f = await fixture(t); f.context.characterId = undefined; await f.controller.refresh();
    assert.equal(f.controller.state.document, null); assert.equal(f.controller.state.defaults.revision, 0);
    assert.deepEqual(await fs.readdir(path.join(f.account, '.yimu')), [], 'opening the homepage creates no chat or settings file');
    const prompts = clone(f.controller.state.defaults.values.prompts); prompts.groups.summary[0].text += '\n合成的用户偏好。';
    f.faults.loseDefaultsReply = true;
    assert.equal(await f.controller.action('settings', {global: true, expectedRevision: 0, values: {prompts}}), true);
    assert.equal(f.controller.state.defaults.revision, 1); assert.equal(f.controller.state.error, '');
    assert.deepEqual(f.controller.state.defaults.values.prompts, prompts);
    await assert.rejects(f.controller.action('settings', {global: true, expectedRevision: 0, values: {trigger: 9999}}));
    assert.equal((await f.api.defaults()).defaults.values.trigger, 50000);
    assert.deepEqual((await fs.readdir(path.join(f.account, '.yimu'))).filter(file => file !== 'defaults.json'), []);
});

test('a late homepage save cannot clear a newly opened chat error or overwrite its visible defaults', async t => {
    const f = await fixture(t); f.context.characterId = undefined; await f.controller.refresh();
    const delayed = {started: deferredValue(), release: deferredValue()}; f.faults.delayDefaultsReply = delayed;
    const saving = f.controller.action('settings', {global: true, expectedRevision: 0, values: {trigger: 9999}});
    await delayed.started.promise; f.context.characterId = 0; await f.controller.refresh();
    await assert.rejects(f.controller.action('stage', {start: 1, end: 2}), /启用忆幕/);
    const error = f.controller.state.error, defaults = clone(f.controller.state.defaults);
    delayed.release.resolve(); await saving;
    assert.equal(f.controller.state.error, error); assert.deepEqual(f.controller.state.defaults, defaults);
});

test('a defaults GET started without a chat cannot downgrade the next chat defaults or continue its old save', async t => {
    const f = await fixture(t); f.context.characterId = undefined;
    const readDefaults = f.api.defaults, started = deferredValue(), release = deferredValue(); let posts = 0;
    f.api.defaults = async operation => {
        if (operation) posts++;
        const result = await readDefaults(operation);
        if (!operation) { started.resolve(); await release.promise; }
        return result;
    };
    const saving = f.controller.action('settings', {global: true, values: {trigger: 9999}});
    await started.promise;
    for (let revision = 0; revision < 7; revision++) await readDefaults({id: `remote_defaults_${revision}`, expectedRevision: revision, values: {trigger: 10000 + revision}});
    f.context.characterId = 0; await f.controller.refresh();
    assert.equal(f.controller.state.defaults.revision, 7);
    release.resolve(); await assert.rejects(saving, /页面已变化/);
    assert.equal(f.controller.state.defaults.revision, 7); assert.equal(f.controller.state.defaults.values.trigger, 10006);
    assert.equal(posts, 0);
});

for (const mode of ['automatic', 'manual']) test(`${mode} Chinese summary batches pass the real ST 16k host admission without any network call`, async t => {
    const f = await fixture(t);
    f.context.chat = Array.from({length: 18}, (_, index) => ({name: '合成角色', mes: `第${index + 1}层` + '文'.repeat(1000), send_date: `long-${index}`}));
    f.context.chatCompletionSettings.openai_max_context = 16384; f.context.chatCompletionSettings.openai_max_tokens = 2048;
    await f.writeChat(f.context.chat);
    const prompts = [];
    f.model(async prompt => {
        prompts.push(prompt); const match = prompt.match(/完整覆盖第(\d+)至(\d+)层/);
        return JSON.stringify({slices: [{start: Number(match[1]), end: Number(match[2]), text: '对应范围的合成经历'}]});
    });
    if (mode === 'automatic') { await f.enable(); await f.flush(); }
    else { await manualReady(f); await manualRange(f, 1, 18); }
    assert.ok(prompts.length > 1, 'normal Chinese histories must be split before host admission, not rejected wholesale');
    assert.ok(prompts.every(prompt => summaryRequestBudget(prompt) + 2048 <= 16384));
    assert.equal(f.controller.state.error, '');
    const covered = f.controller.state.document.entries.flatMap(entry => Array.from({length: entry.source.end - entry.source.start + 1}, (_, index) => entry.source.start + index));
    assert.deepEqual(covered, Array.from({length: mode === 'automatic' ? 13 : 18}, (_, index) => index + 1));
});

test('automatic Chinese stages pass the real ST host budget while preserving the latest ten fine slices', async t => {
    const f = await fixture(t);
    f.context.chat = Array.from({length: 21}, (_, index) => ({name: '角色', mes: `合成原文${index + 1}`, send_date: `stage-${index}`}));
    f.context.chatCompletionSettings.openai_max_context = 16384; f.context.chatCompletionSettings.openai_max_tokens = 2048;
    await f.writeChat(f.context.chat); await f.enable();
    await f.controller.action('settings', {values: {stageAuto: true, stageBasis: 'tokens', stageThreshold: 1000}});
    const doc = f.controller.state.document, hashes = await fingerprintMessages(f.context.chat);
    for (let floor = 1; floor <= 16; floor++) await f.api.change(binding, {id: `stage_seed_${floor}`, type: 'append', expectedEpoch: doc.epoch,
        entry: {id: `stage_fine_${floor}`, kind: 'summary', text: '已'.repeat(1000), source: {start: floor, end: floor, hashes: [hashes[floor - 1]]}}});
    await f.controller.refresh(); const prompts = [];
    f.model(async prompt => { prompts.push(prompt); return JSON.stringify({text: '此范围的有据阶段经历'}); });
    await f.controller.startStage();
    assert.ok(prompts.length > 1); assert.ok(prompts.every(prompt => summaryRequestBudget(prompt) + 2048 <= 16384));
    assert.equal(f.controller.state.error, '');
    const refs = f.controller.state.document.entries.filter(entry => entry.kind === 'stage').flatMap(entry => entry.source.parents.map(ref => ref.id));
    assert.deepEqual(refs, Array.from({length: 6}, (_, index) => `stage_fine_${index + 1}`));
});

test('independent summary connection supplies its own safe context instead of inheriting a small ST window', async t => {
    const f = await fixture(t); await manualReady(f);
    const connection = {mode: 'external', profileId: '', model: 'synthetic-external', contextTokens: 32768, maxTokens: 2048, revision: 1};
    f.context.maxContext = 512;
    f.host.summaryConnection = () => connection;
    const calls = [];
    f.host.generate = async (prompt, options) => { calls.push(options); return JSON.stringify({slices: [{start: 1, end: 2, text: '独立连接范围验证。'}]}); };
    await manualRange(f, 1, 2);
    assert.equal(calls.length, 1); assert.deepEqual(calls[0].connection, connection);
    f.host.summaryConnection = () => ({...connection, contextTokens: 0});
    await assert.rejects(() => manualRange(f, 1, 2), /上下文/);
    assert.equal(calls.length, 1); assert.match(f.controller.state.error, /上下文/);
});

for (const queued of ['summarizeRange', 'summarize', 'history', 'redo', 'stage', 'autoSummary', 'enable', 'settings', 'refreshAuto', 'generationEnd']) {
    test(`queued ${queued} stays bound to the clicked chat and never starts in a newly opened chat`, async t => {
        const f = await fixture(t); await manualReady(f);
        await manualRange(f, 1, 1); await manualRange(f, 2, 2);
        const original = clone(f.controller.state.document), otherBinding = {...binding, file: 'Other-chat', integrity: 'other_chat_identity'};
        const otherMessages = [...clone(messages), ...clone(messages.slice(0, 6))];
        await f.writeChat(otherMessages, otherBinding.integrity, otherBinding.file);
        let other = (await f.api.change(otherBinding, {id: 'other_enable', type: 'enable', enabled: true, expectedRevision: 0,
            range: {start: 1, end: otherMessages.length, total: otherMessages.length}})).document;
        other = (await f.api.change(otherBinding, {id: 'other_auto', type: 'autoSummary', value: true, expectedRevision: other.configRevision})).document;
        for (const entry of original.entries) other = (await f.api.change(otherBinding, {id: `other_${entry.id}`, type: 'append', expectedEpoch: other.epoch,
            entry: {id: entry.id, kind: 'summary', text: entry.text, source: clone(entry.source)}})).document;
        const payloads = {
            summarizeRange: {range: {start: 1, end: 2}, expectedRange: {start: 1, end: 2}}, summarize: {},
            history: {range: {start: 1, end: 7, total: 7}}, redo: {entryId: original.entries[0].id}, stage: {start: 1, end: 2},
            autoSummary: {value: true}, enable: {enabled: true}, settings: {values: {preference: '新的整理偏好'}},
        };
        const beforeCalls = f.generated();
        if (queued === 'refreshAuto') await f.controller.refresh({auto: true});
        else if (queued === 'generationEnd') await f.controller.event('GENERATION_ENDED');
        else await f.controller.action(queued, payloads[queued]);
        assert.ok(f.tasks.length, 'the action has actually queued work');
        f.context.chatId = otherBinding.file; f.context.chatMetadata.integrity = otherBinding.integrity; f.context.chat = otherMessages;
        await f.controller.refresh(); await f.flush();
        assert.equal(f.generated(), beforeCalls, 'neither the old job nor a replacement job may start after the chat switch');
        assert.deepEqual((await f.api.read(otherBinding)).document, other);
    });
}

test('queued manual work also checks the live host identity when no chat-change event or refresh has arrived yet', async t => {
    const f = await fixture(t); await manualReady(f);
    await f.controller.action('summarizeRange', {range: {start: 1, end: 2}, expectedRange: {start: 1, end: 2}});
    f.context.chatId = 'not-yet-refreshed';
    await f.flush();
    assert.equal(f.generated(), 0); assert.equal((await f.api.read(binding)).document.entries.length, 0);
});

test('starting a new generation expires a queued manual task even when the chat identity stays the same', async t => {
    const f = await fixture(t); await manualReady(f);
    await f.controller.action('summarizeRange', {range: {start: 1, end: 2}, expectedRange: {start: 1, end: 2}});
    await f.controller.event('GENERATION_STARTED', ['normal', {}, false]); await f.controller.settled(); await f.flush();
    assert.equal(f.generated(), 0); assert.equal((await f.api.read(binding)).document.entries.length, 0);
});

test('an action awaiting a host snapshot cannot apply its old-chat settings to the next chat', async t => {
    const f = await fixture(t); await f.controller.refresh();
    const originalSnapshot = f.host.snapshot;
    let release, entered;
    const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    f.host.snapshot = async () => { f.host.snapshot = originalSnapshot; entered(); await gate; return originalSnapshot(); };
    const rejected = assert.rejects(f.controller.action('settings', { values: { recent: 3 }, expectedRevision: 0 }), /当前聊天已变化/);
    await ready;
    const other = { ...binding, file: 'Other-action-chat', integrity: 'other_action_identity' };
    await f.writeChat(messages, other.integrity, other.file);
    f.context.chatId = other.file; f.context.chatMetadata.integrity = other.integrity;
    await f.controller.refresh(); release(); await rejected;
    assert.deepEqual((await f.api.read(other)).document.settings, {});
    assert.deepEqual((await f.api.read(binding)).document.settings, {}); assert.equal(f.generated(), 0);
});

test('failed stage work retries the same stage rather than starting a new fine-summary model call', async t => {
    const f = await fixture(t); await manualReady(f);
    await manualRange(f, 1, 1); await manualRange(f, 2, 2);
    f.model(async () => { throw Error('合成阶段网络中断'); });
    await f.controller.action('stage', { start: 1, end: 2, expectedRange: { start: 1, end: 2 } }); await f.flush();
    assert.equal(f.controller.state.failedWork.kind, 'stage');
    const before = f.generated();
    f.model(async prompt => { assert.match(prompt, /阶段摘要/); assert.doesNotMatch(prompt, /完整覆盖第/); return JSON.stringify({text:'阶段已整理。'}); });
    await f.controller.action('retry'); await f.flush();
    assert.equal(f.generated(), before + 1); assert.equal(f.controller.state.error, ''); assert.equal(f.controller.state.failedWork, null);
    assert.equal(f.controller.state.document.entries.filter(entry => entry.kind === 'stage').length, 1);
});

test('a read failure after a completed stage never labels the already saved stage as failed work', async t => {
    const f = await fixture(t); await manualReady(f);
    await manualRange(f, 1, 1); await manualRange(f, 2, 2);
    f.model(async () => JSON.stringify({text:'已保存阶段。'}));
    const read = f.api.read, change = f.api.change;
    f.api.change = async (source, operation) => { const result = await change(source, operation); if (operation.entry?.kind === 'stage') f.api.read = async () => { throw Error('合成后续读取失败'); }; return result; };
    await f.controller.startStage({ force: true });
    assert.match(f.controller.state.error, /后续读取失败/); assert.equal(f.controller.state.failedWork, null);
    f.api.read = read;
    assert.equal((await f.api.read(binding)).document.entries.filter(entry => entry.kind === 'stage').length, 1);
    await assert.rejects(f.controller.action('retry'), /没有待重试/);
});

test('custom slices save a real insertion point and moved narrative order reaches the final request', async t => {
    const f = await fixture(t); await manualReady(f);
    f.model(async prompt => { const match = prompt.match(/完整覆盖第(\d+)至(\d+)层/); return JSON.stringify({slices:[{start:Number(match[1]),end:Number(match[2]),text:`独立片段${match[1]}的经历。`}]}); });
    await manualRange(f, 1, 1); await manualRange(f, 2, 2);
    const [one,two] = f.controller.state.document.entries;
    await f.controller.action('manual', { text: '用户确认的独立自定义片。', afterId: one.id });
    const custom = f.controller.state.document.entries.find(entry => entry.kind === 'manual');
    assert.equal(custom.placement.fromFloor, 1); assert.equal(custom.source, null);
    await f.controller.action('reorder', { entryOrder: [two.id, custom.id, one.id], movedId: custom.id, expectedRevision: f.controller.state.document.revision });
    assert.equal(f.controller.state.document.entries.find(entry => entry.id === custom.id).placement.fromFloor, 2);
    const result = await f.inject();
    assert.ok(result.prompt.includes('用户确认的独立自定义片。'));
    assert.ok(result.prompt.indexOf('独立片段2') < result.prompt.indexOf('用户确认的独立自定义片。'));
    assert.ok(result.prompt.indexOf('用户确认的独立自定义片。') < result.prompt.indexOf('独立片段1'));
    assert.deepEqual(f.controller.state.document.entries.find(entry => entry.id === one.id).source, one.source);
});
