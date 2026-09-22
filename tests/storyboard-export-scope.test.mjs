import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { captureStoryboardExportImages as capture } from '../qianmu-storyboard-export-scope.js';
import * as board from '../qianmu-storyboard.js';
import * as pack from '../qianmu-storyboard-package-assets.js';
import { inspectStoryboardPackageFile } from '../qianmu-storyboard-package-input.js';
import { storyboardFunctionSource as section } from './helpers/storyboard-form-fixture.mjs';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';
const rows = () => [{ id: 'a', createdAt: 1, floor: 0, tags: ['海岸'], prompt: 'keep original prompt', url: '/a.png', snapshot: {} },
    { id: 'b', createdAt: 2, floor: 3, tags: ['人物'], prompt: 'unselected prompt', url: '/b.png', snapshot: {} }];
test('scope exposes only lightweight chooser metadata and copies exact selected records in source order', () => {
    const original = rows(), before = structuredClone(original), census = capture(original), scope = census.select(['b','a']);
    assert.deepEqual(census.rows[0], { id: 'a', createdAt: 1, floor: 0, label: '海岸' });
    assert.equal(JSON.stringify(census.rows).includes('prompt'), false); assert.deepEqual(scope.read(original), before);
    const chosen = census.select(['b']).read(original); chosen[0].prompt = 'edited copy'; assert.deepEqual(original, before);
});
test('scope rejects duplicate/missing IDs, empty accidental selection and foreign records', () => {
    for (const list of [[...rows(), rows()[0]], [{ id: '' }], new Array(2), Array.from({ length: 401 }, (_, i) => ({ id: String(i) }))]) assert.throws(() => capture(list));
    const census = capture(rows()); for (const ids of [[], ['missing'], ['a','a'], [null], new Array(1)]) assert.throws(() => census.select(ids));
    const empty = capture([]).select([]); assert.equal(empty.count, 0); assert.deepEqual(empty.read([]), []);
});
test('any change in displayed source list invalidates selection without silently choosing a replacement', () => {
    for (const change of [list => list.pop(), list => list.reverse(), list => list[0].url = '/new.png', list => list[1].prompt = 'edited', list => list.push({ id: 'new' })]) {
        const original = rows(), scope = capture(original).select(['a']); change(original); assert.throws(() => scope.read(original), /已变化/);
    }
});
test('legacy missing times/floors are labeled unknown without fabricating metadata', () => {
    const original = [{ id: 'legacy', createdAt: 'yesterday', floor: -1, tags: ['name'], unknown: { keep: true } }], scope = capture(original);
    assert.equal(scope.rows[0].createdAt, null); assert.equal(scope.rows[0].floor, null); assert.deepEqual(scope.select(['legacy']).read(original), original);
});
test('chooser metadata bound refuses oversized or cyclic records rather than truncating source', () => {
    const cyclic = rows(); cyclic[0].self = cyclic[0]; assert.throws(() => capture(cyclic));
    assert.throws(() => capture([{ id: 'a', prompt: 'x'.repeat(32 * 1048576) }]), /32 MiB/);
});

