import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryWarmth, admitsAtWarmth, asksToRemember, FRESH, FADING, SUNKEN, DECAY } from '../yimu/decay.mjs';
import { applyOperation, createDocument } from '../yimu/contract.mjs';

const binding = { avatar: 'Fixture.png', file: 'fixture', integrity: 'fixture-id' };
const slice = (patch = {}) => ({ id: 's1', kind: 'summary', text: '两人在旅馆过夜。', source: { start: 1, end: 1, hashes: ['a'.repeat(64)] }, status: 'active', revision: 1, history: [], conflicts: [], ...patch });

test('warmth decays by story progress, not by wall-clock time', () => {
    const entry = slice();
    assert.equal(memoryWarmth(entry, { floor: 40 }), FRESH, 'a recent slice stays fresh however long the pause');
    assert.equal(memoryWarmth(entry, { floor: DECAY.freshWithin + 11 }), FADING, 'further along the story it fades');
    assert.equal(memoryWarmth(entry, { floor: DECAY.fadingWithin + 11 }), SUNKEN, 'much further and it sinks');
});

test('a pinned memory never decays, and being recalled warms a sunk one back up', () => {
    const entry = slice();
    assert.equal(memoryWarmth({ ...entry, pinned: true }, { floor: 100000 }), FRESH, 'pinned stays fresh forever');
    const far = DECAY.fadingWithin + 50;
    assert.equal(memoryWarmth(entry, { floor: far }), SUNKEN);
    assert.equal(memoryWarmth(entry, { floor: far, lastUsedFloor: far - 5 }), FRESH, 'recalled a few floors ago means warm again');
    assert.equal(memoryWarmth(entry, { floor: far, lastUsedFloor: far - DECAY.recallWindow - 1 }), SUNKEN, 'the warmth window is bounded');
});

test('fading needs a stronger cue and sunk needs a real one', () => {
    assert.equal(admitsAtWarmth({ warmth: FRESH, score: 0.1 }), true);
    assert.equal(admitsAtWarmth({ warmth: FADING, score: 0.1 }), false);
    assert.equal(admitsAtWarmth({ warmth: FADING, score: 2 }), true);
    assert.equal(admitsAtWarmth({ warmth: FADING, score: 0, strong: true }), true, 'a direct cue still reaches a fading memory');
    assert.equal(admitsAtWarmth({ warmth: SUNKEN, score: 5 }), false, 'words alone never surface a sunk memory');
    assert.equal(admitsAtWarmth({ warmth: SUNKEN, score: 0, strong: true }), true, 'a strong cue does');
    assert.equal(asksToRemember('你还记得那年夏天吗'), true);
    assert.equal(asksToRemember('今天天气不错'), false);
});

test('pin and exclude are mutually exclusive, and custom or edited entries are the user\'s own', () => {
    let doc = applyOperation(createDocument(binding), { id: 'enable', type: 'enable', expectedRevision: 0, enabled: true, range: { start: 1, end: 1, total: 10 } }).document;
    doc = applyOperation(doc, { id: 'append', type: 'append', expectedEpoch: doc.epoch, entry: slice() }).document;
    const pinned = applyOperation(doc, { id: 'pin', type: 'entry', entryId: 's1', expectedRevision: 1, action: 'pin' }).document;
    assert.equal(pinned.entries[0].pinned, true);
    const excluded = applyOperation(pinned, { id: 'x', type: 'entry', entryId: 's1', expectedRevision: 2, action: 'exclude' }).document;
    assert.equal(excluded.entries[0].pinned, undefined, 'excluding drops the pin');
    assert.throws(() => applyOperation(excluded, { id: 'p', type: 'entry', entryId: 's1', expectedRevision: 3, action: 'pin' }), /不能钉住/);
    const unpinned = applyOperation(pinned, { id: 'u', type: 'entry', entryId: 's1', expectedRevision: 2, action: 'unpin' }).document;
    assert.equal(unpinned.entries[0].pinned, undefined);
});
