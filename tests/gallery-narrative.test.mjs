import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { buildGalleryNarrative, createGalleryNarrativeSession, GALLERY_UNPLACED } from '../qianmu-gallery-narrative.js';
import { renderGalleryNarrative } from '../qianmu-gallery-narrative-view.js';
import { createStoryboardMessageReference, createStoryboardParagraphAnchor } from '../qianmu-storyboard.js';
import { hashText } from '../qianmu-storyboard-utils.js';
import { storyboardFunctionSource } from './helpers/storyboard-form-fixture.mjs';

function fixture(count = 3) {
    const messages = Array.from({ length: count }, (_, i) => ({ mes: `开场 ${i}\n海岸 ${i}\n归途 ${i}`, name: 'CHAR <b>', send_date: `date-${i}`, swipe_id: 0 }));
    const f = { owner: {}, epoch: 0, chatKey: 'chat', messages, records: [], paragraphs: value => value.split('\n') };
    f.add = (floor, paragraph = 0, patch = {}) => {
        const message = messages[floor], rows = f.paragraphs(message.mes), id = `r-${f.records.length}`;
        const record = { id, chatKey: f.chatKey, floor, messageHash: hashText(message.mes), swipeId: message.swipe_id,
            messageRef: createStoryboardMessageReference({ message, chatKey: f.chatKey, floor, now: 1 }),
            paragraphAnchor: createStoryboardParagraphAnchor({ chatKey: f.chatKey, floor, messageText: message.mes, swipeId: message.swipe_id,
                paragraphIndex: paragraph, paragraphText: rows[paragraph], previousText: rows[paragraph - 1], nextText: rows[paragraph + 1], createdAt: 1 }), ...patch };
        f.records.push(record); return record;
    };
    f.build = () => buildGalleryNarrative(f);
    f.session = createGalleryNarrativeSession(); f.sync = () => f.session.update(f);
    return f;
}

test('floor and exact paragraph memberships share records without making copies or reading media', () => {
    const f = fixture(), a = f.add(0, 0), b = f.add(0, 0), c = f.add(0, 1), d = f.add(2, 0);
    for (const record of f.records) Object.defineProperty(record, 'url', { get() { throw Error('No media reads'); } });
    const before = JSON.stringify(f.records), model = f.build();
    assert.deepEqual(model.floors.map(row => row.floor), [2, 0]);
    assert.equal(model.floors[1].ids.size, 3); assert.equal(model.floors[1].paragraphs.size, 2);
    assert.deepEqual([...model.floors[1].paragraphs.values()][0].ids, new Set([a.id, b.id]));
    f.sync(); assert.ok(f.session.selectRecord(a)); assert.deepEqual(f.session.filter(f.records), [a, b]);
    f.session.allFloor(); assert.deepEqual(f.session.filter(f.records), [a, b, c]);
    f.session.clear(); assert.deepEqual(f.session.filter(f.records), [a, b, c, d]); assert.equal(JSON.stringify(f.records), before);
});

test('selection survives inserted floors without changing persisted source anchors', () => {
    const f = fixture(), record = f.add(1, 1); f.sync().selectRecord(record);
    const saved = JSON.stringify(record);
    f.messages.unshift({ mes: 'inserted', name: 'CHAR', send_date: 'new', swipe_id: 0 }); f.sync();
    assert.match(f.session.selected.label, /第 3 层 · 第 2 段/); assert.equal(f.session.filter(f.records).length, 1);
    assert.equal(JSON.stringify(record), saved);
});

for (const change of ['edit', 'swipe', 'delete', 'duplicate']) test(`${change} invalidates an existing selection instead of silently showing another paragraph`, () => {
    const f = fixture(), record = f.add(1, 1); f.sync().selectRecord(record);
    if (change === 'edit') f.messages[1].mes += ' changed';
    if (change === 'swipe') f.messages[1].swipe_id++;
    if (change === 'delete') f.messages.splice(1, 1);
    if (change === 'duplicate') f.messages.push(structuredClone(f.messages[1]));
    f.sync(); assert.equal(f.session.selected.stale, true); assert.deepEqual(f.session.filter(f.records), []);
    f.session.clear(); assert.deepEqual(f.session.filter(f.records), [record]);
    assert.equal(f.build().unplaced.size, 1);
});

