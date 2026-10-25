import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOperation, createDocument, createDefaults, fingerprintMessages, DEFAULTS } from '../yimu/contract.mjs';
import { stageSourceFromParents } from '../yimu/stage-contract.mjs';
import { nextStage } from '../yimu/layers.mjs';
import { buildPlan } from '../yimu/core.mjs';

// Independent synthetic review cases; no network, browser, real account or model calls.
const binding = { avatar: 'Review.png', file: 'Synthetic story', integrity: 'review-layer-identity' };
async function fixture() {
    const messages = Array.from({ length: 16 }, (_, i) => ({ name: i % 2 ? '甲' : '乙', is_user: i % 2 === 0, mes: `合成原文第${i + 1}层：他们走过旧桥。`, send_date: String(i) }));
    const hashes = await fingerprintMessages(messages);
    let doc = applyOperation(createDocument(binding), { id: 'enable', type: 'enable', expectedRevision: 0, enabled: true, range: { start: 1, end: 16, total: 16 } }).document;
    for (let i = 0; i < 4; i++) {
        doc = applyOperation(doc, { id: `append-fine-${i}`, type: 'append', expectedEpoch: doc.epoch, entry: {
            id: `fine-${i}`, kind: 'summary', text: `已核对的第${i + 1}份细摘要。只有甲知晓的约定尚未告诉乙。`,
            source: { start: i * 2 + 1, end: i * 2 + 2, hashes: hashes.slice(i * 2, i * 2 + 2) },
        } }).document;
    }
    const refs = (document, ids) => ids.map(id => ({ id, revision: document.entries.find(entry => entry.id === id).revision }));
    const append = (document, id, ids) => applyOperation(document, { id: `op-${id}`, type: 'append', expectedEpoch: document.epoch, entry: {
        id, kind: 'stage', text: `阶段${id}的精简内容。`, source: { parents: refs(document, ids) },
    } }).document;
    const syntheticStage = (document, id, ids, patch = {}) => ({ id, revision: 1, kind: 'stage', text: `阶段${id}的精简内容。`,
        source: stageSourceFromParents(document, refs(document, ids)), status: 'active', edited: false, history: [], candidate: null, conflicts: [], ...patch });
    return { doc, messages, append, syntheticStage };
}

test('review: distinct concurrent operation IDs cannot append duplicate or partly overlapping stages', async () => {
    const f = await fixture(); const doc = f.append(f.doc, 'first', ['fine-0', 'fine-1']);
    assert.throws(() => f.append(doc, 'second', ['fine-0', 'fine-1']), /阶段|重叠|整理/);
    assert.throws(() => f.append(doc, 'partial', ['fine-1', 'fine-2']), /阶段|重叠|整理/);
    assert.equal(doc.entries.filter(entry => entry.kind === 'stage').length, 1);
});

for (const action of ['exclude', 'delete']) test(`review: ${action} stage blocks silent reconstruction and a new overlapping stage`, async () => {
    const f = await fixture(); let doc = f.append(f.doc, 'kept', ['fine-0', 'fine-1']);
    doc = applyOperation(doc, { id: action, type: 'entry', action, entryId: 'kept', expectedRevision: 1 }).document;
    const next = nextStage(doc, { ...DEFAULTS, stageAuto: true, stageBasis: 'slices', stageThreshold: 2 });
    assert.deepEqual(next?.parents.map(entry => entry.id), ['fine-2', 'fine-3']);
    assert.throws(() => f.append(doc, 'recreated', ['fine-0', 'fine-1']), /阶段|重叠|整理/);
    const plan = await buildPlan(doc, createDefaults(), { messages: f.messages, maxContext: 8192 });
    assert.ok(!plan.memoryIds.includes('fine-0') && !plan.memoryIds.includes('fine-1'));
});

test('review: existing anomalous overlapping automatic stages never duplicate source coverage in a request', async () => {
    const f = await fixture(), doc = structuredClone(f.doc);
    doc.entries.push(f.syntheticStage(doc, 'older', ['fine-0', 'fine-1']), f.syntheticStage(doc, 'overlap', ['fine-1', 'fine-2']));
    doc.settings.recall = false;
    const plan = await buildPlan(doc, createDefaults(), { messages: f.messages, maxContext: 8192 });
    const floors = new Set();
    for (const range of plan.coveredRanges) for (let floor = range.start; floor <= range.end; floor++) {
        assert.ok(!floors.has(floor), `floor ${floor} appeared in more than one selected entry`); floors.add(floor);
    }
});

for (const protection of ['edited', 'excluded', 'deleted']) test(`review: ${protection} stage cannot be bypassed by another overlapping stage`, async () => {
    const f = await fixture(), doc = structuredClone(f.doc);
    const protectedStage = f.syntheticStage(doc, 'protected', ['fine-0', 'fine-1'], protection === 'edited'
        ? { edited: true, text: '用户确认：他们并未达成约定。' } : { status: protection });
    doc.entries.push(protectedStage, f.syntheticStage(doc, 'bypass', ['fine-1', 'fine-2']));
    doc.settings.recall = false;
    const plan = await buildPlan(doc, createDefaults(), { messages: f.messages, maxContext: 8192 });
    assert.ok(!plan.memoryIds.includes('bypass'), 'an overlapping stage must not evade the protected parent set');
    assert.ok(!plan.memoryIds.includes('fine-0') && !plan.memoryIds.includes('fine-1'));
    if (protection === 'edited') assert.ok(plan.memoryIds.includes('protected'));
});

test('review: two conflicting manual stages do not silently choose a winner or use their automatic children', async () => {
    const f = await fixture(), doc = structuredClone(f.doc);
    doc.entries.push(f.syntheticStage(doc, 'manual-one', ['fine-0', 'fine-1'], { edited: true, text: '用户版本一：甲未告知乙。' }),
        f.syntheticStage(doc, 'manual-two', ['fine-1', 'fine-2'], { edited: true, text: '用户版本二：甲已经告诉乙。' }));
    const plan = await buildPlan(doc, createDefaults(), { messages: f.messages, maxContext: 8192 });
    assert.ok(!plan.memoryIds.some(id => ['manual-one', 'manual-two', 'fine-0', 'fine-1', 'fine-2'].includes(id)));
});

test('review: recent raw and uncovered floors are never included merely through a stage min-max bound', async () => {
    const f = await fixture(); const doc = f.append(f.doc, 'early', ['fine-0', 'fine-1']);
    const messages = f.messages.slice(0, 10), before = structuredClone(messages);
    const plan = await buildPlan(doc, createDefaults(), { messages, maxContext: 8192 });
    assert.ok(plan.coveredRanges.every(range => range.end <= 5));
    assert.ok(!plan.coveredRanges.some(range => range.start <= 5 && range.end >= 5), 'the fine slice crossing the recent cutoff stays raw');
    assert.deepEqual(messages, before);
    const swipe = await buildPlan(doc, createDefaults(), { messages, maxContext: 8192 }, { type: 'swipe' });
    assert.ok(swipe.coveredRanges.every(range => range.end <= 4));
});
