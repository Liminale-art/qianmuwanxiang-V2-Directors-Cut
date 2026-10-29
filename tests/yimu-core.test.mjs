import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, SCHEMA, createDocument, createDefaults, validateDocument, applyOperation, applyDefaultsOperation, fingerprintMessages, sourceMatches } from '../yimu/contract.mjs';
import { nextBatch, parseSummary, summaryPrompt, buildPlan, inspectSources, initialRangePreview, planManualRange, summaryCoverage } from '../yimu/core.mjs';
import { buildBudgetedMessages, captureCore } from '../yimu/budget.mjs';

const binding = { avatar: 'Fixture.png', file: 'fixture', integrity: 'fixture-id' };
const messages = Array.from({ length: 12 }, (_, i) => ({ name: i % 2 ? '角色' : '用户', is_user: i % 2 === 0, mes: `合成第${i + 1}层：两人首次约会，秘密并未告诉旁人。`, send_date: `2026-10-25 ${i}` }));
const enable = (range = { start: 1, end: 12, total: 12 }) => ({ ...applyOperation(createDocument(binding), { id: 'enable', type: 'enable', expectedRevision: 0, enabled: true, range }).document, autoSummary: true });
const entry = async (id, start, end, text = '初次约会很重要；未告知的秘密不成为他人所知。') => ({ id, kind: 'summary', text, source: { start, end, hashes: (await fingerprintMessages(messages)).slice(start - 1, end) } });
const append = (doc, item, id = item.id) => applyOperation(doc, { id, type: 'append', expectedEpoch: doc.epoch, entry: item }).document;

test('sources fingerprint exact visible content, sender, time and hidden state without retaining originals', async () => {
    const source = (await entry('s', 2, 4)).source;
    assert.equal(sourceMatches(source, await fingerprintMessages(messages)), true);
    for (const [key, value] of [['mes', '改写'], ['name', '其他人'], ['send_date', '不同时间'], ['is_system', true]]) {
        const copy = structuredClone(messages); copy[2][key] = value;
        assert.equal(sourceMatches(source, await fingerprintMessages(copy)), false);
    }
    assert.ok(!JSON.stringify(source).includes('约会'));
});

test('feature enable does not authorize automatic work; empty and confirmed history decisions survive reenable', () => {
    const fresh = applyOperation(createDocument(binding), { id: 'x', type: 'enable', expectedRevision: 0, enabled: true }).document;
    assert.equal(fresh.initialRange, null); assert.equal(fresh.autoSummary, false);
    assert.equal(nextBatch(fresh, messages, DEFAULTS), null);
    const empty = enable({ start: 1, end: 0, total: 0 });
    assert.equal(empty.enabled, true);
    const off = applyOperation(empty, { id: 'off', type: 'enable', expectedRevision: 1, enabled: false }).document;
    const on = applyOperation(off, { id: 'on', type: 'enable', expectedRevision: 2, enabled: true }).document;
    assert.deepEqual(on.initialRange, empty.initialRange);
});

test('content batches preserve five recent floors and skip unchosen initial history, not just current rendered messages', () => {
    assert.deepEqual(nextBatch(enable(), messages, DEFAULTS), { start: 1, end: 7 });
    assert.deepEqual(nextBatch(enable({ start: 3, end: 4, total: 12 }), messages, DEFAULTS), { start: 3, end: 4 });
    assert.equal(nextBatch(enable(), messages.slice(0, 5), DEFAULTS), null);
});

test('schema seven preserves schema-six explicit auto choices and migrates earlier enabled chats without writes', () => {
    const fresh = createDocument(binding);
    assert.equal(SCHEMA, 7); assert.equal(fresh.autoSummary, false);
    assert.equal(validateDocument({ ...fresh, schema: 6, enabled: true, autoSummary: false }).autoSummary, false);
    for (const enabled of [true, false]) {
        const legacy = { ...fresh, schema: 5, enabled }; delete legacy.autoSummary;
        assert.equal(validateDocument(legacy).autoSummary, enabled);
        assert.equal(legacy.schema, 5, 'read validation does not mutate old data');
    }
    assert.throws(() => validateDocument({ ...fresh, autoSummary: undefined }), /自动总结/);
});

