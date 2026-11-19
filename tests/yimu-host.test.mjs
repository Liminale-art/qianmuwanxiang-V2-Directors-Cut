import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHost, MEMORY_PROMPT_KEY } from '../yimu/host.mjs';
import { fingerprintMessages } from '../yimu/contract.mjs';

class AwaitedEmitter extends EventEmitter {
    async emitAsync(event, ...args) { for (const fn of this.listeners(event)) await fn(...args); }
    makeLast(event, fn) { this.removeListener(event, fn); this.on(event, fn); }
}

function fixture() {
    const writes = [], rawCalls = [], profileCalls = [], counts = [];
    let current = {
        groupId: null, characterId: 0, chatId: 'chapter-one', name1: '用户',
        characters: [{ name: '角色甲', avatar: 'actor.png', chat: 'chapter-one' }],
        chatMetadata: { integrity: 'stable-chat-id' },
        mainApi: 'openai', maxContext: 8192,
        chatCompletionSettings: { chat_completion_source: 'custom', openai_max_context: 32768, openai_max_tokens: 1024, names_behavior: 0 },
        getChatCompletionModel: () => 'fixture-model',
        async getTokenCountAsync(value) { counts.push(value); return Math.ceil(value.length / 3); },
        chat: Array.from({ length: 8 }, (_, index) => ({
            name: index % 2 ? '角色甲' : '用户', is_user: !(index % 2),
            mes: '第 ' + (index + 1) + ' 层', send_date: '2026-10-25T00:00:0' + index + '.000Z',
            extra: { nested: { original: true } },
        })),
        setExtensionPrompt(...args) { writes.push(args); },
        // ST 的真实语义：隐藏就是消息上的 is_system，saveChat 落盘后才算生效。
        async saveChat() { saves.push(current.chat.map(message => Boolean(message.is_system))); },
        async generateRaw(...args) { rawCalls.push(args); return '当前连接摘要'; },
        ConnectionManagerRequestService: {
            getSupportedProfiles() { return [{ id: 'p1', name: '摘要连接', model: 'model-a', api: 'openai', 'secret-id': 'never-expose', 'api-url': 'private-url' }]; },
            async sendRequest(...args) { profileCalls.push(args); return { content: '独立连接摘要', reasoning: 'not-content' }; },
        },
        eventSource: new AwaitedEmitter(),
        eventTypes: Object.fromEntries([
            'CHAT_CHANGED', 'CHAT_LOADED', 'CHAT_RENAMED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED',
            'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED', 'MESSAGE_DELETED', 'MESSAGE_RECEIVED',
            'GENERATION_STARTED', 'GENERATION_STOPPED', 'GENERATION_ENDED', 'GENERATE_AFTER_DATA',
            'CHAT_COMPLETION_PROMPT_READY', 'CHAT_COMPLETION_SETTINGS_READY',
        ].map(key => [key, key.toLowerCase()])),
    };
    const errors = [], saves = [];
    const host = createHost({ getContext: () => current, onError: error => errors.push(error) });
    return { host, writes, saves, rawCalls, profileCalls, counts, errors,
        get ctx() { return current; }, set ctx(value) { current = value; } };
}

