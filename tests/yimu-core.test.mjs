import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, createDocument, createDefaults, applyOperation, applyDefaultsOperation, fingerprintMessages, sourceMatches } from '../yimu/contract.mjs';
import { nextBatch, parseSummary, summaryPrompt, buildPlan, inspectSources } from '../yimu/core.mjs';

const binding = { avatar: 'Fixture.png', file: 'fixture', integrity: 'fixture-id' };
const messages = Array.from({ length: 12 }, (_, i) => ({ name: i % 2 ? '角色' : '用户', is_user: i % 2 === 0, mes: `合成第${i + 1}层：两人首次约会，秘密并未告诉旁人。`, send_date: `2026-10-25 ${i}` }));
const enable = (range = { start: 1, end: 12, total: 12 }) => applyOperation(createDocument(binding), { id: 'enable', type: 'enable', expectedRevision: 0, enabled: true, range }).document;
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

test('first scope is explicit, empty new chat can enable, reenable preserves confirmed range', () => {
    assert.throws(() => applyOperation(createDocument(binding), { id: 'x', type: 'enable', expectedRevision: 0, enabled: true }), /范围|楼层/);
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

test('incremental batches require content threshold, explicit summarize may process the smaller gap', async () => {
    const doc = append(enable({ start: 1, end: 2, total: 2 }), await entry('a', 1, 2));
    assert.equal(nextBatch(doc, messages, DEFAULTS), null);
    assert.deepEqual(nextBatch(doc, messages, DEFAULTS, { force: true }), { start: 3, end: 7 });
});

test('deleted and excluded slices do not silently reappear; auto-invalid sources can rebuild but human edits cannot', async () => {
    let doc = append(enable(), await entry('a', 1, 4));
    doc = applyOperation(doc, { id: 'del', type: 'entry', entryId: 'a', expectedRevision: 1, action: 'delete' }).document;
    assert.deepEqual(nextBatch(doc, messages, DEFAULTS), { start: 5, end: 7 });
    doc = append(enable(), await entry('b', 1, 4));
    doc = applyOperation(doc, { id: 'bad', type: 'invalidate', entries: [{ id: 'b', revision: 1 }] }).document;
    assert.equal(nextBatch(doc, messages, DEFAULTS).redo.id, 'b');
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
    assert.equal((await buildPlan(doc, createDefaults(), { messages, maxContext: 8192 })).prompt, '');
});

test('manual memories are source-free; excluded or mismatched summaries cannot be injected', async () => {
    let doc = append(enable(), await entry('a', 1, 2));
    doc = append(doc, { id: 'manual', kind: 'manual', text: '计划尚未完成。', source: null });
    const changed = structuredClone(messages); changed[0].mes = '改变';
    const plan = await buildPlan(doc, createDefaults(), { messages: changed, maxContext: 8192 });
    assert.deepEqual(plan.memoryIds, ['manual']);
    assert.match(plan.prompt, /手动补充/);
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
    doc = applyOperation(doc, { id: 'undo', type: 'entry', entryId: 'a', expectedRevision: 3, action: 'undo' }).document;
    assert.equal(doc.entries[0].text, original.text);
});

test('stale enable and summary epochs cannot overwrite changes, replay IDs never hide different content', () => {
    const doc = enable();
    assert.throws(() => applyOperation(doc, { id: 'old', type: 'enable', expectedRevision: 0, enabled: false }));
    const op = { id: 'manual1', type: 'append', entry: { id: 'm', kind: 'manual', text: '手动', source: null } };
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
