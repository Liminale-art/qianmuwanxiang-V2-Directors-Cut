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
        const delayed = route === '/change' ? faults.delayChangeReply : route === '/read' ? faults.delayReadReply : null;
        if (delayed) {
            if (route === '/change') faults.delayChangeReply = null; else faults.delayReadReply = null;
            delayed.started.resolve(); await delayed.release.promise;
        }
        if (route === '/change' && faults.loseChangeReply) { faults.loseChangeReply = false; throw new Error('合成回执丢失'); }
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
    };
    const inject = async ({finish = true, transform = null} = {}) => {
        await controller.event('GENERATION_STARTED', ['normal', {}, false]);
        const coreChat = clone(context.chat).map((message, index) => ({...message, index}));
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
        assert.equal(f.controller.state.defaults, null);
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