test('native hiding writes is_system like ST does, marks its own floors on the message, and leaves user-hidden floors and tool messages alone', async () => {
    const f = fixture();
    f.ctx.chat[6].is_system = true;   // 第 7 层：用户自己手动隐藏的
    f.ctx.chat[2].tool_calls = [];    // 第 3 层：带工具调用，忆幕不碰
    const hidden = () => f.ctx.chat.map(message => Boolean(message.is_system));
    const marked = () => f.ctx.chat.map((message, i) => message.extra?.yimu_hidden === true ? i + 1 : 0).filter(Boolean);
    // 要隐藏 1、2、3、7：3 是工具消息跳过；7 已被用户隐藏，不留忆幕记号。
    const result = await f.host.applyHidden([1, 2, 3, 7]);
    assert.deepEqual(result.changed, [1, 2]);
    assert.deepEqual(hidden(), [true, true, false, false, false, false, true, false]);
    assert.deepEqual(marked(), [1, 2], '记号写在消息自身，随聊天文件保存');
    assert.equal(f.ctx.chat[0].extra.nested.original, true, '消息原有的 extra 不丢');
    assert.equal(f.saves.length, 1, '写完只保存一次');
    // 没有变化时不写盘。
    await f.host.applyHidden([1, 2, 3, 7]);
    assert.equal(f.saves.length, 1);
    // 记号在消息上，所以「重开页面后」（没有任何内存记录）仍只还原忆幕藏的：用户藏的第 7 层保持隐藏。
    await f.host.applyHidden([]);
    assert.deepEqual(hidden(), [false, false, false, false, false, false, true, false]);
    assert.deepEqual(marked(), []);
    // 已切到别的聊天时什么都不做。
    const other = await f.host.applyHidden([1, 2], { avatar: 'other.png', file: 'another-chat', integrity: 'other-id' });
    assert.deepEqual(other.changed, []); assert.deepEqual(hidden(), [false, false, false, false, false, false, true, false]);
});

test('ST summary admission checks the complete prompt and output reservation before generating', async () => {
    const f = fixture();
    f.ctx.chatCompletionSettings.openai_max_context = 2000;
    f.ctx.chatCompletionSettings.openai_max_tokens = 1000;
    await assert.rejects(f.host.generate('文'.repeat(900)), /上下文容量/);
    assert.equal(f.rawCalls.length, 0);
    assert.equal(await f.host.generate('少量合成原文'), '当前连接摘要');
    assert.equal(f.rawCalls.length, 1);
    assert.match(f.rawCalls[0][0].systemPrompt, /以下提示词中的“我”仅指执行本次忆幕整理的总结模型/);
});

function core(source, type = 'normal') {
    const result = structuredClone(source.messages.filter(message => !message.is_system));
    if (type === 'swipe') result.pop();
    return result.map((message, index) => ({ ...message, index }));
}

async function plan(source, ranges = [[1, 3]]) {
    const hashes = await fingerprintMessages(source.messages);
    return { entries: ranges.map(([start, end], i) => ({
        id: 'memory-' + i, kind: 'summary', status: 'active', text: '已核实记忆 ' + i,
        source: { start, end, hashes: hashes.slice(start - 1, end) },
    })), settings: { recent: 5, budget: 4096 } };
}

function request(target, type = 'normal') {
    return { type, model: 'fixture-model', chat_completion_source: 'custom', max_tokens: 1024,
        messages: [{ role: 'system', content: '角色设定，保持不变' }, ...target.map(message => ({
            role: message.is_user ? 'user' : 'assistant', content: message.mes.replace(/\r/g, ''),
        }))] };
}

test('snapshot returns detached chat and true chat-completion window without any chat write', async () => {
    const f = fixture();
    f.ctx.saveChat = () => assert.fail('must not save original chat');
    f.ctx.saveMetadata = () => assert.fail('must not save original metadata');
    const source = await f.host.snapshot();
    assert.deepEqual(source.binding, { avatar: 'actor.png', file: 'chapter-one', integrity: 'stable-chat-id' });
    assert.equal(source.name, '角色甲'); assert.equal(source.maxContext, 32768);
    assert.throws(() => { source.messages[0].extra.nested.original = false; }, TypeError, 'the snapshot is read-only all the way down');
    assert.notEqual(source.messages[0], f.ctx.chat[0], 'and never the live message object');
    assert.equal(f.ctx.chat[0].extra.nested.original, true);
    f.ctx.chatId = 'chapter-two';
    assert.equal((await f.host.snapshot()).binding.file, 'chapter-two'); assert.equal(f.writes.length, 0);
});

test('group, no chat and missing integrity fail without inventing an identity', async () => {
    const f = fixture(); f.ctx.groupId = 'group';
    await assert.rejects(f.host.snapshot(), /仅支持单人聊天/);
    f.ctx.groupId = null; f.ctx.chatId = '';
    await assert.rejects(f.host.snapshot(), /先打开/);
    f.ctx.chatId = 'chapter-one'; delete f.ctx.chatMetadata.integrity;
    await assert.rejects(f.host.snapshot(), /稳定的来源标识/);
});

