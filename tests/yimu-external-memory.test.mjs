import test from 'node:test';
import assert from 'node:assert/strict';
import {createExternalMemoryRegistry, normalizeExternalEntries, validateExternalAdapter} from '../yimu/external-memory-contract.mjs';

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
