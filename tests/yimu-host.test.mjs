import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHost, MEMORY_PROMPT_KEY } from '../yimu/host.mjs';

function fixture() {
    const writes = [], rawCalls = [], profileCalls = [];
    let current = {
        groupId: null, characterId: 0, chatId: 'chapter-one',
        characters: [{ name: '角色甲', avatar: 'actor.png', chat: 'chapter-one' }],
        chatMetadata: { integrity: 'stable-chat-id' },
        mainApi: 'openai', maxContext: 8192,
        chat: Array.from({ length: 8 }, (_, index) => ({
            name: index % 2 ? '角色甲' : '用户', is_user: !(index % 2),
            mes: `第 ${index + 1} 层`, send_date: `2026-10-25T00:00:0${index}.000Z`,
            extra: { nested: { original: true } },
        })),
        setExtensionPrompt(...args) { writes.push(args); },
        async generateRaw(...args) { rawCalls.push(args); return '当前连接摘要'; },
        ConnectionManagerRequestService: {
            getSupportedProfiles() { return [{ id: 'p1', name: '摘要连接', model: 'model-a', api: 'openai', 'secret-id': 'never-expose', 'api-url': 'private-url' }]; },
            async sendRequest(...args) { profileCalls.push(args); return { content: '独立连接摘要', reasoning: 'not-content' }; },
        },
        eventSource: new EventEmitter(),
        eventTypes: Object.fromEntries([
            'CHAT_CHANGED', 'CHAT_LOADED', 'CHAT_RENAMED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED',
            'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED', 'MESSAGE_DELETED', 'MESSAGE_RECEIVED',
            'GENERATION_STARTED', 'GENERATION_STOPPED', 'GENERATION_ENDED', 'GENERATE_AFTER_DATA',
            'CHAT_COMPLETION_PROMPT_READY', 'CHAT_COMPLETION_SETTINGS_READY',
        ].map(key => [key, key.toLowerCase()])),
    };
    const errors = [];
    const host = createHost({ getContext: () => current, onError: error => errors.push(error) });
    return { host, writes, rawCalls, profileCalls, errors,
        get ctx() { return current; }, set ctx(value) { current = value; } };
}

function core(source, type = 'normal') {
    const result = structuredClone(source.messages.filter(message => !message.is_system));
    if (type === 'swipe') result.pop();
    return result.map((message, index) => ({ ...message, index }));
}

const plan = () => ({ prompt: '【忆幕】已核实记忆', coveredRanges: [{ start: 1, end: 3 }], memoryIds: ['memory-1'] });

test('snapshot returns full detached chat and stable binding without writing the chat', async () => {
    const f = fixture();
    f.ctx.saveChat = () => assert.fail('must not save original chat');
    f.ctx.saveMetadata = () => assert.fail('must not save original metadata');
    const snapshot = await f.host.snapshot();
    assert.deepEqual(snapshot.binding, { avatar: 'actor.png', file: 'chapter-one', integrity: 'stable-chat-id' });
    assert.equal(snapshot.name, '角色甲');
    assert.equal(snapshot.messages.length, 8);
    snapshot.messages[0].extra.nested.original = false;
    assert.equal(f.ctx.chat[0].extra.nested.original, true);
    f.ctx.chatId = 'chapter-two';
    assert.equal((await f.host.snapshot()).binding.file, 'chapter-two');
    assert.equal(f.writes.length, 0);
});

test('group, no chat and missing integrity fail readably without inventing an identity', async () => {
    const f = fixture();
    f.ctx.groupId = 'group';
    await assert.rejects(f.host.snapshot(), /仅支持单人聊天/);
    f.ctx.groupId = null;
    f.ctx.chatId = '';
    await assert.rejects(f.host.snapshot(), /先打开/);
    f.ctx.chatId = 'chapter-one';
    delete f.ctx.chatMetadata.integrity;
    await assert.rejects(f.host.snapshot(), /稳定的来源标识/);
    assert.deepEqual(f.ctx.chatMetadata, {});
});

test('prepare memory with scan off but never remove raw context without a hard reservation', async () => {
    const f = fixture(), snapshot = await f.host.snapshot(), target = core(snapshot);
    const beforeHost = structuredClone(f.ctx.chat), beforeCore = structuredClone(target);
    const result = f.host.inject(target, plan(), snapshot, 'normal');
    assert.equal(result.applied, true);
    assert.equal(result.reason, 'unreserved-context');
    assert.deepEqual(result.removedFloors, []);
    assert.deepEqual(target, beforeCore);
    assert.deepEqual(f.ctx.chat, beforeHost);
    assert.deepEqual(f.writes.at(-1), [MEMORY_PROMPT_KEY, plan().prompt, 1, 0, false, 0]);
    assert.equal(result.prepared.status, 'prepared');
    assert.equal(result.prepared.sourceReplacement, false);
    result.prepared.memoryIds.push('external');
    assert.deepEqual(f.host.prepared().memoryIds, ['memory-1']);
});