test('prepare freezes source, plan and core without early prompt writes or source deletion', async () => {
    const f = fixture(), source = await f.host.snapshot(), target = core(source), candidate = await plan(source);
    // 余量很紧（刚好九成以上），装配时必须走实测分词：这条用例要验证的就是「只在最终边界核对一次」。
    f.ctx.chatCompletionSettings.openai_max_context = 1640;
    const original = structuredClone(f.ctx.chat), beforeCore = structuredClone(target);
    const prepared = f.host.prepare(target, candidate, source);
    assert.equal(prepared.prepared, true); assert.equal(prepared.reason, 'awaiting-final-request');
    assert.deepEqual(f.ctx.chat, original); assert.deepEqual(target, beforeCore);
    assert.ok(f.writes.every(write => write[1] === ''));
    assert.equal(f.host.inject, undefined, 'no parallel additive implementation');
    candidate.entries[0].text = 'externally changed'; assert.throws(() => { source.messages[0].mes = 'externally changed'; }, TypeError);
    const payload = request(target), result = await f.host.applyPrepared(payload, prepared.session);
    assert.equal(result.applied, true); assert.deepEqual(result.removedFloors, [1, 2, 3]);
    assert.equal(payload.messages[0].content, '角色设定，保持不变');
    assert.match(payload.messages[1].content, /已核实记忆 0/); assert.doesNotMatch(payload.messages[1].content, /externally changed/);
    assert.deepEqual(f.ctx.chat, original); assert.deepEqual(target, beforeCore);
    assert.equal(f.counts.length, 1); assert.equal(result.estimated, true);
    assert.equal((await f.host.applyPrepared(payload, prepared.session)).reason, 'expired-session');
});

test('empty plan and clear invalidate older sessions without changing an existing request', async () => {
    const f = fixture(), source = await f.host.snapshot(), target = core(source), candidate = await plan(source);
    const prepared = f.host.prepare(target, candidate, source), payload = request(target), before = JSON.stringify(payload);
    assert.equal(f.host.prepare(target, { entries: [] }, source).reason, 'empty');
    assert.equal((await f.host.applyPrepared(payload, prepared.session)).reason, 'expired-session');
    assert.equal(JSON.stringify(payload), before); assert.deepEqual(f.writes.at(-1), [MEMORY_PROMPT_KEY, '', 1, 0, false, 0]);
});

test('raw, quiet, impersonation, continue, text completion and live references stay unchanged', async () => {
    const f = fixture(), source = await f.host.snapshot(), candidate = await plan(source);
    for (const type of ['quiet', 'raw', 'impersonate', 'continue']) assert.equal(f.host.prepare(core(source), candidate, source, type).reason, 'unsupported-generation');
    assert.equal(f.host.prepare(f.ctx.chat, candidate, source).reason, 'live-chat-reference');
    assert.equal(f.host.prepare([...f.ctx.chat], candidate, source).reason, 'live-chat-reference');
    assert.equal(f.host.prepare({}, candidate, source).reason, 'unverified-mapping');
    f.ctx.mainApi = 'textgenerationwebui';
    assert.equal(f.host.prepare(core(source), candidate, source).reason, 'text-completion-boundary-unavailable');
    assert.ok(f.writes.every(write => write[1] === ''));
});

test('tool inputs and structurally modified core history cannot be prepared', async () => {
    const f = fixture(), source = await f.host.snapshot(), candidate = await plan(source);
    for (const mutate of [a => a.pop(), a => a.reverse(), a => { a[0].index = 9; }]) {
        const target = core(source); mutate(target);
        assert.equal(f.host.prepare(target, candidate, source).reason, 'unverified-mapping');
    }
    const target = core(source); target[0].tool_calls = [];
    assert.equal(f.host.prepare(target, candidate, source).reason, 'unsupported-tools');
});

