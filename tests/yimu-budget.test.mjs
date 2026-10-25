import test from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintMessages } from '../yimu/contract.mjs';
import { buildBudgetedMessages, byteBudget, captureCore, memoryMessage, payloadSupport } from '../yimu/budget.mjs';

async function fixture({ count = 12, length = 512, type = 'normal', namesBehavior = 0 } = {}) {
    const source = { messages: Array.from({ length: count }, (_, i) => ({
        name: i % 2 ? 'Actor' : 'User', is_user: !(i % 2),
        mes: 'Floor ' + (i + 1) + ': ' + 'x'.repeat(length), send_date: 'date-' + i,
    })) };
    const core = structuredClone(source.messages); if (type === 'swipe') core.pop();
    core.forEach((message, index) => { message.index = index; });
    const { processed } = captureCore(core, source, { type, namesBehavior, userName: 'User' });
    const sourceHashes = await fingerprintMessages(source.messages);
    const payload = { type, model: 'custom-text-model', chat_completion_source: 'custom', max_tokens: 1024,
        messages: [{ role: 'system', content: 'Fixed character and world rules.' },
            { role: 'developer', content: 'Fixed additional instructions.' },
            ...processed.map(item => structuredClone(item.request))],
    };
    const entry = (id, start, end, text = 'A verified event summary.') => ({
        id, kind: 'summary', status: 'active', text,
        source: { start, end, hashes: sourceHashes.slice(start - 1, end) },
    });
    const options = { entries: [entry('slice-1', 1, 3)], sourceHashes, processed, recent: 5, budget: 8192,
        contextTokens: 32768, responseTokens: 1024 };
    return { source, core, processed, sourceHashes, payload, options, entry };
}

test('whole-request admission replaces only verified old source while preserving every recent floor and fixed prompt', async () => {
    const f = await fixture(), before = structuredClone({ payload: f.payload, source: f.source, core: f.core }), counted = [];
    const result = await buildBudgetedMessages(f.payload, f.options, { countTokens: async value => { counted.push(value); return 1200; } });
    assert.equal(result.applied, true); assert.deepEqual(result.removedFloors, [1, 2, 3]);
    assert.deepEqual(result.recentFloors, [8, 9, 10, 11, 12]); assert.equal(result.sourceReplacement, true);
    assert.deepEqual(result.messages.slice(0, 2), f.payload.messages.slice(0, 2));
    assert.equal(result.messages.filter(message => message.content.includes('<yimu_memory>')).length, 1);
    const memory = result.messages.find(message => message.content.includes('<yimu_memory>')).content;
    for (const rule of ['旧气氛不固定当前基调', '遵循用户设定', '近期原文文风', '不照搬摘要腔', '不改手动修订含义']) assert.ok(memory.includes(rule), rule);
    assert.deepEqual(result.messages.slice(-5), f.payload.messages.slice(-5));
    assert.deepEqual(f.payload, before.payload); assert.deepEqual(f.source, before.source); assert.deepEqual(f.core, before.core);
    assert.equal(counted.length, 1); assert.deepEqual(JSON.parse(counted[0]), result.messages);
    assert.equal(result.requestTokens, Math.max(byteBudget(result.messages), 1200));
    assert.equal(result.countingMethod, 'st-tokenizer+utf8-bound'); assert.equal(result.estimated, true);
});

test('500-floor synthetic history uses complete sources while preserving the configured recent tail, not a hard-coded five', async () => {
    const f = await fixture({ count: 500, length: 256 }), before = structuredClone(f.source);
    f.options.recent = 10;
    f.options.contextTokens = 65536;
    f.options.budget = 32768;
    f.options.entries = Array.from({ length: 98 }, (_, i) => f.entry(`large-${i}`, i * 5 + 1, i * 5 + 5));
    const result = await buildBudgetedMessages(f.payload, f.options);
    assert.equal(result.applied, true);
    assert.equal(result.entries.length, 98);
    assert.deepEqual(result.removedFloors, Array.from({ length: 490 }, (_, i) => i + 1));
    assert.deepEqual(result.recentFloors, Array.from({ length: 10 }, (_, i) => 491 + i));
    assert.deepEqual(result.messages.slice(-10), f.payload.messages.slice(-10));
    assert.ok(result.requestTokens + result.responseTokens <= result.contextTokens);
    assert.deepEqual(f.source, before);
});