test('manual-only memory can prepare without claiming source coverage', async () => {
    const f = fixture(), snapshot = await f.host.snapshot();
    const result = f.host.inject(core(snapshot), { prompt: '人工补充', memoryIds: ['manual'] }, snapshot);
    assert.equal(result.applied, true);
    assert.deepEqual(result.prepared.coveredRanges, []);
    assert.deepEqual(result.prepared.removedFloors, []);
});

test('empty prompt explicitly clears memory and leaves the request unchanged', async () => {
    const f = fixture(), snapshot = await f.host.snapshot(), target = core(snapshot);
    f.host.inject(target, plan(), snapshot);
    const before = structuredClone(target);
    assert.equal(f.host.inject(target, { prompt: '  ' }, snapshot).reason, 'empty');
    assert.equal(f.writes.at(-1)[1], '');
    assert.equal(f.host.prepared(), null);
    assert.deepEqual(target, before);
});

test('hidden messages and swipe remain supported without treating filtered indices as source floors', async () => {
    const f = fixture();
    f.ctx.chat[1].is_system = true;
    const snapshot = await f.host.snapshot(), target = core(snapshot, 'swipe');
    assert.equal(target[1].mes, '第 3 层');
    assert.equal(target[1].index, 1);
    const result = f.host.inject(target, plan(), snapshot, 'swipe');
    assert.equal(result.applied, true);
    assert.equal(target.length, 6);
    assert.deepEqual(result.removedFloors, []);
});

test('quiet/raw/impersonate and a live original-chat reference never receive injected memory', async () => {
    const f = fixture(), snapshot = await f.host.snapshot();
    for (const type of ['quiet', 'raw', 'impersonate']) {
        assert.equal(f.host.inject(core(snapshot), plan(), snapshot, type).reason, 'unsupported-generation');
    }
    assert.equal(f.host.inject(f.ctx.chat, plan(), snapshot).reason, 'live-chat-reference');
    assert.equal(f.host.inject([...f.ctx.chat], plan(), snapshot).reason, 'live-chat-reference');
    assert.equal(f.host.inject({}, plan(), snapshot).reason, 'unverified-mapping');
    assert.equal(f.host.inject(null, plan(), snapshot).reason, 'unverified-mapping');
    assert.ok(f.writes.every(write => write[1] === ''));
});

test('tool messages remain a conservative fallback', async () => {
    const tools = fixture();
    tools.ctx.chat[2].extra.tool_invocations = [];
    const toolSnapshot = await tools.host.snapshot();
    assert.equal(tools.host.inject(core(toolSnapshot), plan(), toolSnapshot).reason, 'unsupported-tools');
    const f = fixture(), snapshot = await f.host.snapshot(), target = core(snapshot);
    target[0].tool_calls = [];
    assert.equal(f.host.inject(target, plan(), snapshot).reason, 'unsupported-tools');
    assert.ok(f.writes.every(write => write[1] === ''));
});

test('prompt-only regex, attachment expansion and other extensions do not disable additive memory', async () => {
    for (const mutation of [
        target => { target[0].mes = 'ST 正则转换后的正文'; },
        target => { target[0].mes += '\n附件正文'; },
        target => { target[0].mes += '别的插件修改'; },
        target => { target.pop(); },
        target => { target.reverse(); },
        target => { target[0].index = 9; },
    ]) {
        const f = fixture(), snapshot = await f.host.snapshot(), target = core(snapshot);
        mutation(target);
        const before = structuredClone(target), original = structuredClone(f.ctx.chat);
        const result = f.host.inject(target, plan(), snapshot);
        assert.equal(result.applied, true);
        assert.deepEqual(result.removedFloors, []);
        assert.deepEqual(target, before);
        assert.deepEqual(f.ctx.chat, original);
        assert.equal(f.writes.at(-1)[1], plan().prompt);
    }
});

test('changed source or binding cannot reuse an earlier snapshot', async () => {
    for (const change of [
        ctx => { ctx.chat[0].mes = '新正文'; },
        ctx => { ctx.chat[1].swipe_id = 1; },
        ctx => { ctx.chatMetadata.integrity = 'other'; },
        ctx => { ctx.chatId = 'other'; },
        ctx => { ctx.characters[0].avatar = 'other.png'; },
    ]) {
        const f = fixture(), snapshot = await f.host.snapshot(), target = core(snapshot);
        change(f.ctx);
        assert.equal(f.host.inject(target, plan(), snapshot).reason, 'source-changed');
        assert.ok(f.writes.every(write => write[1] === ''));
    }
});

test('invalid, overlapping and recent-tail coverage cannot be prepared', async () => {
    const f = fixture(), snapshot = await f.host.snapshot();
    for (const coveredRanges of [[{ start: 0, end: 2 }], [{ start: 3, end: 2 }],
        [{ start: 1, end: 8 }], [{ start: 1, end: 3 }, { start: 3, end: 4 }], [{ start: 1.5, end: 3 }]]) {
        assert.equal(f.host.inject(core(snapshot), { ...plan(), coveredRanges }, snapshot).reason, 'invalid-ranges');
    }
});