test('history cancellation is a persistent skip, not an empty-chat-only sentinel or permission to process older gaps', () => {
    let doc = enable(); doc.initialRange = null;
    doc = applyOperation(doc, { id: 'skip', type: 'history', expectedRevision: doc.configRevision, range: { start: 1, end: 0, total: 12 } }).document;
    assert.equal(nextBatch(doc, messages, DEFAULTS, { force: true }), null);
    const future = [...messages, ...messages.slice(0, 6)];
    assert.deepEqual(nextBatch(doc, future, DEFAULTS, { force: true }), { start: 13, end: 13 });
    assert.throws(() => applyOperation(doc, { id: 'again', type: 'history', expectedRevision: doc.configRevision, range: { start: 1, end: 12, total: 12 } }), /已确认/);
});

test('auto switch never turns on the master switch and turning off auto preserves enabled memory use', () => {
    const fresh = createDocument(binding);
    assert.throws(() => applyOperation(fresh, { id: 'auto', type: 'autoSummary', expectedRevision: 0, value: true }), /先启用/);
    const on = enable();
    const off = applyOperation(on, { id: 'auto_off', type: 'autoSummary', expectedRevision: on.configRevision, value: false }).document;
    assert.equal(off.enabled, true); assert.equal(off.autoSummary, false);
    assert.equal(nextBatch(off, messages, DEFAULTS), null);
    assert.deepEqual(nextBatch(off, messages, DEFAULTS, { force: true }), { start: 1, end: 7 });
});

test('manual range preview expands whole affected slices visibly and never relabels outside text', async () => {
    const doc = append(append(enable(), await entry('one', 1, 3)), await entry('two', 5, 7));
    const before = structuredClone(doc);
    const plan = planManualRange(doc, messages, DEFAULTS, { start: 2, end: 6 });
    assert.deepEqual(plan.requestedRange, { start: 2, end: 6 });
    assert.deepEqual(plan.range, { start: 1, end: 7 }); assert.equal(plan.expanded, true);
    assert.deepEqual(plan.batches.map(batch => [batch.start, batch.end, batch.redo?.id]), [[1, 3, 'one'], [4, 4, undefined], [5, 7, 'two']]);
    assert.deepEqual(doc, before);
    const hidden = structuredClone(messages); hidden[3].is_system = true;
    assert.deepEqual(planManualRange(doc, hidden, DEFAULTS, { start: 4, end: 4 }).range, { start: 4, end: 4 });
});

test('manual ranges reject deleted choices, bridge originals, unsupported floors and oversized whole slices', async () => {
    const doc = append(enable(), await entry('one', 1, 4));
    for (const status of ['deleted', 'excluded']) {
        const changed = structuredClone(doc); changed.entries[0].status = status;
        assert.throws(() => planManualRange(changed, messages, DEFAULTS, { start: 2, end: 3 }), /删除|暂不使用/);
    }
    assert.throws(() => planManualRange({ ...doc, lineage: { bridgeCount: 2 } }, messages, DEFAULTS, { start: 1, end: 3 }), /续接/);
    assert.throws(() => planManualRange(doc, messages, { ...DEFAULTS, batch: 1 }, { start: 2, end: 3 }), /容量/);
    const tools = structuredClone(messages); tools[5].tool_calls = [];
    assert.throws(() => planManualRange(doc, tools, DEFAULTS, { start: 5, end: 7 }), /工具调用/);
});

test('manual exact redo cannot silently shrink an existing source range', async () => {
    const doc = append(enable(), await entry('one', 1, 4));
    const shortened = await entry('one', 2, 3);
    assert.throws(() => applyOperation(doc, { id: 'shrink', type: 'redo', entryId: 'one', expectedEpoch: doc.epoch, expectedRevision: 1,
        entry: shortened }), /不能改变/);
});

test('status counts fine-slice floor unions once and pending work excludes recent and user-deleted floors', async () => {
    let doc = append(append(enable(), await entry('one', 1, 2)), await entry('two', 4, 4));
    doc.entries[1].status = 'deleted';
    doc.entries.push({ kind: 'stage', status: 'active', source: { ranges: [doc.entries[0].source] } });
    assert.deepEqual(summaryCoverage(doc, messages, DEFAULTS), { sliceCount: 1, organizedFloors: 2, pendingFloors: 4, pendingRange: { start: 3, end: 7 } });
});