test('ST regex transformations map to the final request without changing originals', async () => {
    const f = fixture(), source = await f.host.snapshot(), target = core(source), original = structuredClone(f.ctx.chat);
    target[0].mes = 'ST 正则转换后的正文';
    const beforeCore = structuredClone(target), prepared = f.host.prepare(target, await plan(source), source);
    const payload = request(target), result = await f.host.applyPrepared(payload, prepared.session);
    assert.equal(result.applied, true); assert.deepEqual(result.removedFloors, [1, 2, 3]);
    assert.deepEqual(f.ctx.chat, original); assert.deepEqual(target, beforeCore);
});

test('changed binding or source cannot reuse an earlier snapshot', async () => {
    for (const change of [ctx => { ctx.chat[0].mes = '新正文'; }, ctx => { ctx.chat[1].swipe_id = 1; },
        ctx => { ctx.chatMetadata.integrity = 'other'; }, ctx => { ctx.chatId = 'other'; },
        ctx => { ctx.characters[0].avatar = 'other.png'; }]) {
        const f = fixture(), source = await f.host.snapshot(), target = core(source), candidate = await plan(source);
        change(f.ctx); assert.equal(f.host.prepare(target, candidate, source).reason, 'source-changed');
    }
});

test('async admission aborts atomically after source, route, generation, request or runtime guard changes', async () => {
    for (const mutation of [
        f => { f.ctx.chat[2].mes = 'edited'; },
        f => { f.ctx.chatCompletionSettings.openai_max_context = 40000; },
        f => { f.ctx.getChatCompletionModel = () => 'new-model'; },
        f => f.host.clear(),
        (_f, payload) => { payload.messages[0].content = 'another listener changed this'; },
        (_f, _payload, state) => { state.active = false; },
    ]) {
        const f = fixture(), source = await f.host.snapshot(), target = core(source), candidate = await plan(source);
        // 余量很紧（刚好九成以上），装配时必须走实测分词；这条用例用它作为「装配进行到一半」的暂停点。
        f.ctx.chatCompletionSettings.openai_max_context = 1640;
        let complete, started; const counting = new Promise(resolve => { started = resolve; });
        f.ctx.getTokenCountAsync = () => { started(); return new Promise(resolve => { complete = resolve; }); };
        const prepared = f.host.prepare(target, candidate, source), payload = request(target), state = { active: true };
        const pending = f.host.applyPrepared(payload, prepared.session, { isCurrent: () => state.active });
        await counting; mutation(f, payload, state); const expected = JSON.stringify(payload); complete(1);
        const result = await pending;
        assert.equal(result.applied, false); assert.equal(JSON.stringify(payload), expected);
    }
});

test('concurrent use cannot commit a second transaction for one session', async () => {
    const f = fixture(), source = await f.host.snapshot(), target = core(source);
    // 余量很紧（刚好九成以上），装配时必须走实测分词；这条用例用它作为「第一笔尚未提交」的暂停点。
    f.ctx.chatCompletionSettings.openai_max_context = 1640;
    let finish, started; const waiting = new Promise(resolve => { started = resolve; });
    f.ctx.getTokenCountAsync = () => { started(); return new Promise(resolve => { finish = resolve; }); };
    const { session } = f.host.prepare(target, await plan(source), source), a = request(target), b = request(target), before = JSON.stringify(b);
    const pending = f.host.applyPrepared(a, session); await waiting;
    assert.equal((await f.host.applyPrepared(b, session)).reason, 'expired-session');
    assert.equal(JSON.stringify(b), before); finish(1); assert.equal((await pending).applied, true);
});

test('unrelated raw payload does not consume the main request session', async () => {
    const f = fixture(), source = await f.host.snapshot(), target = core(source);
    const { session } = f.host.prepare(target, await plan(source), source), raw = request(target, 'quiet');
    assert.equal((await f.host.applyPrepared(raw, session)).reason, 'different-generation');
    assert.equal((await f.host.applyPrepared(request(target), session)).applied, true);
});