test('current connection receives explicit text/system only, not global response-length mutation', async () => {
    const f = fixture();
    assert.equal(await f.host.generate('整理这些原文', { systemPrompt: '独立整理规则' }), '当前连接摘要');
    assert.deepEqual(f.rawCalls, [[{ prompt: '整理这些原文', systemPrompt: '独立整理规则', trimNames: false }]]);
    assert.equal(f.profileCalls.length, 0);
    assert.equal(f.writes.length, 0);
    await assert.rejects(f.host.generate('原文', { model: 'other' }), /同时选择连接/);
});

test('profile connection uses its own request, signal and model without changing global selection', async () => {
    const f = fixture(), controller = new AbortController();
    f.ctx.extensionSettings = { connectionManager: { selectedProfile: 'normal-chat' } };
    assert.equal(await f.host.generate('原文', { profileId: 'p1', model: 'other-model', signal: controller.signal }), '独立连接摘要');
    const [id, messages, maxTokens, options, override] = f.profileCalls[0];
    assert.equal(id, 'p1');
    assert.equal(messages[0].role, 'system');
    assert.deepEqual(messages[1], { role: 'user', content: '原文' });
    assert.equal(maxTokens, 2048);
    assert.equal(options.signal, controller.signal);
    assert.equal(options.includePreset, false);
    assert.deepEqual(override, { model: 'other-model' });
    assert.equal(f.ctx.extensionSettings.connectionManager.selectedProfile, 'normal-chat');
    assert.equal(f.rawCalls.length, 0);
    assert.deepEqual(f.host.profiles(), [{ id: 'p1', name: '摘要连接', model: 'model-a', api: 'openai' }]);
});

test('cancelled and late raw results are discarded without stopping the normal chat', async () => {
    const f = fixture(), controller = new AbortController();
    let finish;
    f.ctx.stopGeneration = () => assert.fail('normal chat must not be stopped');
    f.ctx.generateRaw = () => new Promise(resolve => { finish = resolve; });
    const pending = f.host.generate('原文', { signal: controller.signal });
    controller.abort(new Error('已关闭忆幕'));
    finish('迟到的结果');
    await assert.rejects(pending, /已关闭忆幕/);
    await assert.rejects(f.host.generate('原文', { signal: controller.signal }), /已关闭忆幕/);
});

test('missing generation interfaces and unusable provider answers fail without fabrication', async () => {
    const f = fixture();
    f.ctx.generateRaw = async () => ({ content: '' });
    await assert.rejects(f.host.generate('原文'), /没有收到可用/);
    delete f.ctx.generateRaw;
    await assert.rejects(f.host.generate('原文'), /不支持后台/);
    delete f.ctx.ConnectionManagerRequestService;
    await assert.rejects(f.host.generate('原文', { profileId: 'p1' }), /不支持独立/);
    assert.deepEqual(f.host.profiles(), []);
});

test('subscriptions expose named events and arguments, clear lifecycle prompts and fully detach', async () => {
    const f = fixture(), seen = [], snapshot = await f.host.snapshot();
    const emitter = f.ctx.eventSource;
    const unsubscribe = f.host.subscribe((name, args) => seen.push([name, args]));
    f.host.inject(core(snapshot), plan(), snapshot);
    emitter.emit(f.ctx.eventTypes.MESSAGE_EDITED, 2);
    emitter.emit(f.ctx.eventTypes.CHAT_COMPLETION_SETTINGS_READY, { messages: [] });
    assert.deepEqual(seen[0], ['MESSAGE_EDITED', [2]]);
    assert.equal(f.host.prepared().status, 'prepared');
    emitter.emit(f.ctx.eventTypes.CHAT_CHANGED, 'new-chat');
    assert.equal(f.host.prepared(), null);
    assert.equal(f.writes.at(-1)[1], '');
    unsubscribe(); unsubscribe();
    assert.equal(emitter.eventNames().length, 0);
    const count = seen.length;
    emitter.emit(f.ctx.eventTypes.MESSAGE_EDITED, 4);
    assert.equal(seen.length, count);
    assert.equal(f.rawCalls.length, 0);
});

test('a concurrent ST dry run does not clear memory prepared for the real request', async () => {
    const f = fixture(), snapshot = await f.host.snapshot();
    const seen = [], unsubscribe = f.host.subscribe((name, args) => seen.push([name, args]));
    f.host.inject(core(snapshot), plan(), snapshot);
    const writes = f.writes.length;
    f.ctx.eventSource.emit(f.ctx.eventTypes.GENERATION_STARTED, 'normal', {}, true);
    assert.equal(f.writes.length, writes);
    assert.equal(f.host.prepared().prompt, plan().prompt);
    assert.equal(seen.at(-1)[1][2], true);
    f.ctx.eventSource.emit(f.ctx.eventTypes.GENERATION_STARTED, 'normal', {}, false);
    assert.equal(f.host.prepared(), null);
    assert.equal(f.writes.at(-1)[1], '');
    unsubscribe();
});