test('manual additions fit spare space without requiring any source removal and preserve meaning verbatim', async () => {
    const f = await fixture(), text = '手动修订：她并不知道那封信。\n“计划”不代表“已经发生”。';
    f.options.entries = [{ id: 'manual', kind: 'manual', source: null, text }];
    const result = await buildBudgetedMessages(f.payload, f.options);
    assert.equal(result.applied, true); assert.equal(result.reason, 'memory-added'); assert.deepEqual(result.removedFloors, []);
    const encoded = result.messages.find(message => message.content.startsWith('<yimu_memory>')).content;
    assert.ok(encoded.includes(JSON.stringify(text)));
    assert.deepEqual(result.messages.filter(message => !message.content.startsWith('<yimu_memory>')), f.payload.messages);
});

test('stage ranges and fine slices are mutually exclusive even if caller supplies overlapping candidates', async () => {
    const f = await fixture();
    const first = f.entry('first', 1, 2), second = f.entry('second', 4, 5);
    const stage = { id: 'stage', kind: 'stage', text: 'Combined stage.', source: {
        ranges: [first.source, second.source], parents: [{ id: first.id, revision: 1 }, { id: second.id, revision: 1 }],
    } };
    f.options.entries = [stage, first, second, f.entry('third', 6, 7)];
    const result = await buildBudgetedMessages(f.payload, f.options);
    assert.deepEqual(result.entries.map(entry => entry.id), ['stage', 'third']);
    assert.deepEqual(result.removedFloors, [1, 2, 4, 5, 6, 7]);
    assert.ok(result.messages.some(message => message.content === f.processed[2].request.content));
});

test('a slice crossing the recent boundary is skipped whole, never partly replaced', async () => {
    const f = await fixture(); f.options.entries = [f.entry('overlap', 6, 8), f.entry('old', 1, 2)];
    const result = await buildBudgetedMessages(f.payload, f.options);
    assert.deepEqual(result.entries.map(entry => entry.id), ['old']);
    assert.deepEqual(result.removedFloors, [1, 2]); assert.deepEqual(result.messages.slice(-5), f.payload.messages.slice(-5));
    assert.ok(result.messages.some(message => message.content === f.processed[5].request.content));
});

