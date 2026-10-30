import test from 'node:test';
import assert from 'node:assert/strict';
import {createExternalMemoryRegistry, filterExternalCandidates, normalizeExternalEntries, validateExternalAdapter} from '../yimu/external-memory-contract.mjs';

test('external memory requires an explicit read-only adapter and ignores unknown prompt tags', () => {
    assert.throws(() => validateExternalAdapter({id: 'gaga'}), /只读入口/);
    const adapter = {id: 'gaga', label: '合成记忆', version: '1', read: () => []};
    const entries = normalizeExternalEntries({xml: '<gaga_memory>不应被解析</gaga_memory>', entries: [
        {id: 'a', text: '  甲在雨夜回到旧屋。  ', tags: ['夜', '叙事']},
        {id: 'a', text: '甲在雨夜回到旧屋。'},
        {id: 'empty', text: ''},
    ]}, adapter);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].text, '甲在雨夜回到旧屋。');
    assert.equal(entries[0].readOnly, true);
    assert.equal(entries[0].trusted, false);
    assert.equal(entries[0].canReplaceSource, false);
    assert.deepEqual(entries[0].tags, ['夜', '叙事']);
});

test('registry reads registered adapters independently and keeps failures out of the candidate list', async () => {
    const registry = createExternalMemoryRegistry([
        {id: 'first', label: '第一来源', read: async () => ({entries: [{id: 'one', text: '第一条'}]})},
        {id: 'broken', label: '故障来源', read: async () => { throw new Error('来源暂不可读'); }},
        {id: 'second', label: '第二来源', read: () => [{id: 'two', summary: '第二条'}]},
    ]);
    const result = await registry.read({binding: {file: 'chat'}}, {scope: 'chat'});
    assert.deepEqual(result.entries.map(entry => entry.id), ['first:one', 'second:two']);
    assert.deepEqual(result.diagnostics.map(item => item.status), ['ok', 'error', 'ok']);
    assert.equal(registry.list().some(item => 'read' in item), false);
});

test('external normalization bounds large data, deduplicates exact records and never gains source replacement authority', () => {
    const adapter = {id: 'bounded', label: '边界来源', read: () => []};
    const text = '字'.repeat(12000);
    const source = Array.from({length: 205}, (_, index) => ({id: `entry-${index}`, text}));
    const entries = normalizeExternalEntries(source, adapter);
    assert.equal(entries.length, 41);
    assert.ok(entries.every(entry => entry.text.length === 12000));
    assert.ok(entries.every(entry => entry.source.kind === 'external' && entry.canReplaceSource === false));
});

test('candidate filtering uses explicit scope and knowledge boundaries while missing metadata remains eligible', () => {
    const adapter = {id: 'gaga', label: '合成来源', read: () => []};
    const entries = normalizeExternalEntries([
        {id: 'same', text: '同一故事事实', scope: 'chat', storyId: 'story-a', timeline: 't1', knownTo: ['甲']},
        {id: 'other-story', text: '另一故事', scope: 'chat', storyId: 'story-b'},
        {id: 'unknown', text: '没有时空与知情标记', scope: 'chat'},
        {id: 'private', text: '只对乙可知', scope: 'chat', knownTo: ['乙']},
        {id: 'blocked', text: '用户暂不注入', scope: 'chat', injectionBlocked: true},
    ], adapter);
    const result = filterExternalCandidates(entries, {scope: 'chat', storyId: 'story-a', timeline: 't1', knownTo: ['甲'], adapterIds: ['gaga']});
    assert.deepEqual(result.map(entry => entry.id), ['gaga:same', 'gaga:unknown']);
    assert.deepEqual(filterExternalCandidates(entries, {scope: 'chat', blockedIds: ['gaga:unknown']}).map(entry => entry.id), ['gaga:same', 'gaga:other-story', 'gaga:private']);
});

test('registered external entries inherit the current chat identity and reject another chat even with identical prose', async () => {
    const adapter = { id: 'gaga', label: '合成来源', read: async () => [
        { id: 'same-prose', text: '同样的雨夜，角色回到旧屋。', scope: 'chat' },
    ] };
    const registry = createExternalMemoryRegistry([adapter]);
    const current = { avatar: '秦铎.png', file: 'main', integrity: 'source-main' };
    const other = { avatar: '秦铎.png', file: 'branch', integrity: 'source-branch' };
    const currentResult = await registry.read({ binding: current }, { scope: 'chat' });
    const otherResult = await registry.read({ binding: other }, { scope: 'chat' });
    const currentKey = JSON.stringify([current.avatar, current.file, current.integrity]);
    const otherKey = JSON.stringify([other.avatar, other.file, other.integrity]);
    assert.equal(currentResult.entries[0].chatKey, currentKey);
    assert.equal(otherResult.entries[0].chatKey, otherKey);
    assert.deepEqual(filterExternalCandidates(currentResult.entries, { scope: 'chat', chatKey: currentKey }).map(entry => entry.id), ['gaga:same-prose']);
    assert.deepEqual(filterExternalCandidates(currentResult.entries, { scope: 'chat', chatKey: otherKey }), []);
});

test('mixed external candidates with identical prose are filtered by chat identity before they can be ranked', () => {
    const adapter = { id: 'gaga', label: '合成来源', read: () => [] };
    const current = JSON.stringify(['秦铎.png', 'main', 'source-main']);
    const other = JSON.stringify(['秦铎.png', 'branch', 'source-branch']);
    const entries = normalizeExternalEntries([
        {id: 'main', text: '同一封信在港口被重新提起。'},
        {id: 'branch', text: '同一封信在港口被重新提起。'},
    ], adapter, {chatKey: current});
    entries[1].chatKey = other;
    const filtered = filterExternalCandidates(entries, {scope: 'chat', chatKey: current});
    assert.deepEqual(filtered.map(entry => entry.id), ['gaga:main']);
    assert.equal(filtered[0].text, '同一封信在港口被重新提起。', 'text equality must not defeat the structural boundary');
});

test('chat-scoped external candidates without an identity are not eligible when a chat identity is known', () => {
    const adapter = { id: 'gaga', label: '合成来源', read: () => [] };
    const entries = normalizeExternalEntries([{ id: 'same-prose', text: '同样的雨夜，角色回到旧屋。' }], adapter);
    assert.deepEqual(filterExternalCandidates(entries, { scope: 'chat', chatKey: 'current-chat' }), []);
});
