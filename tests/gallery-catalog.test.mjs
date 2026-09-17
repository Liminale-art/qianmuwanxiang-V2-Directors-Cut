import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { projectGalleryCatalogEntry as project, galleryCatalogQuery as query, galleryCatalogMatches as matches,
    galleryCatalogStoredRow as stored, galleryCatalogStoredEntry as validate, galleryCatalogTags as tags } from '../qianmu-gallery-catalog-contract.js';
import { createGalleryCatalogStore } from '../qianmu-gallery-catalog-store.js';
const ns = 'st-user:fixture', source = { ownerKey: 'char:Alice.png', chatKey: 'shared-name' };
const entry = (extra = {}) => ({ id: 'shot', kind: 'still', createdAt: 100, tags: ['海岸', '旅人'], ...extra });
const cursor = (q, after, revision = 1) => ({ version: 1, signature: q.signature, revision, after });

test('projection reuses explicit account, owner, chat and record identity without sensitive data', () => {
    const input = entry({ label: '<img onerror=alert(1)>', url: 'https://private/?token=secret', snapshot: { apiKey: 'secret' }, prompt: 'private narrative', data: new Blob(['secret']) });
    const row = project(ns, source, input);
    assert.deepEqual(Object.keys(row), ['namespace','ownerKey','chatKey','recordId','kind','createdAt','label','tags']);
    assert.equal(row.recordId, input.id); assert.equal(row.ownerKey, source.ownerKey);
    assert.doesNotMatch(JSON.stringify(row), /private|secret|apiKey|snapshot|https|prompt/);
    assert.equal(row.label, input.label); // Plain data; any eventual renderer must escape it.
    assert.notEqual(row.tags, input.tags); assert.equal(input.tags[0], '海岸');
});
test('same-named chats in different character files or groups do not share a key', () => {
    const rows = [source, { ...source, ownerKey: 'char:Other.png' }, { ...source, ownerKey: 'group:123' }].map(s => stored(project(ns, s, entry())));
    assert.equal(new Set(rows.map(row => JSON.stringify(row.key))).size, 3);
    assert.notDeepEqual(rows[0].key, stored(project('st-user:another', source, entry())).key);
});
test('display text is not identity and changing it does not reorder a work', () => {
    const a = stored(project(ns, source, entry({ label: 'old name' }))), b = stored(project(ns, source, entry({ label: 'new name' })));
    assert.deepEqual(a.key, b.key); assert.equal(a.createdAt, b.createdAt);
});
test('projection rejects missing owner, raw numeric character positions, invalid data and guessed timestamps', () => {
    for (const ownerKey of ['', 'Alice', '0', 'char:../a', 'char:..', 'user:Alice', 'group:a/b']) assert.throws(() => project(ns, { ...source, ownerKey }, entry()));
    for (const createdAt of [-1, NaN, Infinity, 0.1, '100', undefined]) assert.throws(() => project(ns, source, entry({ createdAt })));
    for (const kind of ['', 'video', 'GIF', null]) assert.throws(() => project(ns, source, entry({ kind })));
    assert.throws(() => project('', source, entry())); assert.throws(() => project(ns, { ...source, unknown: true }, entry()));
    assert.throws(() => project(ns, source, entry({ id: 'bad\nname' })));
});
test('tags preserve exact keywords, deduplicate and intersect, never union or infer', () => {
    assert.deepEqual(tags(['海岸','旅人','海岸']), ['旅人','海岸']);
    const row = project(ns, source, entry());
    assert.equal(matches(row, query(ns, { tags: ['旅人','海岸'] })), true);
    assert.equal(matches(row, query(ns, { tags: ['旅人','群山'] })), false);
    assert.equal(matches(row, query(ns, { ownerKey: 'char:Other.png' })), false);
    assert.equal(matches(row, query('st-user:b')), false);
    assert.equal(matches(row, query(ns, { kind: 'motion' })), false);
    for (const invalid of [new Array(2), [''], [' a'], ['a\nb'], Array(31).fill('x')]) assert.throws(() => tags(invalid));
});
test('stored rows validate ownership, exact lightweight schema, index keys and byte counts', () => {
    const value = project(ns, source, entry()), row = stored(value); assert.deepEqual(validate(row, ns), value);
    for (const mutate of [r => r.bytes++, r => r.tagKeys.pop(), r => r.key[1] = 'char:other', r => r.prompt = 'private', r => r.tags.reverse(), r => r.namespace = 'st-user:b']) {
        const damaged = structuredClone(row); mutate(damaged); assert.throws(() => validate(damaged, ns));
    }
});
test('queries select persistent compound indexes for time, owner, chat and keyword', () => {
    assert.equal(query(ns).index, 'time'); assert.equal(query(ns, { ownerKey: source.ownerKey }).index, 'owner');
    assert.equal(query(ns, source).index, 'chat'); assert.equal(query(ns, { ...source, tags: ['海岸'] }).index, 'tag');
    assert.deepEqual(query(ns, source).prefix, [ns, 'still', source.ownerKey, source.chatKey]);
    assert.throws(() => query(ns, { chatKey: source.chatKey }));
    for (const limit of [0, 61, NaN, '10', 2.5]) assert.throws(() => query(ns, { limit }));
    assert.throws(() => query(ns, { model: 'novel' })); // No provider filtering reintroduced.
});
test('cursor ties include all identities and are bound to exact account/filter/revision', () => {
    const options = { ...source, tags: ['旅人','海岸'] }, q = query(ns, options), after = [ns,'still','旅人',100,source.ownerKey,source.chatKey,'shot'];
    const valid = cursor(q, after); assert.deepEqual(query(ns, { ...options, cursor: valid }).cursor, valid);
    assert.deepEqual(query(ns, { ...options, tags: ['海岸','旅人'], cursor: valid }).cursor, valid);
    for (const next of [{ kind: 'motion' }, { ownerKey: 'char:B.png' }, { chatKey: 'b' }, { tags: ['海岸'] }]) assert.throws(() => query(ns, { ...options, ...next, cursor: valid }));
    assert.throws(() => query('st-user:b', { ...options, cursor: valid }));
    const sparse = after.slice(); delete sparse[6]; assert.throws(() => query(ns, { ...options, cursor: cursor(q, sparse) }));
    for (const bad of [{ ...valid, revision: -1 }, { ...valid, after: after.slice(0,-1) }, { ...valid, after: [...after.slice(0,3), '100', ...after.slice(4)] }, { ...valid, version: 2 }]) assert.throws(() => query(ns, { ...options, cursor: bad }));
});
test('time, owner and chat cursors accept only the selected index prefix', () => {
    for (const options of [{}, { ownerKey: source.ownerKey }, source]) {
        const q = query(ns, options), after = [...q.prefix, 100, ...(q.index === 'time' ? [source.ownerKey, source.chatKey] : q.index === 'owner' ? [source.chatKey] : []), 'shot'];
        assert.deepEqual(query(ns, { ...options, cursor: cursor(q, after) }).cursor.after, after);
        after[0] = 'st-user:b'; assert.throws(() => query(ns, { ...options, cursor: cursor(q, after) }));
    }
});
test('store construction is lazy; invalid or unconfirmed writes never open storage', async () => {
    let opened = 0; const store = createGalleryCatalogStore({ indexedDB: { open() { opened++; throw Error('must not open'); } } });
    assert.equal(opened, 0);
    await assert.rejects(store.upsert(ns, source, [entry()], {}), { code: 'gallery_catalog_revision' });
    await assert.rejects(store.upsert(ns, source, [entry(), entry()], { expectedRevision: 0 }), { code: 'gallery_catalog_duplicate' });
    await assert.rejects(store.upsert(ns, source, new Array(2), { expectedRevision: 0 }));
    await assert.rejects(store.remove(ns, [[ns,source.ownerKey,source.chatKey,'shot']], { expectedRevision: 0 }), { code: 'gallery_catalog_consent' });
    await assert.rejects(store.remove(ns, [['st-user:b',source.ownerKey,source.chatKey,'shot']], { confirmed: true, expectedRevision: 0 }));
    await assert.rejects(store.page(ns, {}, { isCurrent: () => false }), { code: 'gallery_catalog_changed' });
    assert.equal(opened, 0); store.close(); await assert.rejects(store.page(ns), { code: 'gallery_catalog_closed' }); assert.equal(opened, 0);
});
test('opening failure is recoverable and not an empty-success response', async () => {
    let attempts = 0; const store = createGalleryCatalogStore({ indexedDB: { open() { attempts++; throw Error('blocked'); } } });
    await assert.rejects(store.page(ns), { code: 'gallery_catalog_storage' }); await assert.rejects(store.page(ns), { code: 'gallery_catalog_storage' });
    assert.equal(attempts, 2); store.close();
});
test('implementation has bounded cursor reads and no bulk body/asset/network access', async () => {
    const code = await readFile(new URL('../qianmu-gallery-catalog-store.js', import.meta.url), 'utf8');
    assert.match(code, /openCursor\(range, 'prev'\)/); assert.match(code, /visited >= limits.scan/);
    assert.doesNotMatch(code, /\.getAll\(|\.getAllKeys\(|fetch\(|XMLHttpRequest|\.arrayBuffer\(|localStorage|\.clear\(|deleteDatabase/);
});