test('first-enable preview includes hidden source floors while preserving recent raw and hidden flags', () => {
    const source = structuredClone(messages.slice(0, 11));
    source.slice(0, 5).forEach(message => { message.is_system = true; });
    const before = structuredClone(source), doc = enable({ start: 1, end: 11, total: 11 });
    const preview = initialRangePreview(doc, source, { start: 1, end: 11 }, DEFAULTS);
    assert.deepEqual(preview, { valid: true, hidden: [1, 2, 3, 4, 5], recent: [7, 8, 9, 10, 11], handled: [], unsupported: [], eligible: [1, 2, 3, 4, 5, 6] });
    assert.deepEqual(nextBatch(doc, source, DEFAULTS), { start: 1, end: 6 });
    assert.deepEqual(source, before);
    assert.deepEqual(initialRangePreview(doc, source, { start: 3, end: 5 }, DEFAULTS).eligible, [3, 4, 5]);
    assert.deepEqual(initialRangePreview(doc, source, { start: 7, end: 11 }, DEFAULTS).hidden, []);
    assert.deepEqual(initialRangePreview(doc, source, { start: 1, end: 11 }, { recent: 6 }).eligible, [1, 2, 3, 4, 5]);
});

test('initial-range preview never counts tool, empty, inherited or already handled floors as ordinary new work', () => {
    const source = structuredClone(messages);
    source[0].mes = ''; source[1].extra = { tool_invocations: [] }; source[2].tool_calls = [];
    source[3].tool_call_id = 'call-id'; source[11].is_system = true;
    const doc = { lineage: { bridgeCount: 5 }, entries: [{ kind: 'summary', source: { start: 6, end: 6 }, status: 'deleted' }] };
    const preview = initialRangePreview(doc, source, { start: 1, end: 12 }, { recent: 1 });
    assert.deepEqual(preview.handled, [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(preview.hidden, [12]); assert.deepEqual(preview.recent, [12]);
    assert.deepEqual(preview.eligible, [7, 8, 9, 10, 11]);
    assert.deepEqual(initialRangePreview({}, source, { start: 1, end: 4 }, DEFAULTS).unsupported, [1, 2, 3, 4]);
    assert.equal(initialRangePreview({}, source, { start: 8, end: 3 }, DEFAULTS).valid, false);
    assert.equal(initialRangePreview({}, source, { start: 1, end: 13 }, DEFAULTS).valid, false);
    assert.equal(initialRangePreview({}, source, { start: 1.5, end: 5 }, DEFAULTS).valid, false);
});

test('incremental batches require content threshold, explicit summarize may process the smaller gap', async () => {
    const doc = append(enable({ start: 1, end: 2, total: 2 }), await entry('a', 1, 2));
    assert.equal(nextBatch(doc, messages, DEFAULTS), null);
    assert.deepEqual(nextBatch(doc, messages, DEFAULTS, { force: true }), { start: 3, end: 7 });
});

test('deleted and excluded slices do not silently reappear; invalid sources wait for an explicit user repair', async () => {
    let doc = append(enable(), await entry('a', 1, 4));
    doc = applyOperation(doc, { id: 'del', type: 'entry', entryId: 'a', expectedRevision: 1, action: 'delete' }).document;
    assert.deepEqual(nextBatch(doc, messages, DEFAULTS), { start: 5, end: 7 });
    doc = append(enable(), await entry('b', 1, 4));
    doc = applyOperation(doc, { id: 'bad', type: 'invalidate', entries: [{ id: 'b', revision: 1 }] }).document;
    assert.deepEqual(nextBatch(doc, messages, DEFAULTS), { start: 5, end: 7 });
    assert.deepEqual(nextBatch(doc, messages, DEFAULTS, { force: true }), { start: 5, end: 7 });
    doc = applyOperation(doc, { id: 'edit', type: 'edit', entryId: 'b', expectedRevision: 2, text: '手动修订' }).document;
    assert.equal(doc.entries[0].status, 'invalid');
    assert.deepEqual(nextBatch(doc, messages, DEFAULTS), { start: 5, end: 7 });
});

test('invalidation only touches affected active sources and never revives on raw rollback', async () => {
    let doc = append(append(enable(), await entry('a', 1, 2)), await entry('b', 3, 4));
    const changed = structuredClone(messages); changed[1].mes = '改写';
    const scan = await inspectSources(doc, changed);
    assert.deepEqual(scan.invalid, [{ id: 'a', revision: 1 }]);
    doc = applyOperation(doc, { id: 'invalidate', type: 'invalidate', entries: scan.invalid }).document;
    assert.equal(doc.entries[1].status, 'active');
    assert.deepEqual((await inspectSources(doc, messages)).invalid, []);
    assert.equal(doc.entries[0].status, 'invalid', 'matching the old text again does not auto-reactivate it');
});

test('summary schema requires complete ordered source coverage, never trusts fabricated floor bounds', async () => {
    const hashes = await fingerprintMessages(messages), batch = { start: 1, end: 4 };
    const parsed = parseSummary(JSON.stringify({ slices: [{ start: 1, end: 2, text: '前半' }, { start: 3, end: 4, text: '后半未结束' }] }), batch, hashes);
    assert.equal(parsed.length, 2);
    for (const slices of [[], [{ start: 1, end: 3, text: '缺层' }], [{ start: 0, end: 4, text: '越界' }], [{ start: 1, end: 4, text: '' }], [{ start: 1, end: 2, text: 'a' }, { start: 2, end: 4, text: 'b' }]]) {
        assert.throws(() => parseSummary(JSON.stringify({ slices }), batch, hashes));
    }
    assert.throws(() => parseSummary('不是 JSON', batch, hashes));
    const prompt = summaryPrompt(messages, batch, DEFAULTS);
    assert.ok(prompt.includes('故事事实与各角色实际知情'));
    assert.ok(!prompt.includes('合成第5层'));
});

test('generation selects only whole valid slices outside recent raw, with explicit token estimate and no raw mutation', async () => {
    let doc = append(append(enable(), await entry('a', 1, 2)), await entry('b', 8, 9));
    const before = structuredClone(messages);
    const plan = await buildPlan(doc, createDefaults(), { messages, maxContext: 8192 });
    assert.deepEqual(plan.memoryIds, ['a']);
    assert.equal(plan.estimated, true);
    assert.deepEqual(messages, before);
    doc.settings.budget = 1;
    const tinyBudget = await buildPlan(doc, createDefaults(), { messages, maxContext: 8192 });
    assert.equal(tinyBudget.settings.budget, 1, 'selection retains complete entries; final-payload admission enforces the actual budget');
    assert.equal(tinyBudget.entries[0].text, doc.entries[0].text);
});

test('source-changed slices remain injected while raw edited floors stay intact', async () => {
    let doc = append(enable(), await entry('stale', 1, 2));
    doc = applyOperation(doc, { id: 'invalidate-stale', type: 'invalidate', entries: [{ id: 'stale', revision: 1 }] }).document;
    const changed = structuredClone(messages); changed[0].mes = '用户后来改写的正文';
    const plan = await buildPlan(doc, createDefaults(), { messages: changed, maxContext: 8192 });
    assert.deepEqual(plan.memoryIds, ['stale']);
    const core = changed.map((message, index) => ({ ...message, index }));
    const { processed } = captureCore(core, { messages: changed }, { namesBehavior: 0, userName: '用户' });
    const result = await buildBudgetedMessages({ messages: processed.map(item => item.request) }, {
        entries: plan.entries, processed, sourceHashes: await fingerprintMessages(changed), recent: DEFAULTS.recent,
        budget: 20000, contextTokens: 60000, responseTokens: 1024,
    });
    assert.equal(result.applied, true);
    assert.deepEqual(result.removedFloors, []);
    assert.equal(result.entries[0].id, 'stale');
    assert.match(result.messages.find(message => message.content.startsWith('<yimu_memory>')).content, /stale/);
});

test('summary prompt balances source-grounded narrative texture with factual and knowledge boundaries', () => {
    const source = [
        {name: '甲', mes: '甲将茶杯往乙手边推了推，说：“趁热。”乙没有回答。'},
        {name: '乙', mes: '第二天，乙照常买菜回家，没有提起那杯茶。'},
        {name: '甲', mes: '范围外内容不能带入。'},
    ], before = structuredClone(source);
    const prompt = summaryPrompt(source, {start: 1, end: 2}, DEFAULTS);
    for (const rule of ['精炼连贯、自足的叙事回望', '情绪过程', '不凑字段', '不统一抒情',
        '不拼接伪引语', '隐藏动机', '故事事实与各角色实际知情', 'scenes']) assert.ok(prompt.includes(rule), rule);
    assert.deepEqual(JSON.parse(prompt.split('原文：')[1]), source.slice(0, 2).map((m, i) => ({floor: i + 1, speaker: m.name, role: 'character', text: m.mes})));
    assert.deepEqual(source, before);
    const withRecall = summaryPrompt(source, {start: 1, end: 2}, DEFAULTS, {recallCandidates: [{id: 'past', text: '往事'}]});
    assert.ok(withRecall.includes('确有明确旧细节缺口'));
});

test('memory-use guidance does not dictate the current mood or rewrite hand-edited narrative text', async () => {
    let doc = append(enable(), await entry('a', 1, 2));
    const text = '甲只说了“趁热”。乙没有回答；两人的心意尚未明说。';
    doc = applyOperation(doc, {id: 'texture-edit', type: 'edit', entryId: 'a', expectedRevision: 1, text}).document;
    const before = structuredClone(doc);
    const plan = await buildPlan(doc, createDefaults(), {messages, maxContext: 8192});
    assert.equal(plan.entries[0].text, text);
    assert.ok(plan.prompt.includes(JSON.stringify(text)));
    for (const rule of ['不是当前场景的固定基调', '近期原文的文风', '不模仿摘要的压缩措辞', '不改变手动修订的含义']) assert.ok(plan.prompt.includes(rule), rule);
    assert.deepEqual(doc, before);
});

test('manual memories are source-free; excluded or mismatched summaries cannot be injected', async () => {
    let doc = append(enable(), await entry('a', 1, 2));
    doc = append(doc, { id: 'manual', kind: 'manual', text: '计划尚未完成。', source: null,
        placement: { binding, fromFloor: 2, hash: (await fingerprintMessages(messages))[1] } });
    const changed = structuredClone(messages); changed[0].mes = '改变';
    const plan = await buildPlan(doc, createDefaults(), { messages: changed, maxContext: 8192 });
    assert.deepEqual(plan.memoryIds, ['manual']);
    assert.match(plan.prompt, /自定义切片/);
});

test('same-record concurrent writes preserve both contents and unrelated record edits remain writable', async () => {
    let doc = append(append(enable(), await entry('a', 1, 2)), await entry('b', 3, 4));
    doc = applyOperation(doc, { id: 'edit1', type: 'edit', entryId: 'a', expectedRevision: 1, text: '已保存版' }).document;
    const conflict = applyOperation(doc, { id: 'edit2', type: 'edit', entryId: 'a', expectedRevision: 1, text: '另一设备稿' });
    assert.equal(conflict.outcome, 'conflict');
    assert.equal(conflict.document.entries[0].text, '已保存版');
    assert.equal(conflict.document.entries[0].conflicts[0].text, '另一设备稿');
    doc = applyOperation(conflict.document, { id: 'editB', type: 'edit', entryId: 'b', expectedRevision: 1, text: 'B独立保存' }).document;
    assert.equal(doc.entries[1].text, 'B独立保存');
});

test('ordinary edit supports undo, and human redo only produces an inline candidate', async () => {
    const original = await entry('a', 1, 2);
    let doc = append(enable(), original);
    doc = applyOperation(doc, { id: 'edit', type: 'edit', entryId: 'a', expectedRevision: 1, text: '人工版本' }).document;
    doc = applyOperation(doc, { id: 'redo', type: 'redo', entryId: 'a', expectedRevision: 2, expectedEpoch: doc.epoch, entry: { ...original, text: '模型候选' } }).document;
    assert.equal(doc.entries[0].text, '人工版本');
    assert.equal(doc.entries[0].candidate.text, '模型候选');
    doc = applyOperation(doc, { id: 'undo', type: 'entry', entryId: 'a', expectedRevision: 3, action: 'undoText' }).document;
    assert.equal(doc.entries[0].text, original.text);
});

test('stale enable and summary epochs cannot overwrite changes, replay IDs never hide different content', () => {
    const doc = enable();
    assert.throws(() => applyOperation(doc, { id: 'old', type: 'enable', expectedRevision: 0, enabled: false }));
    const op = { id: 'manual1', type: 'append', entry: { id: 'm', kind: 'manual', text: '手动', source: null,
        placement: { binding, fromFloor: 1, hash: 'a'.repeat(64) } } };
    const saved = applyOperation(doc, op).document;
    assert.equal(applyOperation(saved, op).outcome, 'duplicate');
    assert.throws(() => applyOperation(saved, { ...op, entry: { ...op.entry, text: '不同内容' } }), /不同内容/);
});

test('global defaults patch rather than resetting unrelated settings, explicit null resets just that field', () => {
    let defaults = applyDefaultsOperation(createDefaults(), { id: 'd1', expectedRevision: 0, values: { profileId: 'profile', preference: '侧重承诺' } }).defaults;
    defaults = applyDefaultsOperation(defaults, { id: 'd2', expectedRevision: 1, values: { recent: 8 } }).defaults;
    assert.equal(defaults.values.profileId, 'profile');
    defaults = applyDefaultsOperation(defaults, { id: 'd3', expectedRevision: 2, values: { recent: null } }).defaults;
    assert.equal(defaults.values.recent, 5);
    assert.equal(defaults.values.preference, '侧重承诺');
});
