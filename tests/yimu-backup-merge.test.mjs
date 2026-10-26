import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocument} from '../yimu/contract.mjs';
import {mergeBackupDocument} from '../yimu/backup-merge.mjs';
import {validateScenes} from '../yimu/scene-contract.mjs';

const binding = {avatar: 'Role.png', file: 'story', integrity: 'story-integrity'};
const hash = 'a'.repeat(64);
const source = (start = 1, end = 3) => ({start, end, hashes: Array(end - start + 1).fill(hash)});
const entry = (patch = {}) => ({id: 'one', revision: 1, kind: 'summary', text: '已发生的故事', source: source(),
    status: 'active', edited: false, history: [], conflicts: [], candidate: null, scenes: validateScenes(), ...patch});
const document = (...entries) => ({...createDocument(binding), entries, entryOrder: entries.map(item => item.id)});
const past = value => {const {history, conflicts, candidate, ...result} = structuredClone(value); return result;};
const merge = (a, b, options = {}) => mergeBackupDocument(a, b, {operationId: 'import-one', packageId: 'package-one', ...options});

test('exactly repeated memories do not increment revisions or add receipts, irrespective of export settings', () => {
    const current = document(entry());
    const incoming = {...document(entry()), enabled: true, autoSummary: true, revision: 40, settings: {model: 'different'}};
    const result = merge(current, incoming);
    assert.equal(result.outcome, 'duplicate');
    assert.deepEqual(result.document, current);
    assert.deepEqual(current.operations, []);
});

test('additive import preserves receiving enablement, API settings, initial scope and established order', () => {
    const current = {...document(entry({id: 'a'}), entry({id: 'b', source: source(4, 6)})),
        enabled: false, autoSummary: false, settings: {profileId: 'local-profile', model: 'local-model'},
        initialRange: {start: 1, end: 6, total: 6}, entryOrder: ['b', 'a']};
    const incoming = {...document(entry({id: 'c', kind: 'manual', source: null, edited: true,
        placement: {binding, fromFloor: 4, hash}, scenes: [{nature: 'unknown', evidence: {floors: []}}]})), enabled: true,
        settings: {profileId: 'foreign-profile'}, entryOrder: ['c']};
    const result = merge(current, incoming);
    assert.equal(result.outcome, 'merged');
    assert.equal(result.counts.added, 1);
    assert.deepEqual(result.document.entryOrder, ['b', 'a', 'c']);
    assert.deepEqual(result.document.settings, current.settings);
    assert.deepEqual(result.document.initialRange, current.initialRange);
    assert.equal(result.document.enabled, false);
    assert.equal(result.document.autoSummary, false);
    assert.deepEqual(result.document.entries[2].placement, incoming.entries[0].placement);
    assert.deepEqual(result.document.entries[2].scenes, validateScenes(incoming.entries[0].scenes));
    assert.equal(current.entries.length, 2, 'inputs are not mutated');
});

test('same operation retries are duplicates and ID reuse for different data is rejected', () => {
    const incoming = document(entry());
    const first = merge(document(), incoming);
    assert.equal(merge(first.document, incoming).outcome, 'duplicate');
    assert.throws(() => merge(first.document, document(entry({text: '另一个包内容'}))), /不同内容/);
    const repeated = merge(first.document, incoming, {operationId: 'other-operation', packageId: 'other-package'});
    assert.equal(repeated.outcome, 'duplicate');
    assert.equal(repeated.document.operations.length, 1);
});

test('a proven linear newer version is adopted while the prior version remains in history', () => {
    const original = entry();
    const next = entry({revision: 2, text: '经用户修订后的故事', edited: true, history: [past(original)]});
    const result = merge(document(original), document(next));
    assert.equal(result.document.entries[0].text, next.text);
    assert.deepEqual(result.document.entries[0].history, [past(original)]);
    assert.equal(result.counts.conflicts, 0);
});

test('a revision number without shared history cannot overwrite human work', () => {
    const current = document(entry({revision: 3, edited: true, text: '接收端手修'}));
    const incoming = document(entry({revision: 100, text: '备份另一版'}));
    const result = merge(current, incoming);
    assert.equal(result.document.entries[0].text, '接收端手修');
    assert.equal(result.document.entries[0].conflicts[0].text, '备份另一版');
    const again = merge(result.document, incoming, {operationId: 'again', packageId: 'new-package'});
    assert.equal(again.outcome, 'duplicate');
    assert.equal(again.document.entries[0].conflicts.length, 1);
});

test('an import never reactivates receiving deletions, exclusions or invalid records', () => {
    for (const status of ['deleted', 'excluded', 'invalid']) {
        const local = entry({status, revision: 2});
        const next = entry({revision: 3, history: [past(local)]});
        const result = merge(document(local), document(next));
        assert.equal(result.document.entries[0].status, status);
        assert.equal(result.document.entries[0].conflicts[0].status, 'active');
    }
});