test('final max_completion_tokens is reserved and an oversized reply leaves the request unchanged', async () => {
    for (const response of [2048, 32700]) {
        const f = fixture(), source = await f.host.snapshot(), target = core(source);
        const { session } = f.host.prepare(target, await plan(source), source), payload = request(target);
        delete payload.max_tokens; payload.max_completion_tokens = response;
        const before = JSON.stringify(payload), result = await f.host.applyPrepared(payload, session);
        if (response === 2048) { assert.equal(result.applied, true); assert.equal(result.responseTokens, 2048); }
        else { assert.equal(result.applied, false); assert.equal(JSON.stringify(payload), before); }
    }
});

test('current generation uses explicit text/system only without global output-length mutation', async () => {
    const f = fixture();
    assert.equal(await f.host.generate('整理原文', { systemPrompt: '整理规则' }), '当前连接摘要');
    assert.deepEqual(f.rawCalls, [[{ prompt: '整理原文', systemPrompt: '整理规则', trimNames: false }]]);
    assert.equal(f.profileCalls.length, 0); assert.equal(f.writes.length, 0);
    await assert.rejects(f.host.generate('原文', { model: 'other' }), /同时选择连接/);
});

test('independent profile request preserves global selection and exposes no secrets', async () => {
    const f = fixture(), controller = new AbortController();
    f.ctx.extensionSettings = { connectionManager: { selectedProfile: 'normal-chat' } };
    assert.equal(await f.host.generate('原文', { profileId: 'p1', model: 'other-model', signal: controller.signal }), '独立连接摘要');
    const [id, messages, maxTokens, options, override] = f.profileCalls[0];
    assert.equal(id, 'p1'); assert.equal(messages[0].role, 'system'); assert.deepEqual(messages[1], { role: 'user', content: '原文' });
    assert.equal(maxTokens, 2048); assert.equal(options.signal, controller.signal); assert.equal(options.includePreset, false);
    assert.deepEqual(override, { model: 'other-model' });
    assert.equal(f.ctx.extensionSettings.connectionManager.selectedProfile, 'normal-chat');
    assert.deepEqual(f.host.profiles(), [], 'ST connection-manager presets are no longer advertised as Qianmu API presets');
});

test('cancelled and unusable model answers never fabricate memory or stop normal chat', async () => {
    const f = fixture(), controller = new AbortController(); let finish;
    f.ctx.stopGeneration = () => assert.fail('must not stop normal chat');
    f.ctx.generateRaw = () => new Promise(resolve => { finish = resolve; });
    const pending = f.host.generate('原文', { signal: controller.signal }); controller.abort(new Error('已关闭忆幕')); finish('迟到');
    await assert.rejects(pending, /已关闭忆幕/);
    f.ctx.generateRaw = async () => ({ content: '' }); await assert.rejects(f.host.generate('原文'), /没有收到可用/);
    delete f.ctx.generateRaw; await assert.rejects(f.host.generate('原文'), /不支持后台/);
    delete f.ctx.ConnectionManagerRequestService; await assert.rejects(f.host.generate('原文', { profileId: 'p1' }), /不支持独立/);
});

test('subscriptions await final admission, promote after existing listeners and fully detach', async () => {
    const f = fixture(), source = await f.host.snapshot(), target = core(source), seen = [];
    let session, release; const paused = new Promise(resolve => { release = resolve; });
    const unsubscribe = f.host.subscribe(async (name, args) => {
        if (name === 'CHAT_COMPLETION_SETTINGS_READY') {
            await paused; seen.push('memory'); await f.host.applyPrepared(args[0], session);
        } else seen.push([name, args]);
    });
    const emitter = f.ctx.eventSource, event = f.ctx.eventTypes.CHAT_COMPLETION_SETTINGS_READY;
    const other = () => seen.push('other'); emitter.on(event, other);
    ({ session } = f.host.prepare(target, await plan(source), source));
    const payload = request(target); let finished = false;
    const emitting = emitter.emitAsync(event, payload).then(() => { finished = true; });
    await Promise.resolve(); assert.equal(finished, false); assert.equal(seen[0], 'other');
    release(); await emitting; assert.match(payload.messages[1].content, /yimu_memory/);
    assert.deepEqual(seen, ['other', 'memory']);
    unsubscribe(); unsubscribe(); emitter.removeListener(event, other);
    assert.equal(emitter.eventNames().length, 0); assert.equal(f.rawCalls.length, 0);
});

