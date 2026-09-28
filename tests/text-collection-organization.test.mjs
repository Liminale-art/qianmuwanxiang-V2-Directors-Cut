import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createDocumentSession} from '../qianmu-document-session.js';
import {createTextCollection, validateTextCollectionDocument, documentFromTextCollectionState} from '../qianmu-text-collection.js';
import {textCollectionItemOrganization, textCollectionOrganizationViews, filterTextCollectionItems} from '../qianmu-text-collection-organization.js';

const stamp = '2026-09-28T00:00:00.000Z';
const row = (id, charName = '角色', text = ' 原文\r\n\r\n  尾 ') => ({id, text, charName, userName: 'USER', createdAt: stamp, updatedAt: stamp, source: null});
const legacy = {version: 1, items: [row('one'), row('two', '另一位')]};
const classified = () => ({version: 2, items: legacy.items, organization: {
    folders: [{id: 'folder', name: '纪念'}], entries: [{itemId: 'one', folderId: 'folder', tags: ['时光', '旅程']}, {itemId: 'two', folderId: null, tags: ['时光']}],
}});
const receipt = value => ({exists: true, value: structuredClone(value), fingerprint: createHash('sha256').update(JSON.stringify(value)).digest('hex')});
function fixture(t, initial = legacy) {
    let remote = receipt(initial), reads = 0, writes = 0, ids = 0, hook;
    const session = createDocumentSession({slot: 'classification-test', isCurrent: () => true, store: {
        async read() { reads++; return structuredClone(remote); },
        async write(_slot, value, request) {
            if (request.expectedFingerprint !== remote.fingerprint) throw Error('conflict');
            writes++; await hook?.(); remote = receipt(value); return structuredClone(remote);
        },
    }});
    const collection = createTextCollection({session, now: () => stamp, createId: () => `generated-${++ids}`});
    t.after(() => session.dispose());
    return {collection, session, options: () => ({expectedFingerprint: collection.state().fingerprint}),
        get remote() { return structuredClone(remote.value); }, get reads() { return reads; }, get writes() { return writes; }, hook(value) { hook = value; }};
}

test('v1 read and warm reopen are zero-write; only first classification creates v2', async t => {
    const f = fixture(t); const initial = await f.collection.open();
    assert.equal(initial.version, 1); assert.deepEqual(initial.organization, {folders: [], entries: []});
    assert.deepEqual(documentFromTextCollectionState(initial), legacy);
    await f.collection.open(); assert.equal(f.reads, 1); assert.equal(f.writes, 0); assert.deepEqual(f.remote, legacy);
    await f.collection.createFolder('  纪念  ', f.options());
    assert.equal(f.writes, 1); assert.equal(f.remote.version, 2); assert.deepEqual(f.remote.items, legacy.items);
    assert.deepEqual(f.remote.organization.folders, [{id: 'generated-1', name: '纪念'}]);
});

test('folder operations preserve prose and dates; deleting folder only detaches its entries', async t => {
    const f = fixture(t, classified()); await f.collection.open();
    await f.collection.renameFolder('folder', '旅行', f.options()); assert.equal(f.writes, 1);
    assert.deepEqual(f.remote.items, legacy.items);
    await f.collection.removeFolder('folder', f.options());
    assert.equal(f.writes, 2); assert.deepEqual(f.remote.items, legacy.items);
    assert.deepEqual(f.remote.organization, {folders: [], entries: [
        {itemId: 'one', folderId: null, tags: ['时光', '旅程']}, {itemId: 'two', folderId: null, tags: ['时光']},
    ]});
    const views = textCollectionOrganizationViews(f.collection.state());
    assert.deepEqual(views.characters, [{name: '角色', count: 1}, {name: '另一位', count: 1}]);
});

test('unchanged folder and category saves are local no-ops', async t => {
    const f = fixture(t, classified()); await f.collection.open();
    await f.collection.renameFolder('folder', ' 纪念 ', f.options());
    await f.collection.organize(['one'], {folderId: 'folder', tags: ['时光', '旅程']}, f.options());
    assert.equal(f.writes, 0); assert.deepEqual(f.remote, classified());
});

test('bulk organize is one write; partial patch preserves untouched fields and deduplicates tags', async t => {
    const f = fixture(t, classified()); await f.collection.open();
    await f.collection.organize(['one', 'two'], {tags: ['  回忆 ', 'Memory', 'memory']}, f.options());
    assert.equal(f.writes, 1); assert.deepEqual(f.remote.items, legacy.items);
    assert.deepEqual(textCollectionItemOrganization(f.collection.state(), 'one'), {itemId: 'one', folderId: 'folder', tags: ['回忆', 'Memory']});
    assert.deepEqual(textCollectionItemOrganization(f.collection.state(), 'two'), {itemId: 'two', folderId: null, tags: ['回忆', 'Memory']});
    await f.collection.organize(['two'], {folderId: 'folder'}, f.options());
    assert.deepEqual(textCollectionItemOrganization(f.collection.state(), 'two').tags, ['回忆', 'Memory']);
    await f.collection.organize(['one', 'two'], {folderId: null, tags: []}, f.options());
    assert.deepEqual(f.remote.organization.entries, []);
});

