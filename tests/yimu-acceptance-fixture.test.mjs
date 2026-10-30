import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, applyOperation, fingerprintMessages, DEFAULTS } from '../yimu/contract.mjs';
import { initialRangePreview, inspectSources, selectMemories } from '../yimu/core.mjs';
import { planStageRange } from '../yimu/layers.mjs';
import { selectStoryEntries } from '../yimu/story-contract.mjs';
import { recallCandidates } from '../yimu/recall.mjs';

const binding = { avatar: '验收角色.png', file: '忆幕验收副本', integrity: 'acceptance-fixture' };
const messages = Array.from({ length: 6 }, (_, index) => ({
    name: index % 2 ? '角色' : '用户', is_user: index % 2 === 0, is_system: index === 1,
    mes: `第${index + 1}层：一段用于验收来源、时空和续接边界的合成正文。`, send_date: String(index + 1),
}));

const change = (document, operation) => applyOperation(document, operation).document;
const entry = (id, kind, text, source, extra = {}) => ({ id, kind, text, source, ...extra });

async function fixture() {
    const hashes = await fingerprintMessages(messages);
    let document = change(createDocument(binding), { id: 'enable', type: 'enable', enabled: true, expectedRevision: 0, range: { start: 1, end: 6, total: 6 } });
    document = change(document, { id: 'fine-a', type: 'append', expectedEpoch: document.epoch,
        entry: entry('fine-a', 'summary', '前段共同事件：两人在桥边确认了约定。', { start: 1, end: 2, hashes: hashes.slice(0, 2) }) });
    document = change(document, { id: 'fine-b', type: 'append', expectedEpoch: document.epoch,
        entry: entry('fine-b', 'summary', '后段行动：角色带着约定离开桥边。', { start: 3, end: 4, hashes: hashes.slice(2, 4) }) });
    document = change(document, { id: 'custom', type: 'append', afterId: 'fine-b', expectedEpoch: document.epoch,
        entry: entry('custom', 'manual', '用户明确补充：这份约定仍然有效。', null,
            { placement: { binding, fromFloor: 5, hash: hashes[4] }, title: '约定仍在' }) });
    return { document, hashes };
}

test('synthetic acceptance fixture keeps hidden floors eligible for memory work', async () => {
    const hashes = await fingerprintMessages(messages);
    let document = change(createDocument(binding), { id: 'enable-only', type: 'enable', enabled: true, expectedRevision: 0, range: { start: 1, end: 6, total: 6 } });
    const preview = initialRangePreview(document, messages, { start: 1, end: 6 }, { recent: 2 });
    assert.deepEqual(preview.hidden, [2]);
    assert.ok(preview.eligible.includes(2), 'ST hidden/display state must not block memory summarization');
    assert.ok(preview.recent.includes(5) && preview.recent.includes(6));
    assert.equal(hashes.length, messages.length);
});

test('synthetic acceptance fixture keeps custom slices in ordered stage and cutoff selection only when requested', async () => {
    const { document, hashes } = await fixture();
    const withoutCustom = planStageRange(document, DEFAULTS, { start: 1, end: 5, includeCustom: false });
    assert.deepEqual(withoutCustom.parents.map(item => item.id), ['fine-a', 'fine-b']);
    const withCustom = planStageRange(document, DEFAULTS, { start: 1, end: 5, includeCustom: true });
    assert.deepEqual(withCustom.parents.map(item => item.id), ['fine-a', 'fine-b', 'custom']);
    assert.equal(withCustom.includeCustom, true);
    assert.equal(withCustom.parents.at(-1).placement.hash, hashes[4]);
});

test('synthetic acceptance fixture does not carry post-cutoff memory into a continuation', async () => {
    const { document } = await fixture();
    const validIds = new Set(document.entries.map(entry => entry.id));
    const selected = selectStoryEntries(document, 4, validIds, { total: 6 });
    assert.deepEqual(selected.entries.map(entry => entry.id), ['fine-a', 'fine-b']);
    assert.equal(selected.entries.some(entry => entry.id === 'custom'), false);
});

