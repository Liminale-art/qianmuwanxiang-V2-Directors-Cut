import test from 'node:test';
import assert from 'node:assert/strict';
import {installMemoryIndexedDB} from './helpers/reader-idb-fixture.mjs';
import {createExcerptStore} from '../features/excerpt/qianmu-excerpt-store.js';
import {exportExcerptBackup,readExcerptBackup,restoreExcerptBackup,mergeExcerptStudioSettings,excerptRestoreText,dropExcerptDrafts} from '../qianmu-excerpt-backup.js';
import {detectStorageFile,isItemPack,readZipDirectory} from '../qianmu-storage-transfer.js';
import {BUILTIN_TEMPLATES} from '../features/excerpt/qianmu-excerpt-template.js';
import {builtinTemplate,createDoc,schemeFromDoc} from '../features/excerpt/qianmu-excerpt-doc.js';

const realScheme = () => { const id = BUILTIN_TEMPLATES[0].id; return schemeFromDoc(createDoc({template: builtinTemplate(id), templateId: id, body: '月光'})); };

const doc = image => ({pages: [{elements: [{id: 'e1', image: {id: image}}]}], bg: {}});
function setup(t) {
  const idb = installMemoryIndexedDB();
  t.after(() => idb.restore());
  const open = namespace => { const store = createExcerptStore({namespace}); t.after(() => store.close()); return store; };
  return {idb, open};
}
const collect = async iterator => { const out = []; for await (const item of iterator) out.push(item); return out; };

test('the store exports and deletes only the current account’s drafts and images', async t => {
  const {open} = setup(t), mine = open('st-user:a'), theirs = open('st-user:b');
  await mine.saveDraft('item-1', {doc: doc('img-1')}); await mine.saveDraft('reader:book:n1', {doc: doc('img-2')}); await mine.saveDraft('reader:book:n2', {doc: {}});
  await mine.saveDraft('reader:book2:n1', {doc: {}});
  await theirs.saveDraft('item-1', {doc: {owner: 'b'}});
  await mine.putImage('img-1', new Blob(['one'], {type: 'image/png'}), 10, 20); await theirs.putImage('img-9', new Blob(['nine']), 1, 1);
  assert.deepEqual((await collect(mine.exportDrafts())).map(item => item.key).sort(), ['item-1', 'reader:book2:n1', 'reader:book:n1', 'reader:book:n2']);
  const images = await collect(mine.exportImages());
  assert.deepEqual(images.map(({id, w, h}) => [id, w, h]), [['img-1', 10, 20]]);assert.equal(await images[0].blob.text(), 'one');
  assert.equal(await mine.deleteDrafts({startsWith: 'reader:book:'}), 2);
  assert.deepEqual((await collect(mine.exportDrafts())).map(item => item.key).sort(), ['item-1', 'reader:book2:n1'], 'reader:book2: is not caught by reader:book:');
  assert.equal(await mine.deleteDrafts({keys: ['item-1', 'missing']}), 2);
  assert.deepEqual((await collect(mine.exportDrafts())).map(item => item.key), ['reader:book2:n1']);
  assert.deepEqual((await theirs.loadDraft('item-1')).doc, {owner: 'b'}, 'the other account is untouched');
  assert.equal(await mine.deleteDrafts({}), 0);
});

test('importing a draft keeps the newer copy by savedAt and keeps the backup’s time', async t => {
  const {open} = setup(t), store = open('st-user:a');
  await store.saveDraft('x', {doc: {v: 'local'}});
  const local = await store.loadDraft('x');
  assert.equal(await store.importDraft('x', {doc: {v: 'older'}, savedAt: local.savedAt - 1}), 'kept');
  assert.equal(await store.importDraft('x', {doc: {v: 'same'}, savedAt: local.savedAt}), 'kept');
  assert.equal((await store.loadDraft('x')).doc.v, 'local');
  assert.equal(await store.importDraft('x', {doc: {v: 'newer'}, savedAt: local.savedAt + 5}), 'replaced');
  assert.deepEqual(await store.loadDraft('x'), {doc: {v: 'newer'}, savedAt: local.savedAt + 5});
  assert.equal(await store.importDraft('y', {doc: {}, savedAt: 3}), 'added');
  assert.equal(await store.importImage('i', {blob: new Blob(['a']), w: 1, h: 2}), true);
  assert.equal(await store.importImage('i', {blob: new Blob(['b']), w: 1, h: 2}), false, 'an existing image id is not replaced');
  assert.equal(await (await store.getImage('i')).blob.text(), 'a');
  await assert.rejects(store.importDraft('', {}), TypeError);await assert.rejects(store.importImage('j', {blob: 'not a blob'}), TypeError);
});

