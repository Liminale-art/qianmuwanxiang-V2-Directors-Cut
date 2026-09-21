import test from 'node:test';
import assert from 'node:assert/strict';
import { projectGalleryDirectorySnapshot as project, galleryDirectoryTarget as target, createGalleryDirectorySession as create } from '../qianmu-gallery-directory.js';
import { galleryCatalogScopeQuery as query } from '../qianmu-gallery-catalog-contract.js';
import { galleryDirectoryOwnerLabel as label } from '../qianmu-gallery-directory-view.js';
import {chatGalleryDigest} from '../qianmu-chat-gallery-digest.js';
import {CHAT_GALLERY_STREAM_LIMITS} from '../qianmu-chat-gallery-receipt.js';
import {createCurrentChatGalleryReceiptClient} from '../qianmu-chat-character-receipt-client.js';
import {createChatCharacterReceiptService} from '../qianmu-chat-character-receipt-service.js';
import {recipeClientFixture} from './helpers/recipe-client-fixture.mjs';
import {readFile} from 'node:fs/promises';
const ns = 'st-user:alice', source = { ownerKey: 'char:Alice.png', chatKey: 'chat' };
const row = (id = 'a') => ({ id, createdAt: 100, tags: ['海岸'], url: 'https://private/', prompt: 'private', unknown: { preserve: true } });
function fixture(extra = {}) {
    let closed = false, writes = 0, guarded = 0, receiptClosed = 0, stored = [], revision = 0;
    const context = { chatMetadata: { story_director_liminale: { storyboardImages: [row()] } } };
    const client = { owner: { namespace: ns }, source, target: target(source), assertCurrent() { if (closed) throw Error('changed'); },
        async guard() { guarded++; if (closed) throw Error('changed'); }, close() { receiptClosed++; closed = true; },
        inspect: async () => { const gallery=chatGalleryDigest(context.chatMetadata.story_director_liminale.storyboardImages);return {state:gallery===null?'absent':'present',gallery}; }, ...extra.client };
    const store = { page: async () => ({ revision, rows: [] }), scopes: async () => ({ revision, rows: [] }), close() {},
        async upsert(namespace, scope, rows, options) { assert.equal(namespace, ns); assert.deepEqual(scope, source); assert.equal(options.expectedRevision, revision); assert.equal(options.isCurrent(), true); writes++; stored.push(...rows); return { revision: ++revision, changed: rows.length }; }, ...extra.store };
    const options = { getContext: () => context, epoch: () => 1, createClient: async () => client, createStore: () => store, ...extra.options };
    return { context, client, store, options, get writes() { return writes; }, get stored() { return stored; }, get guarded() { return guarded; }, get receiptClosed() { return receiptClosed; } };
}
test('directory projection keeps only actual timestamps, tags and digests, no original content', async () => {
    const input = [row()], copy = structuredClone(input), result = await project(ns, source, input);
    assert.deepEqual(input, copy); assert.equal(result.entries.length, 1);
    assert.doesNotMatch(JSON.stringify(result.entries), /url|private|prompt|unknown/);
    assert.deepEqual(result.snapshot,chatGalleryDigest(input));
    assert.doesNotMatch(JSON.stringify(result),/private|prompt|unknown/);
    assert.notDeepEqual(result.snapshot,chatGalleryDigest([{...input[0],unknown:{preserve:false}}]));
});
test('invalid metadata remains unindexed without fabricated identity or silent clipping', async () => {
    const bad = [{ ...row('b'), createdAt: null }, { ...row('c'), tags: Array(31).fill('x') }, { ...row('d'), id: '' }];
    assert.deepEqual((await project(ns, source, bad)).entries, []); assert.equal((await project(ns, source, bad)).skipped, 3);
    assert.equal((await project(ns, source, undefined)).snapshot, null); assert.equal((await project(ns, source, [])).entries.length, 0);
    await assert.rejects(project(ns, source, [row(), row()]));
    await assert.rejects(project(ns, source, [{ ...row(), createdAt: undefined }]));
    await assert.rejects(project('', source, []));
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
    const f = fixture({ client: { inspect: async () => ({ state:'absent',gallery:null }) } }), s = await create(f.options);
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

test('large directory refresh uses real saved-file receipts without copying or uploading the source', async t => {
    const e=await recipeClientFixture(t),service=createChatCharacterReceiptService({dataRoot:e.root});t.after(()=>service.close());
    e.rows=Array.from({length:6},(_,i)=>({...row('large-'+i),createdAt:i+1,future:'x'.repeat(450000)}));await e.save();
    const disk=await readFile(e.file),before=structuredClone(e.context.chatMetadata),requests=[],f=fixture();
    const s=await create({...f.options,getContext:()=>e.context,epoch:()=>e.epoch,
        createClient:options=>createCurrentChatGalleryReceiptClient({...options,account:async()=>e.account,fetchImpl:async(url,options)=>{
            assert.equal(url,'/api/plugins/qianmu-tts/chat-gallery/receipt');const input=JSON.parse(options.body);requests.push(input);
            assert.deepEqual(Object.keys(input).sort(),['expectedAccount','target','version']);assert.equal(options.credentials,'same-origin');assert.equal(options.headers.Authorization,undefined);
            return Response.json(await service.inspectGallery(e.req,input,{signal:options.signal}));
        }})});t.after(()=>s.close());
    assert.equal((await s.refresh()).indexed,6);assert.equal(requests.length,2);assert.equal(f.stored.length,6);
    assert.doesNotMatch(JSON.stringify(f.stored),/private|future|prompt|snapshot/);assert.deepEqual(e.context.chatMetadata,before);assert.deepEqual(await readFile(e.file),disk);
});

test('projection yields actual event-loop turns and retains only lightweight fingerprints', async () => {
    const rows=Array.from({length:40},(_,i)=>row(String(i)));let turns=0,yields=0;
    const timer=setInterval(()=>turns++,0);
    try {const result=await project(ns,source,rows,{yieldWork:async()=>{yields++;assert.ok(turns>0);}});
        assert.equal(result.fingerprints.size,40);assert.ok(yields>=3);assert.deepEqual(Object.keys(result.snapshot).sort(),['bytes','count','sha256']);
        for(const value of result.fingerprints.values())assert.deepEqual(Object.keys(value).sort(),['index','sha256']);
    } finally {clearInterval(timer);}
});

test('directory rejects accessor, oversized record and aggregate count before any server or index work', async () => {
    let invoked=0;const accessor=row();Object.defineProperty(accessor,'unknown',{enumerable:true,get(){invoked++;throw Error('must not execute');}});
    for(const rows of [[accessor],[{...row(),future:'x'.repeat(2*1024*1024)}],Array.from({length:CHAT_GALLERY_STREAM_LIMITS.records+1},(_,i)=>row(String(i)))]){
        const f=fixture({client:{inspect:async()=>assert.fail('invalid source must not request a receipt')}});f.context.chatMetadata.story_director_liminale.storyboardImages=rows;
        const s=await create(f.options);await assert.rejects(s.refresh());assert.equal(f.writes,0);s.close();
    }assert.equal(invoked,0);
});

test('replacement of the whole gallery during receipt validation aborts before directory writes', async () => {
    const f=fixture(),original=f.client.inspect;f.client.inspect=async()=>{const receipt=await original();f.context.chatMetadata.story_director_liminale.storyboardImages=structuredClone(f.context.chatMetadata.story_director_liminale.storyboardImages);return receipt;};
    const s=await create(f.options);await assert.rejects(s.refresh(),/变化/);assert.equal(f.writes,0);s.close();
});

test('edits in a pending batch stop that batch; already verified historical references remain', async () => {
    const f=fixture(),put=f.store.upsert,rows=Array.from({length:405},(_,i)=>row(String(i)));f.context.chatMetadata.story_director_liminale.storyboardImages=rows;
    f.store.upsert=async(...args)=>{const result=await put(...args);rows[200].unknown.preserve=false;return result;};
    const s=await create(f.options);await assert.rejects(s.refresh(),/变化/);assert.equal(f.writes,1);assert.equal(f.stored.length,200);assert.equal(rows.length,405);assert.equal(rows[200].unknown.preserve,false);s.close();
});

test('final full-source verification catches edits behind completed batches and skipped rows', async () => {
    for(const skipped of [false,true]){
        const f=fixture(),rows=Array.from({length:405},(_,i)=>row(String(i)));if(skipped)rows[0].createdAt=null;
        f.context.chatMetadata.story_director_liminale.storyboardImages=rows;const saved={state:'present',gallery:chatGalleryDigest(rows)};f.client.inspect=async()=>saved;
        const put=f.store.upsert;f.store.upsert=async(...args)=>{const result=await put(...args);rows[0].unknown.preserve=false;return result;};
        const s=await create(f.options);await assert.rejects(s.refresh(),/变化/);assert.equal(f.writes,3);assert.equal(f.stored.length,skipped?404:405);assert.equal(rows.length,405);s.close();
    }
});

test('both saved-source checks compare count and bytes, not only a matching hash', async () => {
    for(const when of ['before','after'])for(const field of ['count','bytes','state']){
        const f=fixture(),inspect=f.client.inspect;let calls=0;
        f.client.inspect=async()=>{const receipt=await inspect();if(++calls===(when==='before'?1:2)){if(field==='state')receipt.state='absent';else receipt.gallery[field]++;}return receipt;};
        const s=await create(f.options);await assert.rejects(s.refresh(),/服务器/);assert.equal(f.writes,when==='before'?0:1);assert.equal(f.context.chatMetadata.story_director_liminale.storyboardImages.length,1);s.close();
    }
});

test('source hashing grows linearly with records, not with the number of write batches', async () => {
    for(const count of [201,801]){
        const f=fixture(),plain=Array.from({length:count},(_,i)=>row(String(i))),saved={state:'present',gallery:chatGalleryDigest(plain)};let inspected=0;
        f.client.inspect=async()=>saved;f.context.chatMetadata.story_director_liminale.storyboardImages=plain.map(value=>new Proxy(value,{getOwnPropertyDescriptor(target,key){if(key==='unknown')inspected++;return Reflect.getOwnPropertyDescriptor(target,key);}}));
        // Four source passes; strict JSON capture inspects each descriptor twice.
        const s=await create(f.options);assert.equal((await s.refresh()).indexed,count);assert.equal(inspected,count*8);assert.equal(f.writes,Math.ceil(count/200));s.close();
    }
});

test('closing during the first yielding projection makes no receipt request or derived write', async () => {
    let requested=0;const f=fixture({client:{inspect:async()=>{requested++;throw Error('must not reach receipt');}}});
    f.context.chatMetadata.story_director_liminale.storyboardImages=Array.from({length:500},(_,i)=>row(String(i)));
    const s=await create(f.options),pending=s.refresh(),rejected=assert.rejects(pending,/关闭|changed/);
    const timer=setTimeout(()=>s.close(),0);try{await rejected;assert.equal(requested,0);assert.equal(f.writes,0);}finally{clearTimeout(timer);s.close();}
});

test('directory storage conflict releases refresh lock and retries without changing original data', async () => {
    const f=fixture(),before=structuredClone(f.context),put=f.store.upsert;let failOnce=true;
    f.store.upsert=async(...args)=>{if(failOnce){failOnce=false;throw Error('revision conflict');}return put(...args);};
    const s=await create(f.options);await assert.rejects(s.refresh(),/revision conflict/);assert.equal(f.writes,0);
    assert.equal((await s.refresh()).indexed,1);assert.deepEqual(f.context,before);s.close();
});
test('edits while checking abort before writes and never overwrite the chat', async () => {
    const f = fixture({ client: { inspect: async () => { const gallery=chatGalleryDigest(f.context.chatMetadata.story_director_liminale.storyboardImages);f.context.chatMetadata.story_director_liminale.storyboardImages[0].unknown.preserve = false; return {state:'present',gallery}; } } });
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

test('historical preview binds a fresh receipt and record selector without writing current chat or index', async () => {
    let selection, released=0, loaded=0;
    const f=fixture({options:{
        createHistoricalClient:()=>({inspect:async()=>({state:'present',gallery:{sha256:'a'.repeat(64)}}),close(){released++;}}),
        createRecordClient:()=>({read:async input=>{selection=input;return {record:{id:'old',createdAt:3,url:'/user/images/fixture.png',tags:[]}};},close(){released++;}}),
        loadImage:async(url,options)=>{assert.equal(url,'/user/images/fixture.png');await options.guard();loaded++;return {blob:new Blob(['fixture']),width:10,height:20};},
    }}),s=await create(f.options),before=structuredClone(f.context);
    const selected={namespace:ns,ownerKey:'char:B.png',chatKey:'old-chat',recordId:'old',createdAt:3,kind:'still'};
    const result=await s.preview(selected);assert.deepEqual(selection,{recordId:'old',createdAt:3,gallerySha256:'a'.repeat(64)});
    assert.equal(result.source.ownerKey,'char:B.png');assert.equal(loaded,1);assert.equal(released,2);assert.equal(f.writes,0);assert.deepEqual(f.context,before);
    await assert.rejects(s.preview({...selected,namespace:'st-user:other'}));await assert.rejects(s.preview({...selected,kind:'motion'}));s.close();
});

test('cancel between historical metadata and image fetch releases readers without fetching image', async () => {
    let s,loaded=0,released=0;
    const f=fixture({options:{
        createHistoricalClient:()=>({inspect:async()=>({state:'present',gallery:{sha256:'a'.repeat(64)}}),close(){released++;}}),
        createRecordClient:()=>({read:async()=>{s.close();return {record:{url:'/user/images/fixture.png'}};},close(){released++;}}),
        loadImage:async()=>{loaded++;},
    }});s=await create(f.options);
    await assert.rejects(s.preview({namespace:ns,...source,recordId:'old',createdAt:3,kind:'still'}));assert.equal(loaded,0);assert.ok(released>=2);assert.equal(f.writes,0);
});

function savingFixture({ mime = 'image/png', duringRead = async () => {}, guard = async () => {} } = {}) {
    let reads = 0, loads = 0, released = 0;
    const record = { id: 'old/private:name', createdAt: 3, url: '/user/images/fixture.png', tags: ['original'] };
    const blob = new Blob(['original bytes, never re-encoded'], { type: mime }), selections = [], targets = [];
    const f = fixture({ options: { guard,
        createHistoricalClient: () => ({ inspect: async () => ({ state: 'present', gallery: { sha256: 'a'.repeat(64) } }), close() { released++; } }),
        createRecordClient: options => { targets.push(options.target); return { async read(selection) { reads++; selections.push(selection); await duringRead(reads); return { record: structuredClone(record) }; }, close() { released++; } }; },
        loadImage: async () => { loads++; return { blob, width: 10, height: 20 }; },
    } });
    return { ...f, record, blob, selections, targets, get reads() { return reads; }, get loads() { return loads; }, get released() { return released; },
        selected: { namespace: ns, ownerKey: 'char:B.png', chatKey: 'historical', recordId: record.id, createdAt: 3, kind: 'still' } };
}

test('historical saving rechecks the exact source and downloads identical preview bytes without a second media request', async () => {
    for (const [mime, extension] of [['image/png','png'],['image/jpeg','jpg'],['image/webp','webp']]) {
        const f = savingFixture({ mime }), before = structuredClone(f.context), s = await create(f.options), preview = await s.preview(f.selected);
        let saved; const result = await s.savePreview(preview, (blob, filename) => saved = { blob, filename });
        assert.equal(saved.blob, f.blob); assert.equal(await saved.blob.text(), 'original bytes, never re-encoded');
        assert.equal(saved.filename, `qianmu-still-3.${extension}`); assert.equal(result.bytes, f.blob.size);
        assert.equal(f.loads, 1); assert.equal(f.reads, 2); assert.equal(f.released, 3);
        assert.deepEqual(f.selections[0], f.selections[1]); assert.deepEqual(f.targets[1], { kind: 'character', chatId: 'historical', avatar: 'B.png' });
        assert.deepEqual(f.context, before); assert.ok(Object.isFrozen(preview) && Object.isFrozen(preview.record.tags)); s.close();
    }
});

test('copied, released, foreign-session or closed preview cannot authorize a download', async () => {
    const f = savingFixture(), s = await create(f.options), preview = await s.preview(f.selected), otherFixture = savingFixture(), other = await create(otherFixture.options);
    await assert.rejects(s.savePreview({ ...preview }, () => assert.fail('forged download')));
    await assert.rejects(other.savePreview(preview, () => assert.fail('foreign download'))); other.close();
    s.releasePreview(preview); await assert.rejects(s.savePreview(preview, () => assert.fail('released download')));
    const reopened = await s.preview(f.selected); s.close(); await assert.rejects(s.savePreview(reopened, () => assert.fail('closed download')));
});

test('changed historical record and missing source reject saving without falling back to an unverified URL', async () => {
    for (const change of [() => { throw Error('record_changed'); }, () => { throw Error('record_missing'); }, record => { record.url = '/user/images/replaced.png'; }]) {
        const f = savingFixture({ duringRead: async n => { if (n === 2) change(f.record); } });
        const s = await create(f.options), preview = await s.preview(f.selected);
        await assert.rejects(s.savePreview(preview, () => assert.fail('stale download'))); assert.equal(f.loads, 1); assert.equal(f.released, 3); s.close();
    }
});

test('account/source guard failure during revalidation never invokes browser download', async () => {
    let changed = false;
    const f = savingFixture({ guard: async () => { if (changed) throw Error('account changed'); }, duringRead: async n => { if (n === 2) changed = true; } });
    const s = await create(f.options), preview = await s.preview(f.selected);
    await assert.rejects(s.savePreview(preview, () => assert.fail('wrong-account download')), /account changed/); assert.equal(f.loads, 1);
});

test('closing or releasing a preview during pending metadata revalidation suppresses late download', async () => {
    for (const close of [false, true]) {
        let release, started; const waiting = new Promise(resolve => started = resolve), gate = new Promise(resolve => release = resolve);
        const f = savingFixture({ duringRead: async n => { if (n === 2) { started(); await gate; } } }), s = await create(f.options), preview = await s.preview(f.selected);
        const pending = s.savePreview(preview, () => assert.fail('late download')); await waiting;
        if (close) s.close(); else s.releasePreview(preview); release(); await assert.rejects(pending, /关闭/); s.close();
    }
});

test('duplicate save is blocked until the first request exits, and callback failure permits explicit retry', async () => {
    let release, started; const waiting = new Promise(resolve => started = resolve), gate = new Promise(resolve => release = resolve);
    const f = savingFixture({ duringRead: async n => { if (n === 2) { started(); await gate; } } }), s = await create(f.options), preview = await s.preview(f.selected);
    const pending = s.savePreview(preview, () => { throw Error('browser download blocked'); }); await waiting;
    await assert.rejects(s.savePreview(preview, () => assert.fail('duplicate download')), /正在/); release(); await assert.rejects(pending, /browser download blocked/);
    let saved = 0; await s.savePreview(preview, () => saved++); assert.equal(saved, 1); assert.equal(f.reads, 3); assert.equal(f.loads, 1); s.close();
});

test('historical details are bound to the exact live preview and never read local recipes or current settings',async()=>{
    let reads=0,closed=0;const f=savingFixture();
    f.options.createDetailsClient=options=>({async read(selection){reads++;assert.deepEqual(options.target,target({ownerKey:f.selected.ownerKey,chatKey:f.selected.chatKey}));assert.deepEqual(selection,{recordId:f.record.id,createdAt:3,gallerySha256:'a'.repeat(64)});return {record:{generation:{prompt:'historical only'}}};},close(){closed++;}});
    const session=await create(f.options),preview=await session.preview(f.selected);assert.deepEqual(await session.previewDetails(preview),{prompt:'historical only'});
    assert.equal(f.loads,1);assert.equal(reads,1);assert.equal(closed,1);await assert.rejects(session.previewDetails({...preview}),/不是/);
    session.releasePreview(preview);await assert.rejects(session.previewDetails(preview),/关闭/);session.close();
});

test('released previews and cancelled detail reads cannot return late generation data',async()=>{
    for(const change of ['release','close','abort']){
        let release,started;const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>started=resolve),f=savingFixture(),controller=new AbortController();
        f.options.createDetailsClient=()=>({async read(){started();await gate;return {record:{generation:{prompt:'late'}}};},close(){}});
        const session=await create(f.options),preview=await session.preview(f.selected),pending=session.previewDetails(preview,{signal:controller.signal});await ready;
        if(change==='release')session.releasePreview(preview);else if(change==='close')session.close();else controller.abort();release();await assert.rejects(pending);session.close();
    }
});