function fixture({ cancel = false, choose = ['b'] } = {}) {
    const images = rows(), state = board.createStoryboardDefaults(), store = {}, downloads = [], media = [], events = [], notices = [];
    let selectedPayload, onLate = () => {};
    const captureModule = { async runStoryboardBundle(action, file) { events.push(action); if (action === 'chat-evidence') return { chatEvidence: { digest: 'chat' } }; if (action === 'capture') { onLate(); return { file }; } throw Error('unexpected action'); } };
    const modules = { storyboardPackageAssets: pack, imageAdmission: { resolveImageAccountNamespace: async () => 'st-user:fixture' },
        storyboardBundleSource: { prepareStoryboardBundleSource: async () => { events.push('source'); return { source: {}, verify: async () => {} }; } }, storyboardBundleCapture: captureModule,
        storyboardPackageInput: { readStoryboardPackageImage: async url => { media.push(url); if (f.failMedia) throw Error('missing selected original'); return new Blob([Buffer.from(png,'base64')], { type: 'image/png' }); } },
        storyboardPackageRuntime: { exportStoryboardPackageAssets: async (payload, options) => { selectedPayload = payload; return pack.buildStoryboardVibePackage(payload, { namespace: options.namespace, load: () => assert.fail('unexpected vibe dependency') }); } } };
    const context = vm.createContext({ ...board, Blob, clone: structuredClone, MODAL_ID: 'fixture', storyboardAdmissionEpoch: 1,
        featureRuntime: { load: async name => { assert.ok(modules[name], name); return modules[name]; } }, document: { getElementById: () => ({}) },
        loadLocalChunk: async () => ({ chooseStoryboardExportImages: async options => { events.push('choose'); await options.guard(); return cancel ? null : capture(options.readRecords()).select(choose); } }),
        storyboardPackageContext: () => Object.assign(() => ({ state, store, chatKey: 'same', epoch: context.storyboardAdmissionEpoch }), { release: () => events.push('release') }),
        storyboardState: () => state, ctx: () => ({ chat: [], getRequestHeaders: () => ({}) }), getChatKey: () => 'same',
        storyboardCaptureSubjectEvidence: async () => ({ digest: 'subjects' }), storyboardHydratePipelineArchive: async () => {},
        storyboardGalleryRecords: () => images, storyboardGalleryCollections: () => [], storyboardSnapshotForRecord: row => row.snapshot,
        storyboardPipelineForLog: () => null, storyboardPlansForPortableExport: async value => value,
        storyboardSafeUrl: url => url, blobToBase64: async () => png, confirmDialog: async () => true,
        fileStamp: () => 'fixture', ttsDownloadBlob: (blob, name) => downloads.push({ blob, name }), toast: (...args) => notices.push(args) });
    vm.runInContext(section('storyboardExportPackage'), context);
    const f = { context, images, state, downloads, media, events, notices, payload: () => selectedPayload, late: run => { onLate = run; } }; return f;
}
test('actual bundle entry exports only selected originals in unchanged v7 packet and marks partial filename', async () => {
    const f = fixture(), before = structuredClone(f.images); await f.context.storyboardExportPackage({ bundle: true });
    assert.equal(f.downloads.length, 1, JSON.stringify(f.notices)); assert.deepEqual(f.media, ['/b.png']); assert.deepEqual(f.images, before);
    assert.match(f.downloads[0].name, /bundle-part-1-of-2-fixture\.qmb$/); assert.ok(f.events.indexOf('choose') < f.events.indexOf('source'));
    const inspected = await inspectStoryboardPackageFile(f.downloads[0].blob);
    assert.equal(inspected.payload.version, 7); assert.deepEqual(inspected.payload.chat.images.map(row => row.id), ['b']); assert.deepEqual(inspected.payload.media.map(row => row.id), ['b']);
    assert.equal(inspected.payload.chat.images[0].prompt, before[1].prompt); assert.equal(f.context.storyboardExportPackage.busy, false);
});
test('all-images selection keeps the existing complete filename and packet image coverage', async () => {
    const f = fixture({ choose: ['a','b'] }); await f.context.storyboardExportPackage({ bundle: true }); assert.equal(f.downloads.length, 1, JSON.stringify(f.notices));
    assert.equal(f.downloads[0].name, 'qianmu-storyboard-bundle-fixture.qmb'); assert.deepEqual(f.media, ['/a.png','/b.png']);
});

test('actual bundle export awaits strong local recipe reads for detached selected records, never the unscoped cache', async () => {
    const f = fixture(), row = f.images[1]; delete row.snapshot; row.snapshotRef = 'same\u241fb\u241frevision:' + 'a'.repeat(64);
    const before = structuredClone(f.images); let reads = 0;
    f.context.storyboardSnapshotForRecord = () => assert.fail('strong references require guarded reading');
    f.context.storyboardReadSnapshotForRecord = async value => { reads++; assert.notEqual(value,row); assert.deepEqual(value,row); return {}; };
    await f.context.storyboardExportPackage({ bundle: true });
    assert.equal(reads,1); assert.equal(f.downloads.length,1,JSON.stringify(f.notices)); assert.deepEqual(f.images,before);
});

