import test from 'node:test';
import assert from 'node:assert/strict';
import { cosineSimilarity, discoverVectorCandidates, normalizeVector, rankVectorCandidates } from '../yimu/vector-contract.mjs';

test('vector normalization and cosine ranking are bounded and do not expose vectors', () => {
    assert.deepEqual(normalizeVector([3, 4]), [0.6, 0.8]);
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
    const ranked = rankVectorCandidates([{ id: 'near', text: '近', vector: [1, 0] }, { id: 'far', text: '远', vector: [0, 1] }], [1, 0]);
    assert.deepEqual(ranked.map(item => item.id), ['near', 'far']);
    assert.equal('vector' in ranked[0], false);
});

test('missing vector provider is a quiet fallback and provider results stay read-only', async () => {
    const unavailable = await discoverVectorCandidates({ query: '当前', candidates: [{ id: 'a', text: '记忆' }] });
    assert.equal(unavailable.status, 'unavailable'); assert.deepEqual(unavailable.candidates, []);
    const received = [];
    const ready = await discoverVectorCandidates({ query: '当前', candidates: [{ id: 'a', text: '记忆', title: '一' }, { id: 'b', text: '另一条', title: '二' }], context: { storyId: 's' }, provider: async input => {
        received.push(input); return { candidates: [{ id: 'b', score: 0.9 }, { id: 'a', score: 0.3 }, { id: 'unknown', score: 1 }] };
    } });
    assert.equal(ready.status, 'ready'); assert.deepEqual(ready.candidates.map(item => item.id), ['b', 'a']);
    assert.equal(received[0].query, '当前'); assert.equal(received[0].context.storyId, 's'); assert.equal('vector' in ready.candidates[0], false);
});

test('provider failures do not throw or mutate the input candidate list', async () => {
    const input = [{ id: 'a', text: '记忆' }], before = structuredClone(input);
    const result = await discoverVectorCandidates({ query: '当前', candidates: input, provider: async () => { throw new Error('接口暂不可用'); } });
    assert.equal(result.status, 'error'); assert.match(result.reason, /暂不可用/); assert.deepEqual(input, before);
});