test('synthetic acceptance fixture keeps changed-source memories factual but excludes them from new candidates', async () => {
    const { document, hashes } = await fixture();
    const changedMessages = messages.map((message, index) => index === 1 ? { ...message, mes: `${message.mes}（正文已修订）` } : message);
    const changedHashes = await fingerprintMessages(changedMessages);
    assert.notEqual(changedHashes[1], hashes[1]);

    const invalidated = change(document, { id: 'invalidate-fine-a', type: 'invalidate', entries: [{ id: 'fine-a', revision: 1 }] });
    const inspection = await inspectSources(document, changedMessages);
    assert.deepEqual(inspection.invalid.map(item => item.id), ['fine-a']);
    const injected = selectMemories(invalidated, { messages: changedMessages }, { ...DEFAULTS }, changedHashes);
    assert.equal(injected.find(item => item.id === 'fine-a')?.text, '前段共同事件：两人在桥边确认了约定。', '来源变化只改变状态，不阻塞旧记忆注入');

    const fineA = invalidated.entries.find(entry => entry.id === 'fine-a');
    assert.equal(fineA.status, 'invalid');
    assert.equal(fineA.text, '前段共同事件：两人在桥边确认了约定。');

    // The normal recall path is intentionally paused by an active custom slice;
    // use the summary-only projection here so this fixture isolates source drift.
    const retrievalDocument = { ...invalidated, entries: invalidated.entries.filter(entry => entry.kind === 'summary') };
    const candidates = recallCandidates(retrievalDocument, { ...DEFAULTS, recent: 1 }, messages, { start: 5, end: 6 }, changedHashes);
    assert.equal(candidates.some(candidate => candidate.id === 'fine-a'), false, '正文变更后的切片不能进入新一轮候选');
    assert.equal(candidates.some(candidate => candidate.id === 'fine-b'), true, '未变化的来源仍可进入候选');
});

test('synthetic acceptance fixture treats missing source and foreign-origin entries as non-candidates', async () => {
    const { document, hashes } = await fixture();
    const noSourceCandidates = recallCandidates(document, { ...DEFAULTS, recent: 1 }, messages, { start: 5, end: 6 }, []);
    assert.deepEqual(noSourceCandidates, [], '缺失正文文件时不应伪造可用候选');

    const foreign = {
        ...structuredClone(document.entries.find(entry => entry.id === 'fine-a')),
        id: 'foreign-fine',
        origin: { binding: { avatar: '另一角色.png', file: '另一聊天', integrity: 'foreign-integrity' }, offset: 0 },
    };
    const mixed = structuredClone(document); mixed.entries.push(foreign);
    const candidates = recallCandidates(mixed, { ...DEFAULTS, recent: 1 }, messages, { start: 5, end: 6 }, hashes);
    assert.equal(candidates.some(candidate => candidate.id === 'foreign-fine'), false, '其他聊天的继承来源不能串入当前候选');
});

test('synthetic acceptance fixture keeps exclusion and deletion explicit without reviving them in continuation', async () => {
    const { document } = await fixture();
    const excluded = change(document, { id: 'exclude-fine-b', type: 'entry', action: 'exclude', entryId: 'fine-b', expectedRevision: 1 });
    assert.equal(excluded.entries.find(entry => entry.id === 'fine-b').status, 'excluded');
    const restored = change(excluded, { id: 'restore-fine-b', type: 'entry', action: 'restore', entryId: 'fine-b', expectedRevision: 2 });
    assert.equal(restored.entries.find(entry => entry.id === 'fine-b').status, 'active');
    const deleted = change(restored, { id: 'delete-fine-a', type: 'entry', action: 'delete', entryId: 'fine-a', expectedRevision: 1 });
    assert.equal(deleted.entries.find(entry => entry.id === 'fine-a').status, 'deleted');
    const validIds = new Set(deleted.entries.map(entry => entry.id));
    const selected = selectStoryEntries(deleted, 4, validIds, { total: 6 });
    assert.deepEqual(selected.entries.map(entry => entry.id), ['fine-b']);
});
