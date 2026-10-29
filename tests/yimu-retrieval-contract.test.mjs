import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRetrievalCandidates, filterLocalRetrievalCandidates, retrievalContext } from '../yimu/retrieval-contract.mjs';
import { normalizeExternalEntries } from '../yimu/external-memory-contract.mjs';

const local = (id, patch = {}) => ({ id, revision: 1, start: 1, end: 2, text: `${id} 的正文`, ...patch });
const adapter = { id: 'gaga', label: 'Gaga', version: '1', read: async () => [] };

test('local retrieval structure keeps only prior, usable candidates and never mutates input', () => {
    const values = [
        local('prior'),
        local('current', { start: 3, end: 5 }),
        local('blocked', { injectionBlocked: true }),
        local('deleted', { status: 'deleted' }),
        local('wrong-story', { storyId: 'other' }),
        { id: 'malformed', start: 1, end: 0 },
    ];
    const before = structuredClone(values);
    const result = filterLocalRetrievalCandidates(values, { beforeFloor: 3, storyId: 'main' });
    assert.deepEqual(result.map(item => item.id), ['prior']);
    assert.deepEqual(values, before);
});

test('retrieval snapshot merges only explicitly filtered read-only external entries', () => {
    const external = normalizeExternalEntries([
        { id: 'same', text: '外部同名', scope: 'chat', storyId: 'main' },
        { id: 'other-story', text: '另一故事', scope: 'chat', storyId: 'other' },
        { id: 'blocked', text: '暂不注入', scope: 'chat', injectionBlocked: true },
    ], adapter);
    const result = buildRetrievalCandidates({
        localCandidates: [local('same')],
        externalCandidates: external,
        context: { scope: 'chat', storyId: 'main', beforeFloor: 3 },
        at: 123,
    });
    assert.deepEqual(result.candidates.map(item => item.id), ['same', 'gaga:same']);
    assert.equal(result.localCount, 1); assert.equal(result.externalCount, 1); assert.equal(result.count, 2); assert.equal(result.at, 123);
    assert.equal(result.candidates[1].sourceLabel, 'Gaga（只读）');
});

test('retrieval context derives only optional story metadata and explicit invalid ids', () => {
    const context = retrievalContext({ storyId: 'story', timeline: 'A', entries: [
        { id: 'blocked', status: 'excluded' }, { id: 'shielded', injectionBlocked: true },
    ] }, { beforeFloor: 8, invalidIds: ['stale'] });
    assert.deepEqual(context, { scope: 'chat', storyId: 'story', timeline: 'A', beforeFloor: 8,
        invalidIds: ['stale'], blockedIds: ['blocked', 'shielded'] });
});