test('swipe protects the actual visible tail, not the removed assistant floor', async () => {
    const f = await fixture({ type: 'swipe' }); f.options.entries = [f.entry('allowed', 1, 6), f.entry('forbidden', 7, 7)];
    const result = await buildBudgetedMessages(f.payload, f.options);
    assert.deepEqual(result.recentFloors, [7, 8, 9, 10, 11]); assert.deepEqual(result.removedFloors, [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(result.entries.map(entry => entry.id), ['allowed']);
});

test('expired or malformed source fingerprints never replace source', async () => {
    const f = await fixture(), stale = f.entry('stale', 1, 3);
    stale.source.hashes[0] = '0'.repeat(64);
    f.options.entries = [stale, { ...f.entry('broken', 4, 5), source: { start: 4, end: 5, hashes: [] } }];
    const before = JSON.stringify(f.payload), result = await buildBudgetedMessages(f.payload, f.options);
    assert.equal(result.applied, false); assert.equal(JSON.stringify(f.payload), before);
});

test('already-truncated old prefix can contribute memory without falsely claiming source removal', async () => {
    const f = await fixture(); f.payload.messages.splice(2, 6);
    const result = await buildBudgetedMessages(f.payload, f.options);
    assert.equal(result.applied, true); assert.deepEqual(result.removedFloors, []);
    assert.equal(result.sourceReplacement, false); assert.deepEqual(result.messages.slice(-5), f.payload.messages.slice(-5));
});

test('missing recent originals, ambiguous duplicates and reordered history all preserve original request', async () => {
    for (const mutate of [
        f => f.payload.messages.pop(),
        f => f.payload.messages.push(structuredClone(f.payload.messages.at(-1))),
        f => { [f.payload.messages[4], f.payload.messages[5]] = [f.payload.messages[5], f.payload.messages[4]]; },
        f => { f.payload.messages[6].content = 'other plugin replaced a middle source'; },
    ]) {
        const f = await fixture(); mutate(f); const before = JSON.stringify(f.payload);
        assert.equal((await buildBudgetedMessages(f.payload, f.options)).applied, false);
        assert.equal(JSON.stringify(f.payload), before);
    }
});

test('all fixed prompts and reply reservation count toward admission, not merely the memory text', async () => {
    const f = await fixture(); f.payload.messages[0].content = 'x'.repeat(50000);
    const before = JSON.stringify(f.payload);
    assert.equal((await buildBudgetedMessages(f.payload, f.options)).applied, false);
    assert.equal(JSON.stringify(f.payload), before);
    f.payload.messages[0].content = 'fixed';
    f.options.responseTokens = f.options.contextTokens - 100;
    assert.equal((await buildBudgetedMessages(f.payload, f.options)).applied, false);
});

test('native token count higher than the byte guard rejects the transaction without partial writes', async () => {
    const f = await fixture(), before = JSON.stringify(f.payload);
    const result = await buildBudgetedMessages(f.payload, f.options, { countTokens: async () => 40000 });
    assert.equal(result.reason, 'context-budget-exceeded'); assert.equal(JSON.stringify(f.payload), before);
});

test('counter errors and bounded timeout use explicit conservative estimated admission', async () => {
    for (const countTokens of [async () => { throw Error('unavailable'); }, () => new Promise(() => {}), async () => NaN]) {
        const f = await fixture();
        const result = await buildBudgetedMessages(f.payload, f.options, { countTokens, countTimeoutMs: 5 });
        assert.equal(result.applied, true); assert.equal(result.nativeRequestTokens, null);
        assert.equal(result.countingMethod, 'utf8-bound'); assert.equal(result.estimated, true);
        assert.equal(result.requestTokens, byteBudget(result.messages));
    }
});

test('multiple full summaries may together compress an initially oversized request into budget', async () => {
    const f = await fixture({ length: 1000 });
    f.options.contextTokens = 8500; f.options.responseTokens = 1000;
    f.options.entries = [f.entry('first', 1, 3), f.entry('second', 4, 6)];
    assert.ok(byteBudget(f.payload.messages) > 7500);
    const onlyFirst = await buildBudgetedMessages(f.payload, { ...f.options, entries: [f.options.entries[0]] });
    assert.equal(onlyFirst.applied, false);
    const result = await buildBudgetedMessages(f.payload, f.options);
    assert.equal(result.applied, true); assert.deepEqual(result.removedFloors, [1, 2, 3, 4, 5, 6]);
    assert.ok(result.requestTokens + result.responseTokens <= result.contextTokens);
});

test('later oversized manual addition does not discard an earlier valid complete selection', async () => {
    const f = await fixture({ length: 200 });
    f.options.contextTokens = 6000; f.options.responseTokens = 1000;
    f.options.entries.push({ id: 'large-manual', kind: 'manual', source: null, text: 'm'.repeat(3000) });
    const result = await buildBudgetedMessages(f.payload, f.options);
    assert.equal(result.applied, true); assert.deepEqual(result.entries.map(entry => entry.id), ['slice-1']);
    assert.deepEqual(result.removedFloors, [1, 2, 3]);
});

test('memory cap admits complete entries only rather than cutting manual wording', async () => {
    const f = await fixture();
    f.options.entries = [{ id: 'manual', kind: 'manual', source: null, text: 'm'.repeat(5000) }];
    f.options.budget = 1000;
    assert.equal((await buildBudgetedMessages(f.payload, f.options)).applied, false);
});

test('tools, multimodal, provider rewrites and unknown message shapes keep original payload byte-equivalent', async () => {
    for (const mutate of [
        f => { f.payload.tools = []; },
        f => { f.payload.functions = [{ name: 'tool' }]; },
        f => { f.payload.enable_web_search = true; },
        f => { f.payload.request_images = true; },
        f => { f.payload.system_prompt = 'a second prompt path'; },
        f => { f.payload.json_schema = {}; },
        f => { f.payload.messages[2].content = [{ type: 'text', text: 'text' }]; },
        f => { f.payload.messages[2].reasoning_content = 'reason'; },
        f => { f.payload.custom_include_body = 'messages: replaced'; },
        f => { f.payload.custom_exclude_body = 'messages'; },
        f => { f.payload.custom_prompt_post_processing = 'strict'; },
        f => { f.payload.assistant_prefill = 'prefix'; },
    ]) {
        const f = await fixture(); mutate(f); const before = JSON.stringify(f.payload);
        assert.equal((await buildBudgetedMessages(f.payload, f.options)).applied, false);
        assert.equal(JSON.stringify(f.payload), before);
    }
});

test('source files or media are not claimed covered by plain chat-body summaries', async () => {
    const f = await fixture(); f.processed[1].external = true;
    assert.equal((await buildBudgetedMessages(f.payload, f.options)).applied, false);
});

test('name formatting follows the known ST content/name modes and remains exact', async () => {
    for (const namesBehavior of [-1, 0, 1, 2]) {
        const f = await fixture({ namesBehavior });
        const result = await buildBudgetedMessages(f.payload, f.options);
        assert.equal(result.applied, true); assert.deepEqual(result.messages.slice(-5), f.payload.messages.slice(-5));
        if (namesBehavior === 1) assert.equal(f.processed[0].request.name, 'User');
        if (namesBehavior === 2) assert.match(f.processed[0].request.content, /^User: Floor 1/);
    }
});

test('hidden source floors retain original numbering and cannot be silently summarized as visible raw', async () => {
    const f = await fixture(); f.source.messages[1].is_system = true;
    const core = structuredClone(f.source.messages.filter(message => !message.is_system)).map((m, index) => ({ ...m, index }));
    const captured = captureCore(core, f.source);
    assert.equal(captured.processed[1].floor, 3);
    f.options.processed = captured.processed;
    f.options.sourceHashes = await fingerprintMessages(f.source.messages);
    f.options.entries = [{ ...f.entry('has-hidden', 1, 3), source: { start: 1, end: 3, hashes: f.options.sourceHashes.slice(0, 3) } }];
    f.payload.messages = captured.processed.map(item => item.request);
    assert.equal((await buildBudgetedMessages(f.payload, f.options)).applied, false);
});

test('cancellation during complete-request counting discards the candidate transaction', async () => {
    const f = await fixture(); let active = true;
    const before = JSON.stringify(f.payload);
    const result = await buildBudgetedMessages(f.payload, f.options, {
        isCurrent: () => active, countTokens: async () => { active = false; return 100; },
    });
    assert.equal(result.reason, 'cancelled'); assert.equal(JSON.stringify(f.payload), before);
});

test('unsupported core name format and malformed budget have explicit non-mutating fallbacks', async () => {
    const f = await fixture();
    assert.equal(captureCore(f.core, f.source, { namesBehavior: 99 }).reason, 'unsupported-name-format');
    assert.equal(payloadSupport({ prompt: 'text only' }), 'not-chat-completion');
    for (const responseTokens of [0, -1, NaN, 1.1, 40000]) {
        assert.equal((await buildBudgetedMessages(f.payload, { ...f.options, responseTokens })).reason, 'unknown-context-budget');
    }
    assert.ok(byteBudget([memoryMessage(f.options.entries)]) > 0);
});