test('ordinary add/edit/remove retain folders and unrelated categories, deleting associations only with their items', async t => {
    const f = fixture(t, classified()); await f.collection.open();
    await f.collection.add({text: '新文', charName: '新角色', userName: 'USER'}, f.options());
    assert.deepEqual(f.remote.organization, classified().organization);
    await f.collection.edit('one', '修改正文', f.options());
    assert.deepEqual(f.remote.organization, classified().organization);
    await f.collection.remove(['one', 'generated-1'], f.options());
    assert.deepEqual(f.remote.organization, {folders: [{id: 'folder', name: '纪念'}], entries: [{itemId: 'two', folderId: null, tags: ['时光']}]});
    await f.collection.clear(f.options());
    assert.deepEqual(f.remote, {version: 2, items: [], organization: {folders: [], entries: []}});
});

test('classification mutations require confirmed fingerprint and reject invalid selections before writes', async t => {
    const f = fixture(t, classified()); await f.collection.open();
    for (const run of [
        () => f.collection.createFolder('新建'), () => f.collection.renameFolder('folder', '新名'),
        () => f.collection.removeFolder('folder'), () => f.collection.organize(['one'], {tags: ['x']}),
        () => f.collection.clear(),
    ]) await assert.rejects(run(), {code: 'text_collection_conflict'});
    for (const run of [
        () => f.collection.createFolder(' 纪念 ', f.options()), () => f.collection.createFolder(' ', f.options()),
        () => f.collection.renameFolder('missing', '名称', f.options()), () => f.collection.removeFolder('missing', f.options()),
        () => f.collection.organize(['missing'], {tags: ['x']}, f.options()),
        () => f.collection.organize(['one'], {folderId: 'missing'}, f.options()),
        () => f.collection.organize(['one'], {tags: [' ']}, f.options()),
        () => f.collection.organize(['one'], {extra: 'do not discard'}, f.options()),
    ]) await assert.rejects(run());
    assert.equal(f.writes, 0); assert.deepEqual(f.remote, classified());
});

test('strict v2 validation rejects unknown fields, dangling references and duplicate folder/tag identities', () => {
    const changes = [
        value => { value.extra = true; }, value => { value.organization.extra = true; },
        value => { value.organization.folders[0].extra = true; }, value => { value.organization.entries[0].extra = true; },
        value => { value.organization.folders.push({id: 'other', name: ' 纪念 '}); },
        value => { value.organization.folders.push({id: 'folder', name: '其他'}); },
        value => { value.organization.entries.push({...value.organization.entries[0]}); },
        value => { value.organization.entries[0].itemId = 'unknown'; },
        value => { value.organization.entries[0].folderId = 'unknown'; },
        value => { value.organization.entries[0].tags = ['Same', 'same']; },
        value => { value.organization.entries[0].tags = ['']; },
    ];
    for (const change of changes) { const value = structuredClone(classified()); change(value); assert.throws(() => validateTextCollectionDocument(value), {code: 'text_collection_document'}); }
});

test('classification failure keeps the full v2 draft with original prose and no implicit retry', async t => {
    const f = fixture(t, classified()); await f.collection.open();
    f.hook(() => { throw Object.assign(Error('offline'), {writeState: 'not_started'}); });
    await assert.rejects(f.collection.organize(['one'], {tags: ['新标签']}, f.options()), /offline/);
    assert.deepEqual(f.remote, classified()); assert.equal(f.writes, 1);
    assert.deepEqual(f.session.state().draft.value.items, legacy.items);
    assert.deepEqual(f.session.state().draft.value.organization.entries[0].tags, ['新标签']);
    await f.collection.open(); assert.equal(f.writes, 1);
});

test('derived views and full search use saved prose, names, folders and tags without changing records', () => {
    const state = classified(), before = structuredClone(state);
    assert.deepEqual(textCollectionOrganizationViews(state), {folders: [{id: 'folder', name: '纪念', count: 1}],
        characters: [{name: '另一位', count: 1}], tags: [{name: '时光', count: 2}, {name: '旅程', count: 1}]});
    for (const query of ['原文', 'user', '时光']) assert.equal(filterTextCollectionItems(state, {query}).length, 2);
    for (const query of ['角色', '纪念', '旅程']) assert.deepEqual(filterTextCollectionItems(state, {query}).map(item => item.id), ['one']);
    assert.deepEqual(filterTextCollectionItems(state, {charName: '角色'}), []);
    assert.deepEqual(filterTextCollectionItems(state, {charName: '另一位'}).map(item => item.id), ['two']);
    assert.deepEqual(filterTextCollectionItems(state, {folderId: 'folder', tag: '时光'}).map(item => item.id), ['one']);
    assert.deepEqual(state, before);
    const entry = textCollectionItemOrganization(state, 'one'); entry.tags.push('outside'); assert.deepEqual(state, before);
});