test('a backup round-trips drafts, images and the studio schemes into another device, merging by savedAt', async t => {
  const {open} = setup(t), source = open('st-user:a');
  await source.saveDraft('item-1', {doc: doc('img-1'), stamp: 's'});
  await source.saveDraft('reader:book:n1', {doc: doc('img-2')});
  await source.putImage('img-1', new Blob(['first'], {type: 'image/png'}), 100, 50);
  await source.putImage('img-2', new Blob(['second'], {type: 'image/jpeg'}), 80, 60);
  const studio = {last: null, schemes: [{id: 's1', name: '方案甲', scheme: realScheme()}], templates: [{id: 't1', source: BUILTIN_TEMPLATES[0].source, updatedAt: 5}]};
  const result = await exportExcerptBackup({store: source, studio, now: () => new Date('2026-11-29T00:00:00.000Z')});
  assert.equal(result.drafts, 2); assert.equal(result.images, 2);
  const file = new File([result.blob], 'qianmu-excerpt-drafts-1.zip');
  assert.equal(await isItemPack(file), true); assert.equal(await detectStorageFile(file), 'excerpt');
  assert.deepEqual((await readZipDirectory(file)).map(entry => entry.name), ['manifest.json', 'images/1.png', 'images/2.jpg', 'drafts/1.json', 'drafts/2.json', 'studio.json']);

  const target = open('st-user:c');
  await target.saveDraft('item-1', {doc: {v: 'edited later here'}});
  const local = await target.loadDraft('item-1');
  let saved = {schemes: [{id: 's0', name: '本机', scheme: {}}], templates: []};
  const pack = await readExcerptBackup(file);
  assert.deepEqual(pack.manifest.drafts.map(item => item.key), ['item-1', 'reader:book:n1']);
  const merged = await restoreExcerptBackup(pack, {store: target, studio: {read: () => saved, write: value => { saved = value; }}});
  assert.deepEqual(merged, {added: 1, replaced: 0, kept: 1, images: 2, failed: 0, settings: true});
  assert.deepEqual(saved.schemes.map(item => item.name), ['本机', '方案甲']); assert.deepEqual(saved.templates.map(item => item.id), ['t1']);
  assert.deepEqual((await target.loadDraft('item-1')).doc, local.doc, 'the newer local draft wins');
  assert.deepEqual((await target.loadDraft('reader:book:n1')).doc, doc('img-2'));
  assert.equal(await (await target.getImage('img-2')).blob.text(), 'second'); assert.equal((await target.getImage('img-1')).w, 100);
  assert.equal(excerptRestoreText(merged), '已导入 1 份成图稿、2 张图；1 份本机的更新，未替换。');
  assert.equal(excerptRestoreText({...merged, failed: 2}), '已导入 1 份成图稿、2 张图；1 份本机的更新，未替换；2 项未能导入。');
});

test('an empty account exports nothing; a broken backup is refused before writing', async t => {
  const {open} = setup(t), store = open('st-user:a');
  assert.equal(await exportExcerptBackup({store, studio: {schemes: [], templates: []}}), null);
  await assert.rejects(readExcerptBackup(new File(['{"type":"qianmu-excerpt-studio"}'], 'x.json')), /不是书摘成图稿的备份/);
  await store.saveDraft('k', {doc: {}});
  const {blob} = await exportExcerptBackup({store});
  await assert.rejects(readExcerptBackup(blob.slice(0, blob.size - 30)), /备份/);
});

test('merging the studio settings adds what is missing and never pushes local ones out', () => {
  const local = {last: {a: 1}, schemes: [{id: 's1', name: '本机'}], templates: [{id: 't1', source: 'local', updatedAt: 9}]};
  const incoming = {last: {a: 2}, lastReader: {b: 1}, schemes: [{id: 's1', name: '备份同号'}, {id: 's2', name: '新的'}, {id: 's3', name: '超出'}],
    templates: [{id: 't1', source: 'older', updatedAt: 3}, {id: 't2', source: 'new', updatedAt: 1}]};
  const merged = mergeExcerptStudioSettings(local, incoming, {schemes: 2, templates: 30});
  assert.deepEqual(merged.last, {a: 1}); assert.deepEqual(merged.lastReader, {b: 1});
  assert.deepEqual(merged.schemes.map(item => item.name), ['本机', '新的']);
  assert.deepEqual(merged.templates.map(item => item.source), ['local', 'new']);
  assert.deepEqual(mergeExcerptStudioSettings(local, {templates: [{id: 't1', source: 'newer', updatedAt: 10}]}).templates[0].source, 'newer');
  assert.deepEqual(local.schemes.length, 1, 'the local settings object is not mutated');
});

test('dropExcerptDrafts opens and closes a store for the named account and ignores empty requests', async () => {
  const calls = [];
  const createStore = ({namespace}) => ({deleteDrafts: async options => { calls.push([namespace, options]); return 1; }, close: () => calls.push('close')});
  assert.equal(await dropExcerptDrafts({namespace: 'st-user:a', keys: ['k'], createStore}), 1);
  assert.equal(await dropExcerptDrafts({namespace: 'st-user:a', createStore}), 0);
  assert.equal(await dropExcerptDrafts({namespace: '', keys: ['k'], createStore}), 0);
  assert.deepEqual(calls, [['st-user:a', {keys: ['k'], startsWith: ''}], 'close']);
});