test('unlocated and foreign/review images stay browseable without guessed attachment', () => {
    const f = fixture(); f.add(0, 0, { restoreLinkReview: {} }); f.add(0, 0, { chatKey: 'other' });
    f.records.push({ id: 'old', floor: 0 }, { id: 'broken', floor: 0, messageHash: hashText(f.messages[0].mes), swipeId: 0, messageRef: {} });
    f.sync(); assert.equal(f.session.sourceCount, 0); assert.equal(f.session.filter(f.records).length, 4);
    assert.ok(f.session.choose(GALLERY_UNPLACED)); assert.equal(f.session.filter(f.records).length, 4);
});

test('duplicate record IDs are never grouped and legacy hashes require unique evidence', () => {
    const f = fixture(); const a = f.add(0, 0); f.records.push(structuredClone(a));
    const old = f.add(1, 0, { messageRef: null });
    assert.equal(f.build().sources.has(a.id), false); assert.equal(f.build().sources.has(old.id), true);
    f.messages.push({ ...f.messages[1], name: 'Another CHAR', send_date: 'another' });
    assert.equal(f.build().sources.has(old.id), false);
});

test('USER/system text and foreign paragraph owners cannot become assistant source positions', () => {
    const f = fixture(); f.messages[0].is_user = true; f.messages[1].is_system = true;
    f.add(0); f.add(1); const record = f.add(2); record.paragraphAnchor.chatKey = 'other';
    assert.equal(f.build().floors.length, 0); assert.equal(f.build().unplaced.size, 3);
});

for (const patch of [{ paragraphIndex: 99 }, { paragraphText: 'wrong text' }, { paragraphHash: 'invalid' }, { messageHash: 'stale' }, { swipeId: 1 }]) {
    test(`bad paragraph evidence remains floor-only: ${JSON.stringify(patch)}`, () => {
        const f = fixture(), record = f.add(0); Object.assign(record.paragraphAnchor, patch); f.sync();
        assert.ok(f.session.selectRecord(record)); assert.match(f.session.selected.label, /全部静帧/);
        assert.equal(f.session.view().partial, 1); assert.equal(f.session.view().rows.length, 0);
    });
}

test('parser errors, oversized and over-240-paragraph messages stay floor-only', () => {
    for (const kind of ['error', 'large', 'many']) {
        const f = fixture(); if (kind === 'large') f.messages[0].mes = 'a'.repeat(2 * 1048576 + 1);
        const record = f.add(0);
        if (kind === 'error') f.paragraphs = () => { throw Error('unsupported'); };
        if (kind === 'many') f.paragraphs = () => Array(241).fill('text');
        f.sync(); f.session.selectRecord(record); assert.equal(f.session.view().partial, 1);
    }
});

test('session changes reset navigation even when account or chat names coincide', () => {
    for (const key of ['owner', 'chatKey', 'epoch']) {
        const f = fixture(), record = f.add(0); f.sync().selectRecord(record); f.session.search('query');
        f[key] = key === 'owner' ? {} : key === 'epoch' ? 1 : 'other'; f.sync();
        assert.equal(f.session.selected, null); assert.equal(f.session.view().query, ''); assert.equal(f.session.view().open, false);
    }
});

test('explicit cleanup releases chat ownership, lookup data and selected positions', () => {
    const f = fixture(), record = f.add(0); f.sync().selectRecord(record); f.session.reset();
    assert.equal(f.session.owner, undefined); assert.equal(f.session.selected, null); assert.equal(f.session.sourceCount, 0);
    assert.equal(f.session.sourceFor(record), undefined); assert.equal(f.session.view().rows.length, 0);
    f.sync(); assert.equal(f.session.sourceCount, 1); assert.equal(f.session.selected, null);
});

test('directory pagination is bounded, deterministic, searchable, escaped and read-only across 500 floors', () => {
    const f = fixture(500); for (let floor = 0; floor < 500; floor++) f.add(floor);
    const before = JSON.stringify(f.records); f.sync();
    const seen = new Set(); for (let page = 0; page < 42; page++) {
        const view = f.session.view(); assert.ok(view.rows.length <= 12);
        for (const row of view.rows) { assert.equal(seen.has(row.key), false); seen.add(row.key); }
        f.session.move(1);
    }
    assert.equal(seen.size, 500); assert.equal(f.session.view().page, 41);
    f.session.search('开场 499'); assert.equal(f.session.view().total, 1); assert.equal(f.session.view().page, 0);
    const markup = renderGalleryNarrative(f.session); assert.ok(markup.includes('&lt;b&gt;')); assert.ok(!markup.includes('CHAR <b>'));
    assert.equal(JSON.stringify(f.records), before);
});

