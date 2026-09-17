import test from 'node:test';
import assert from 'node:assert/strict';
import { projectGalleryDirectorySnapshot as project, galleryDirectoryTarget as target, createGalleryDirectorySession as create } from '../qianmu-gallery-directory.js';
import { galleryCatalogScopeQuery as query } from '../qianmu-gallery-catalog-contract.js';
import { galleryDirectoryOwnerLabel as label } from '../qianmu-gallery-directory-view.js';
const ns = 'st-user:alice', source = { ownerKey: 'char:Alice.png', chatKey: 'chat' };
const row = (id = 'a') => ({ id, createdAt: 100, tags: ['海岸'], url: 'https://private/', prompt: 'private', unknown: { preserve: true } });
function fixture(extra = {}) {
    let closed = false, writes = 0, guarded = 0, receiptClosed = 0, stored = [], revision = 0;
    const context = { chatMetadata: { story_director_liminale: { storyboardImages: [row()] } } };
    const client = { owner: { namespace: ns }, source, target: target(source), assertCurrent() { if (closed) throw Error('changed'); },
        async guard() { guarded++; if (closed) throw Error('changed'); }, close() { receiptClosed++; closed = true; },
        verify: async () => ({ matches: true }), ...extra.client };
    const store = { page: async () => ({ revision, rows: [] }), scopes: async () => ({ revision, rows: [] }), close() {},
        async upsert(namespace, scope, rows, options) { assert.equal(namespace, ns); assert.deepEqual(scope, source); assert.equal(options.expectedRevision, revision); assert.equal(options.isCurrent(), true); writes++; stored.push(...rows); return { revision: ++revision, changed: rows.length }; }, ...extra.store };
    const options = { getContext: () => context, epoch: () => 1, createClient: async () => client, createStore: () => store, ...extra.options };
    return { context, client, store, options, get writes() { return writes; }, get stored() { return stored; }, get guarded() { return guarded; }, get receiptClosed() { return receiptClosed; } };
}
test('directory projection keeps only actual timestamps and tags, no original content', () => {
    const input = [row()], copy = structuredClone(input), result = project(ns, source, input);
    assert.deepEqual(input, copy); assert.equal(result.entries.length, 1);
    assert.doesNotMatch(JSON.stringify(result.entries), /url|private|prompt|unknown/);
    assert.match(result.snapshot.text, /private/); // Complete receipt comparison includes unknown fields.
});
test('invalid metadata remains unindexed without fabricated identity or silent clipping', () => {
    const bad = [{ ...row('b'), createdAt: null }, { ...row('c'), tags: Array(31).fill('x') }, { ...row('d'), id: '' }];
    assert.deepEqual(project(ns, source, bad).entries, []); assert.equal(project(ns, source, bad).skipped, 3);
    assert.equal(project(ns, source, undefined).snapshot, null); assert.equal(project(ns, source, []).entries.length, 0);
    assert.throws(() => project(ns, source, [row(), row()]));
    assert.throws(() => project(ns, source, [{ ...row(), createdAt: undefined }]));
    assert.throws(() => project('', source, []));
});
test('scope cursors bind exact account, owner, revision and shape', () => {
    const q = query(ns, { ownerKey: source.ownerKey, limit: 2 });
    const cursor = { version: 1, signature: q.signature, revision: 1, after: [ns, source.ownerKey, source.chatKey] };
    assert.deepEqual(query(ns, { ownerKey: source.ownerKey, cursor }).cursor, cursor);
    for (const input of [{ cursor }, { ownerKey: 'char:Other.png', cursor }, { ownerKey: source.ownerKey, cursor: { ...cursor, after: [ns, source.ownerKey] } }, { ownerKey: source.ownerKey, cursor: { ...cursor, revision: -1 } }, { limit: 61 }, { model: 'x' }]) {
        assert.throws(() => query(ns, input));
    }
    assert.throws(() => query('st-user:bob', { ownerKey: source.ownerKey, cursor }));
});
test('source targets retain exact files; same-named role and group chats are distinct', () => {
    assert.deepEqual(target(source), { kind: 'character', chatId: 'chat', avatar: 'Alice.png' });
    assert.deepEqual(target({ ownerKey: 'group:1', chatKey: 'chat' }), { kind: 'group', chatId: 'chat' });
    assert.throws(() => target({ ownerKey: 'char:Alice', chatKey: '../chat' }));
    assert.throws(() => target({ ownerKey: 'Alice', chatKey: 'chat' }));
});
test('display names never determine identity or merge duplicate characters', () => {
    const context = { characters: [{ name: 'Same', avatar: 'Alice.png' }, { name: 'Same', avatar: 'B.png' }] };
    assert.equal(label(source.ownerKey, context), 'Same'); assert.match(label('char:missing.png', context), /missing.png/);
    context.characters.push({ name: 'Other', avatar: 'Alice.png' }); assert.match(label(source.ownerKey, context), /Alice.png/);
    assert.match(label('group:9', { groups: {} }), /群组 · 9/);
    assert.match(label('group:undefined', { groups: [null] }), /群组 · undefined/);
});
test('refresh requires a matching server snapshot before any derived write', async () => {
    const f = fixture({ client: { verify: async () => ({ matches: false }) } }), s = await create(f.options);
    await assert.rejects(s.refresh(), /服务器/); assert.equal(f.writes, 0); s.close();
});
test('refresh preserves original records and uses bounded CAS batches', async () => {
    const f = fixture(); f.context.chatMetadata.story_director_liminale.storyboardImages = Array.from({ length: 405 }, (_, i) => row(String(i)));
    const before = structuredClone(f.context), s = await create(f.options), result = await s.refresh();
    assert.deepEqual(f.context, before); assert.equal(f.writes, 3); assert.equal(f.stored.length, 405); assert.equal(result.indexed, 405); assert.equal(result.revision, 3); assert.ok(f.guarded >= 5); s.close();
});
test('empty or absent sources never remove historical references', async () => {
    for (const value of [undefined, []]) {
        const f = fixture(); f.context.chatMetadata.story_director_liminale.storyboardImages = value;
        const s = await create(f.options); assert.equal((await s.refresh()).indexed, 0); assert.equal(f.writes, 0); s.close();
    }
});
test('edits while checking abort before writes and never overwrite the chat', async () => {
    const f = fixture({ client: { verify: async () => { f.context.chatMetadata.story_director_liminale.storyboardImages[0].unknown.preserve = false; return { matches: true }; } } });
    const s = await create(f.options); await assert.rejects(s.refresh(), /变化/); assert.equal(f.writes, 0); s.close();
});
test('cancel after a committed batch stops subsequent batches, keeps honest historical references', async () => {
    const f = fixture(), original = f.store.upsert; let s;
    f.context.chatMetadata.story_director_liminale.storyboardImages = Array.from({ length: 201 }, (_, i) => row(String(i)));
    f.store.upsert = async (...args) => { const result = await original(...args); s.close(); return result; };
    s = await create(f.options); await assert.rejects(s.refresh(), /关闭/); assert.equal(f.writes, 1); assert.equal(f.stored.length, 200);
});
test('page operations guard account before and after storage; failures are not empty successes', async () => {
    const f = fixture({ store: { scopes: async () => { throw Error('disk'); } } }), s = await create(f.options);
    await assert.rejects(s.scopes(), /disk/); assert.equal(f.writes, 0); s.close(); await assert.rejects(s.page(), /关闭/);
});
test('locating a picture requires the current exact owner/chat/id/time and unique original', async () => {
    const f = fixture(), s = await create(f.options), selected = { namespace: ns, ...source, recordId: 'a', createdAt: 100 };
    assert.equal(await s.locate(selected), f.context.chatMetadata.story_director_liminale.storyboardImages[0]);
    for (const patch of [{ namespace: 'st-user:b' }, { ownerKey: 'char:B.png' }, { chatKey: 'other' }, { recordId: 'missing' }, { createdAt: 200 }]) await assert.rejects(s.locate({ ...selected, ...patch }));
    f.context.chatMetadata.story_director_liminale.storyboardImages.push(row()); await assert.rejects(s.locate(selected), /变化/); s.close();
});
test('historical inspection reads only exact receipt target and releases every reader', async () => {
    let seen, released = 0;
    const f = fixture({ options: { createHistoricalClient: options => { seen = options; return { inspect: async () => ({ state: 'absent' }), close() { released++; } }; } } });
    const s = await create(f.options); assert.equal((await s.inspectSource({ ownerKey: 'char:B.png', chatKey: 'chat' })).state, 'absent');
    assert.deepEqual(seen.target, { kind: 'character', avatar: 'B.png', chatId: 'chat' }); assert.equal(released, 1); assert.equal(f.writes, 0); s.close();
});
