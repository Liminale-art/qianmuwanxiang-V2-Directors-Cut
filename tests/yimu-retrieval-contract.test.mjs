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
    const context = retrievalContext({ binding: { avatar: '秦铎.png', file: 'main', integrity: 'source-main' }, storyId: 'story', timeline: 'A', entries: [
        { id: 'blocked', status: 'excluded' }, { id: 'shielded', injectionBlocked: true },
    ] }, { beforeFloor: 8, invalidIds: ['stale'] });
    assert.deepEqual(context, { scope: 'chat', chatKey: JSON.stringify(['秦铎.png', 'main', 'source-main']), storyId: 'story', timeline: 'A', beforeFloor: 8,
        invalidIds: ['stale'], blockedIds: ['blocked', 'shielded'] });
});

test('similar local text cannot cross an explicit chat boundary or revive blocked sources', () => {
    const current = JSON.stringify(['秦铎.png', 'main', 'source-main']);
    const other = JSON.stringify(['秦铎.png', 'branch', 'source-branch']);
    const result = filterLocalRetrievalCandidates([
        local('current', { chatKey: current, text: '同样的雨夜，角色回到旧屋。' }),
        local('other-chat', { chatKey: other, text: '同样的雨夜，角色回到旧屋。' }),
        local('blocked', { chatKey: current, injectionBlocked: true, text: '同样的雨夜，角色回到旧屋。' }),
    ], { beforeFloor: 3, chatKey: current });
    assert.deepEqual(result.map(item => item.id), ['current']);
});

test('local candidate filtering rejects invalid, blocked, other-story, other-branch and unknown-knowledge records before rerank', () => {
    const current = JSON.stringify(['秦铎.png', 'main', 'source-main']);
    const values = [
        local('current', {chatKey: current, storyId: 'world', timeline: 'winter', knownTo: ['甲'], text: '同一封信在港口被重新提起。'}),
        local('other-story', {chatKey: current, storyId: 'other-world', timeline: 'winter', knownTo: ['甲'], text: '同一封信在港口被重新提起。'}),
        local('other-branch', {chatKey: current, storyId: 'world', timeline: 'summer', knownTo: ['甲'], text: '同一封信在港口被重新提起。'}),
        local('unknown-to', {chatKey: current, storyId: 'world', timeline: 'winter', knownTo: ['乙'], text: '同一封信在港口被重新提起。'}),
        local('blocked', {chatKey: current, storyId: 'world', timeline: 'winter', knownTo: ['甲'], injectionBlocked: true, text: '同一封信在港口被重新提起。'}),
        local('invalid', {chatKey: current, storyId: 'world', timeline: 'winter', knownTo: ['甲'], status: 'invalid', text: '同一封信在港口被重新提起。'}),
    ];
    const result = filterLocalRetrievalCandidates(values, {
        beforeFloor: 3, chatKey: current, storyId: 'world', timeline: 'winter', knownTo: ['甲'],
        blockedIds: ['blocked'], invalidIds: ['invalid'],
    });
    assert.deepEqual(result.map(item => item.id), ['current']);
    assert.equal(result[0].text, '同一封信在港口被重新提起。');
});