test('dry-run starts retain the main session; real generation starts invalidate it', async () => {
    const f = fixture(), source = await f.host.snapshot(), target = core(source);
    const unsubscribe = f.host.subscribe(() => {}), candidate = await plan(source);
    const prepared = f.host.prepare(target, candidate, source), writes = f.writes.length;
    await f.ctx.eventSource.emitAsync(f.ctx.eventTypes.GENERATION_STARTED, 'normal', {}, true);
    assert.equal(f.writes.length, writes);
    assert.equal((await f.host.applyPrepared(request(target), prepared.session)).applied, true);
    const second = f.host.prepare(target, candidate, source);
    await f.ctx.eventSource.emitAsync(f.ctx.eventTypes.GENERATION_STARTED, 'normal', {}, false);
    assert.equal((await f.host.applyPrepared(request(target), second.session)).reason, 'expired-session');
    unsubscribe();
});

test('unblocked input settles a round even when a theme suppresses GENERATION_ENDED', async () => {
    const f = fixture(), observers = [];
    class FakeObserver { constructor(fn) { this.fn = fn; observers.push(this); } observe(target, options) { this.target = target; this.options = options; } disconnect() { this.off = true; } }
    const body = { dataset: {} };
    const host = createHost({ getContext: () => f.ctx, document: { body, defaultView: { MutationObserver: FakeObserver } } });
    const seen = [];
    const off = host.subscribe(name => { seen.push(name); });
    assert.deepEqual(observers[0].options.attributeFilter, ['data-generating']);
    assert.equal(host.busyGenerating(), false);
    await f.ctx.eventSource.emitAsync('generation_started', 'normal', {}, false);
    body.dataset.generating = 'true'; observers[0].fn();
    assert.equal(host.busyGenerating(), true);
    assert.ok(!seen.includes('GENERATION_SETTLED'), 'still blocked');
    f.ctx.streamingProcessor = { isFinished: false, isStopped: false };
    delete body.dataset.generating;
    assert.equal(host.busyGenerating(), true, 'an unfinished stream is still busy');
    f.ctx.streamingProcessor.isFinished = true;
    observers[0].fn();
    assert.equal(seen.filter(name => name === 'GENERATION_SETTLED').length, 1);
    observers[0].fn();
    assert.equal(seen.filter(name => name === 'GENERATION_SETTLED').length, 1, 'settles once per round');
    assert.equal(host.busyGenerating(), false);
    off();
    assert.equal(observers[0].off, true);
});

test('snapshots reuse the copy of every unchanged message and regenerate only what the host rewrote in place', async () => {
    const f = fixture(), first = await f.host.snapshot(), again = await f.host.snapshot();
    assert.notEqual(first.messages, again.messages, 'each snapshot owns its array');
    assert.ok(first.messages.every((message, index) => message === again.messages[index]), 'unchanged messages are not copied again');
    f.ctx.chat[1].mes += '（原地改写）';
    f.ctx.chat[0].extra.nested.original = 'edited deep inside';
    const changed = await f.host.snapshot();
    assert.notEqual(changed.messages[0], first.messages[0]); assert.notEqual(changed.messages[1], first.messages[1]);
    assert.equal(changed.messages[1].mes, f.ctx.chat[1].mes); assert.equal(changed.messages[0].extra.nested.original, 'edited deep inside');
    assert.equal(first.messages[0].extra.nested.original, true, 'an earlier snapshot keeps what it saw');
    assert.ok(changed.messages.slice(2).every((message, index) => message === first.messages[index + 2]));
    assert.equal(JSON.stringify(changed.messages), JSON.stringify(f.ctx.chat), 'the snapshot is the chat as it would be saved');
    f.ctx.chat.push({ name: '角色甲', is_user: false, mes: '新的一层', send_date: 'later' });
    assert.equal((await f.host.snapshot()).messages.length, f.ctx.chat.length);
});
