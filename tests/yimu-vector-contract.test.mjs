import test from 'node:test';
import assert from 'node:assert/strict';
import { cosineSimilarity, discoverRerankCandidates, discoverVectorCandidates, normalizeVector, rankVectorCandidates } from '../yimu/vector-contract.mjs';

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

test('rerank provider is optional, read-only, and maps both ids and indices without leaking scores', async () => {
    const unavailable = await discoverRerankCandidates({ query: '当前', candidates: [{ id: 'a', text: '记忆' }] });
    assert.equal(unavailable.status, 'unavailable'); assert.deepEqual(unavailable.candidates, []);
    const input = [
        { id: 'a', text: '第一条', title: '一', start: 1, end: 2, sourceLabel: '忆幕' },
        { id: 'b', text: '第二条', title: '二', start: 3, end: 4, sourceLabel: '忆幕' },
        { id: 'c', text: '第三条', title: '三', start: 5, end: 6, sourceLabel: '忆幕' },
    ];
    const before = structuredClone(input), received = [];
    const result = await discoverRerankCandidates({ query: '当前', candidates: input, limit: 2, context: { storyId: 'story' }, provider: async request => {
        received.push(request);
        return { candidates: [{ index: 2, relevance_score: 0.2 }, { id: 'b', score: 0.9 }, { id: 'unknown', score: 1 }, { id: 'a', score: 0.4 }] };
    } });
    assert.equal(result.status, 'ready');
    assert.deepEqual(result.candidates.map(candidate => candidate.id), ['b', 'a']);
    assert.equal('score' in result.candidates[0], false); assert.equal('relevance_score' in result.candidates[0], false);
    assert.equal(received[0].query, '当前'); assert.equal(received[0].context.storyId, 'story');
    assert.deepEqual(received[0].candidates.map(candidate => candidate.id), ['a', 'b', 'c']);
    assert.deepEqual(input, before);
});

test('rerank malformed or failed providers become a reviewable error instead of throwing', async () => {
    const malformed = await discoverRerankCandidates({ query: '当前', candidates: [{ id: 'a', text: '记忆' }], provider: async () => ({ nope: true }) });
    assert.equal(malformed.status, 'error'); assert.deepEqual(malformed.candidates, []);
    assert.match(malformed.reason, /格式无效/);
    const failed = await discoverRerankCandidates({ query: '当前', candidates: [{ id: 'a', text: '记忆' }], provider: async () => { throw new Error('接口暂不可用'); } });
    assert.equal(failed.status, 'error'); assert.deepEqual(failed.candidates, []); assert.match(failed.reason, /暂不可用/);
});

test('rerank is downstream of structural filtering and drops cross-chat or forged ids', async () => {
    const current = JSON.stringify(['秦铎.png', 'main', 'source-main']);
    // The caller supplies only the already-filtered current-chat pool. A
    // reranker may reorder that pool, but it cannot smuggle another chat back
    // in by returning a matching-text or unknown id.
    const pool = [{id: 'current', text: '同一封信在港口被重新提起。', title: '主线', start: 1, end: 2, chatKey: current}];
    let request;
    const result = await discoverRerankCandidates({query: '港口的信', candidates: pool, context: {chatKey: current, storyId: 'world', timeline: 'winter'}, provider: async value => {
        request = value;
        return {candidates: [
            {id: 'other-chat', score: 99},
            {id: 'current', score: 1},
            {index: 42, relevance_score: 100},
        ]};
    }});
    assert.deepEqual(request.candidates.map(item => item.id), ['current']);
    assert.deepEqual(result.candidates.map(item => item.id), ['current']);
    assert.equal(result.candidates[0].chatKey, undefined, 'provider sees only safe candidate fields');
});
