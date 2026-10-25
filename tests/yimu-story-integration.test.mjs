import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createYimuStore} from '../yimu/server-store.mjs';
import {registerYimuRoutes} from '../yimu/server-plugin.mjs';
import {createApi} from '../yimu/client.mjs';
import {createHost} from '../yimu/host.mjs';
import {createController} from '../yimu/runtime.mjs';
import {fingerprintMessages} from '../yimu/contract.mjs';

test('full isolated story loop uses real client routes, server creation, native-open adapter and inherited next request', async t => {
    const base = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(base, 'yimu-story-loop-'));
    t.after(async () => {const real = await fs.realpath(root); assert.equal(path.dirname(real), base); assert.match(path.basename(real), /^yimu-story-loop-/); await fs.rm(real, {recursive: true});});
    const account = path.join(root, 'account'), chats = path.join(account, 'chats'), folder = path.join(chats, 'Actor');
    await fs.mkdir(folder, {recursive: true});
    const binding = {avatar: 'Actor.png', file: 'source', integrity: 'source-integrity'};
    const messages = Array.from({length: 12}, (_, i) => ({name: 'Actor', is_user: false, is_system: false, mes: `原文${i + 1}：测试中的约定。`, send_date: `date-${i}`}));
    const metadata = {integrity: binding.integrity};
    const sourcePath = path.join(folder, 'source.jsonl');
    const original = [{chat_metadata: metadata}, ...messages].map(JSON.stringify).join('\n'); await fs.writeFile(sourcePath, original);
    const request = {user: {profile: {handle: 'fixture'}, directories: {root: account, chats}}};
    const store = createYimuStore({hostCwd: root}), routes = new Map();
    registerYimuRoutes({get: (url, fn) => routes.set(`GET ${url}`, fn), post: (url, fn) => routes.set(`POST ${url}`, fn)}, {store});
    const readRows = async file => (await fs.readFile(path.join(folder, `${file}.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
    const fetcher = async (url, options) => {
        const body = options.body ? JSON.parse(options.body) : null;
        if (url === '/api/chats/get') return {ok: true, status: 200, json: () => readRows(body.file_name)};
        const route = routes.get(`${options.method} ${url.replace('/api/plugins/yimu', '')}`); assert.ok(route, url);
        let status = 200, value;
        await route({...request, body}, {status(number) {status = number; return this;}, json(result) {value = structuredClone(result);}});
        return {ok: status < 400, status, json: async () => value};
    };
    const api = createApi({fetcher, headers: () => ({})});
    await api.change(binding, {id: 'enable', type: 'enable', expectedRevision: 0, enabled: true, range: {start: 1, end: 12, total: 12}});
    await api.change(binding, {id: 'memory', type: 'append', expectedEpoch: 1, entry: {id: 'early', kind: 'summary', text: '前七层的有效约定。', source: {start: 1, end: 7, hashes: (await fingerprintMessages(messages)).slice(0, 7)}}});
    let opens = 0;
    const context = {groupId: null, characterId: 0, characters: [{name: 'Actor', avatar: binding.avatar}], chatId: 'source', chatMetadata: metadata,
        chat: structuredClone(messages), mainApi: 'openai', name1: 'User',
        chatCompletionSettings: {chat_completion_source: 'custom', openai_max_context: 32000, openai_max_tokens: 1000, names_behavior: 0},
        getChatCompletionModel: () => 'fixture', getRequestHeaders: () => ({}),
        async openCharacterChat(file) {opens++; const rows = await readRows(file); this.chatId = file; this.chatMetadata = rows[0].chat_metadata; this.chat = rows.slice(1);},
        async generateRaw() {throw new Error('No real or fixture model needed for fully covered continuation');}};
    const host = createHost({getContext: () => context, fetcher});
    let id = 0;
    const controller = createController({host, api, id: () => `loop_${++id}`, defer: () => {}}); t.after(() => controller.destroy());
    await controller.refresh();
    const plan = await controller.action('storyPlan', {mode: 'continue'});
    assert.equal(plan.cutoff, 12); assert.equal(plan.boundaries.length, 0);
    const created = await controller.action('storyCreate', {manualChoices: []});
    assert.equal(created.receipt.status, 'complete'); assert.equal(opens, 1);
    assert.equal(context.chatId, created.binding.file); assert.equal(context.chat.length, 5);
    assert.deepEqual(context.chat.map(item => item.mes), messages.slice(7).map(item => item.mes));
    assert.equal(controller.state.document.enabled, true);
    assert.equal(controller.state.document.entries[0].originVerified, true);
    assert.equal(await fs.readFile(sourcePath, 'utf8'), original);
    await controller.event('GENERATION_STARTED', ['normal', {}, false]);
    const core = structuredClone(context.chat).map((message, index) => ({...message, index}));
    await controller.intercept(core, 32000, () => {});
    const payload = {type: 'normal', model: 'fixture', chat_completion_source: 'custom', max_tokens: 1000,
        messages: [{role: 'system', content: '角色设定'}, ...core.map(item => ({role: 'assistant', content: item.mes}))]};
    await controller.event('CHAT_COMPLETION_SETTINGS_READY', [payload]);
    assert.ok(payload.messages.some(item => item.content.includes('前七层的有效约定。')));
    assert.deepEqual(controller.state.lastUsed.removedFloors, []);
    assert.deepEqual(payload.messages.filter(item => item.role === 'assistant').map(item => item.content), messages.slice(7).map(item => item.mes));
});
