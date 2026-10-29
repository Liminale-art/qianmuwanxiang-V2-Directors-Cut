import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, applyOperation, fingerprintMessages, DEFAULTS } from '../yimu/contract.mjs';
import { initialRangePreview } from '../yimu/core.mjs';
import { planStageRange } from '../yimu/layers.mjs';
import { selectStoryEntries } from '../yimu/story-contract.mjs';

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