test('even proven descendants do not strip the receiving human-edit protection', () => {
    const local = entry({edited: true, revision: 2, text: '人工稿'});
    const incoming = entry({revision: 3, edited: false, text: '自动稿', history: [past(local)]});
    const result = merge(document(local), document(incoming));
    assert.equal(result.document.entries[0].text, local.text);
    assert.equal(result.document.entries[0].edited, true);
    assert.equal(result.document.entries[0].conflicts[0].text, incoming.text);
});

test('different IDs cannot bypass a protected source range or activate duplicate summaries', () => {
    for (const status of ['active', 'deleted', 'excluded']) {
        const local = entry({status});
        const incoming = entry({id: 'new-id', text: '另一个摘要', source: source(2, 4)});
        const result = merge(document(local), document(incoming));
        assert.equal(result.document.entries.length, 1);
        assert.equal(result.document.entries[0].status, status);
        assert.equal(result.document.entries[0].conflicts[0].text, incoming.text);
        assert.deepEqual(result.document.entryOrder, ['one']);
    }
});

test('forked placement and scene metadata survive as an unadopted conflict', () => {
    const local = entry({kind: 'manual', source: null, edited: true, placement: {binding, fromFloor: 3, hash}});
    const other = {...structuredClone(local), placement: {binding, fromFloor: 7, hash}, scenes: [{nature: 'dream', place: '梦中庭院', evidence: {floors: [7]}}]};
    const result = merge(document(local), document(other));
    assert.equal(result.document.entries[0].placement.fromFloor, 3);
    assert.equal(result.document.entries[0].conflicts[0].placement.fromFloor, 7);
    assert.deepEqual(result.document.entries[0].conflicts[0].scenes, validateScenes(other.scenes));
});

test('incoming stages with unresolved parent versions are retained but invalidated', () => {
    const parent = entry();
    const stage = entry({id: 'stage', kind: 'stage', text: '旧父版本的阶段', source: {ranges: [source()], parents: [{id: parent.id, revision: 99}]}});
    const result = merge(document(parent), document(parent, stage));
    const imported = result.document.entries.find(item => item.id === 'stage');
    assert.equal(imported.status, 'invalid');
    assert.equal(imported.history.at(-1).status, 'active');
});

test('a matching tip with contradictory older history is not proof of a linear successor', () => {
    const base = entry({text: '接收端最早稿'});
    const local = entry({revision: 2, text: '两端相同现稿', history: [past(base)]});
    const foreignBase = entry({text: '导出端不同最早稿'});
    const incoming = entry({revision: 3, text: '待选择后继', history: [past(foreignBase), past(local)]});
    const result = merge(document(local), document(incoming));
    assert.equal(result.document.entries[0].text, local.text);
    assert.ok(result.document.entries[0].conflicts.some(item => item.text === '待选择后继'));
    assert.ok(result.document.entries[0].conflicts.some(item => item.text === '导出端不同最早稿'));
    assert.equal(result.document.entries[0].history[0].text, '接收端最早稿');
});

test('imported history, candidates and conflict drafts are all preserved without replacing the receiver candidate', () => {
    const base = entry({text: '旧稿'});
    const local = entry({revision: 3, text: '当前稿', candidate: {id: 'local-candidate', text: '本机待采用稿'}});
    const incoming = entry({revision: 3, text: '当前稿', history: [past(base)],
        candidate: {id: 'foreign-candidate', text: '备份待采用稿'}, conflicts: [{id: 'foreign-conflict', text: '备份冲突稿'}]});
    const result = merge(document(local), document(incoming));
    const merged = result.document.entries[0];
    assert.equal(merged.candidate.text, '本机待采用稿');
    assert.equal(merged.history[0].text, '旧稿');
    assert.deepEqual(new Set(merged.conflicts.map(item => item.text)), new Set(['备份待采用稿', '备份冲突稿']));
    assert.equal(merge(result.document, document(incoming), {operationId: 'again'}).outcome, 'duplicate');
});

test('legacy snapshots without scene defaults still prove the same original version', () => {
    const original = entry();
    const oldSnapshot = past(original); delete oldSnapshot.scenes;
    const incoming = entry({revision: 2, text: '已证明的新版', history: [oldSnapshot]});
    const result = merge(document(original), document(incoming));
    assert.equal(result.document.entries[0].text, '已证明的新版');
    assert.equal(result.counts.conflicts, 0);
});

test('foreign identity and malformed operation IDs cannot enter the merge', () => {
    const other = document(entry()); other.binding = {...binding, integrity: 'not-mapped'};
    assert.throws(() => merge(document(), other), /尚未映射/);
    assert.throws(() => merge(document(), document(entry()), {operationId: '../oops'}), /操作标识/);
});