test('failed strong local recipe read aborts export before media and download, without current-settings fallback', async () => {
    const f = fixture(), row = f.images[1]; delete row.snapshot; row.snapshotRef = 'same\u241fb\u241frevision:' + 'a'.repeat(64);
    f.context.storyboardReadSnapshotForRecord = async () => { throw Error('original recipe could not be verified'); };
    await f.context.storyboardExportPackage({ bundle: true });
    assert.equal(f.downloads.length,0); assert.deepEqual(f.media,[]); assert.match(f.notices.at(-1)[0],/could not be verified/);
    assert.equal(f.context.storyboardExportPackage.busy,false);
});

test('selecting one image never reads an unselected recipe even when the gallery contains hundreds of references',async()=>{
    const f=fixture(),readIds=[];
    f.images.push(...Array.from({length:298},(_,i)=>({id:'other-'+i,createdAt:i+3,url:'/other-'+i+'.png',snapshotRef:'same␟other-'+i})));
    for(const row of f.images){delete row.snapshot;row.snapshotRef||='same␟'+row.id;}
    const before=JSON.stringify(f.images);
    f.context.storyboardReadSnapshotForRecord=async row=>{readIds.push(row.id);assert.equal(row.id,'b','unselected originals must not be read or block this export');return {};};
    f.context.storyboardSnapshotForRecord=()=>assert.fail('references must use the guarded reader');
    await f.context.storyboardExportPackage({bundle:true});
    assert.equal(f.downloads.length,1,JSON.stringify(f.notices));assert.deepEqual(readIds,['b']);assert.deepEqual(f.media,['/b.png']);
    assert.equal(JSON.stringify(f.images),before);
});

test('complete configuration export reads each referenced recipe exactly once and does not prewarm local storage',async()=>{
    const f=fixture(),readIds=[];
    for(const row of f.images){delete row.snapshot;row.snapshotRef='same␟'+row.id;}
    f.context.storyboardReadSnapshotForRecord=async row=>{readIds.push(row.id);return {};};
    await f.context.storyboardExportPackage({originals:false});
    assert.equal(f.downloads.length,1,JSON.stringify(f.notices));assert.deepEqual(readIds,['a','b']);
});

test('legacy base-reference bundle export also requires scoped reviewed content rather than an old memory cache',async()=>{
    const f=fixture(),row=f.images[1];delete row.snapshot;row.snapshotRef='same\u241fb';let reads=0;
    f.context.storyboardSnapshotForRecord=()=>assert.fail('legacy base cannot borrow unscoped cache');
    f.context.storyboardReadSnapshotForRecord=async value=>{assert.deepEqual(value,row);reads++;return {};};
    await f.context.storyboardExportPackage({bundle:true});assert.equal(reads,1);assert.equal(f.downloads.length,1,JSON.stringify(f.notices));
});
test('chooser cancellation happens before source setup, media reads and library capture, and releases lock', async () => {
    const f = fixture({ cancel: true }); await f.context.storyboardExportPackage({ bundle: true });
    assert.deepEqual(f.events, ['choose','release']); assert.deepEqual(f.media, []); assert.equal(f.downloads.length, 0); assert.equal(f.context.storyboardExportPackage.busy, false);
});
test('a selected missing original aborts the whole file instead of producing a partial backup', async () => {
    const f = fixture(); f.failMedia = true; await f.context.storyboardExportPackage({ bundle: true });
    assert.equal(f.downloads.length, 0); assert.match(f.notices.at(-1)[0], /missing selected original/); assert.equal(f.context.storyboardExportPackage.busy, false);
});
test('source mutation after bundle worker completion is caught before browser download', async () => {
    const f = fixture(); f.late(() => f.images[0].prompt = 'source changed after capture'); await f.context.storyboardExportPackage({ bundle: true });
    assert.equal(f.downloads.length, 0); assert.match(f.notices.at(-1)[0], /已变化/); assert.equal(f.context.storyboardExportPackage.busy, false);
});