test('paragraph parser runs once per referenced message, not once per image', () => {
    const f = fixture(); for (let i = 0; i < 10000; i++) f.add(0, i % 3);
    let calls = 0; f.paragraphs = value => { calls++; return value.split('\n'); };
    const model = f.build(); assert.equal(calls, 1); assert.equal(model.sources.size, 10000);
});

test('source-scoped groups follow verified paragraph order and frozen shot order, not completion time', () => {
    const f = fixture(), last = f.add(0, 2), first = f.add(0, 0), early = f.add(0, 1), late = f.add(0, 1);
    early.inlineOrder = { version: 1, batchId: 'batch', batchStartedAt: 10, shotIndex: 0, requestIndex: 1 };
    late.inlineOrder = { ...early.inlineOrder, shotIndex: 1 };
    const groups = [last, late, early, first].map(record => ({ variants: [record] })); f.sync();
    assert.equal(f.session.orderGroups(groups), groups, 'default gallery ordering is unchanged');
    f.session.selectRecord(first); f.session.allFloor();
    assert.deepEqual(f.session.orderGroups(groups).map(row => row.variants[0].id), [first.id, early.id, late.id, last.id]);
});

test('real gallery filter ignores saved model preference while retaining search, track and collection intersection', async () => {
    const {galleryTagsMatch}=await import('../qianmu-gallery-keywords.js');
    const {galleryMembershipIds}=await import('../qianmu-gallery-membership.js');
    const records = [{ id: 'a', source: 'novel', prompt: 'coast', collectionIds: ['c'], track: 'main_camera' },
        { id: 'b', source: 'comfy', prompt: 'coast', collectionIds: [], track: 'main_camera' },
        { id: 'c', source: 'comfy', prompt: 'woods', collectionIds: ['c'], track: 'second_camera' }];
    const sandbox = vm.createContext({ galleryMembershipIds,galleryTagsMatch,storyboardUpdateGalleryNarrative: () => ({ filter: value => value }), storyboardGalleryRecords: () => records,
        storyboardProductionDeliveryPolicy: record => ({ track: record.track, sourceLabel: '' }), storyboardGalleryOpenCollectionId: '',
        storyboardItemCollectionIds: record => record.collectionIds, STORYBOARD_SOURCES: {} });
    vm.runInContext(storyboardFunctionSource('storyboardFilteredGalleryRecords'), sandbox);
    const state = { gallerySource: 'novel', gallerySearch: '', galleryTrack: 'all' }, ids = () => [...sandbox.storyboardFilteredGalleryRecords(state)].map(row => row.id);
    records[0].tags=['night','together'];records[1].tags=['night'];records[2].tags=['forest'];
    assert.deepEqual(ids(), ['c', 'b', 'a']);state.galleryTagFilters=['night','together'];assert.deepEqual(ids(),['a']);state.galleryTagFilters=[];
    state.gallerySearch = 'coast'; assert.deepEqual(ids(), ['b', 'a']);
    sandbox.storyboardGalleryOpenCollectionId = 'c'; assert.deepEqual(ids(), ['a']); state.galleryTrack = 'second_camera'; assert.deepEqual(ids(), []);
});

test('production gallery binds the new directory and ships both modules without model selector', async () => {
    const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    assert.ok(storyboardFunctionSource('renderStoryboardGallery').includes('renderGalleryNarrative(storyboardGalleryNarrative)'));
    assert.ok(source.includes('storyboardBindGalleryNarrative(root);'));
    assert.match(storyboardFunctionSource('storyboardBindGalleryInspector'),/storyboardUpdateGalleryNarrative\(\)\.selectRecord\(record\)/);
    const inspector=await readFile(new URL('../qianmu-gallery-inspector.js',import.meta.url),'utf8');
    assert.ok(inspector.includes('data-gallery-detail-action="source"'));
    assert.ok(!source.includes('class="text_pole sd-storyboard-gallery-source"'));
    const release = JSON.parse(await readFile(new URL('../release-files.json', import.meta.url), 'utf8'));
    for (const name of ['qianmu-gallery-narrative.js', 'qianmu-gallery-narrative-view.js']) assert.ok(release.files.includes(name));
});
