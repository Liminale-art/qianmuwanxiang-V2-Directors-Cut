import test from 'node:test';
import assert from 'node:assert/strict';
import {createGalleryArchiveStorage} from '../qianmu-gallery-archive-storage.js';
import {encodeGalleryArchiveOriginal,inspectGalleryArchiveOriginal} from '../qianmu-gallery-archive-original.js';
import {encodeGalleryArchiveRecord} from '../qianmu-gallery-archive-record.js';
import {galleryDigestRecord} from '../qianmu-chat-gallery-digest.js';
import {decodeGalleryOriginalBlob} from '../qianmu-gallery-original-preview.js';
import {streamCheckpointTransport} from './helpers/stream-checkpoint-fixture.mjs';
import {galleryOriginalHttpFixture,originalPng as png} from './helpers/gallery-original-http-fixture.mjs';

async function fixture(t){
    const f=await galleryOriginalHttpFixture(t),scope={namespace:'st-user:alice',ownerKey:'char:Alice.png',chatKey:'chat'},transport=streamCheckpointTransport(scope.namespace);
    const record=structuredClone(f.rows[0]),proof=await (await f.request('preserve',f.input())).json();let current=true;
    const options={scope,guard:()=>current,verifyRecord:value=>galleryDigestRecord(value).sha256===galleryDigestRecord(record).sha256,createStorage:transport.createStorage};
    const storage=await createGalleryArchiveStorage(options);t.after(()=>storage.close());
    return {...f,scope,transport,record,proof,options,storage,invalidate(){current=false;}};
}
const copies=f=>[...f.transport.files.values()].map(JSON.parse).filter(value=>value.schema==='qianmu.st-account-document.v1'&&value.value.schema==='qianmu.gallery.original-copy.v1');

test('exact original reference is an independent sidecar, readable on reopen with no record rewrite',async t=>{
    const f=await fixture(t),before=structuredClone(f.record),saved=await f.storage.preserveRecord(f.record);
    const result=await f.storage.preserveOriginalReference(f.record,f.proof);assert.equal(result.originalVerified,false);assert.equal(result.canPrune,false);
    assert.deepEqual(f.record,before);assert.deepEqual((await f.storage.readRecord(saved.reference)).record,before);assert.equal(copies(f).length,1);
    f.storage.close();const reopened=await createGalleryArchiveStorage(f.options);t.after(()=>reopened.close());
    const read=await reopened.readOriginal(saved.reference);assert.equal(read.state,'available');assert.deepEqual(read.reference,f.proof.reference);
    assert.equal(read.originalVerified,false,'a sidecar is not current image-byte verification');assert.equal(read.canPrune,false);
    assert.deepEqual((await reopened.readMediaRecord(saved.reference)).record,before);
});

test('reusing a record after other gallery edits retains its first equivalent copy reference',async t=>{
    const f=await fixture(t);await f.storage.preserveRecord(f.record);await f.storage.preserveOriginalReference(f.record,f.proof);
    const writes=f.transport.calls.filter(row=>row.options.method==='POST').length;
    const later=structuredClone(f.proof);later.selection.gallerySha256='b'.repeat(64);await f.storage.preserveOriginalReference(f.record,later);
    assert.equal(f.transport.calls.filter(row=>row.options.method==='POST').length,writes);assert.equal(copies(f)[0].value.source.selection.gallerySha256,f.proof.selection.gallerySha256);
});

test('foreign account, target, URL, time or id cannot be attached to a saved picture',async t=>{
    const f=await fixture(t);await f.storage.preserveRecord(f.record);const before=f.transport.files.size;
    for(const change of [value=>value.expectedAccount='st-user:'+'a'.repeat(64),value=>value.target.chatId='other',value=>value.original.url='/user/images/other.png',
        value=>value.selection.recordId='other',value=>value.selection.createdAt++,value=>value.canPrune=true]){
        const proof=structuredClone(f.proof);change(proof);await assert.rejects(f.storage.preserveOriginalReference(f.record,proof));
    }assert.equal(f.transport.files.size,before);
});

test('sidecar needs an already saved exact record and changed source never gets a success receipt',async t=>{
    const f=await fixture(t);await assert.rejects(f.storage.preserveOriginalReference(f.record,f.proof),/缺失/);assert.equal(f.transport.files.size,0);
    await f.storage.preserveRecord(f.record);f.invalidate();await assert.rejects(f.storage.preserveOriginalReference(f.record,f.proof));assert.equal(copies(f).length,0);
});

test('different content copy for the same record is not allowed to overwrite existing evidence',async t=>{
    const f=await fixture(t),saved=await f.storage.preserveRecord(f.record);await f.storage.preserveOriginalReference(f.record,f.proof);
    const other=structuredClone(f.proof),digest='c'.repeat(64);other.reference.sha256=digest;other.reference.id=digest+other.reference.id.slice(64);other.original.sha256=digest;
    await assert.rejects(f.storage.preserveOriginalReference(f.record,other),/不同原图副本/);
    assert.deepEqual((await f.storage.readOriginal(saved.reference)).reference,f.proof.reference);assert.equal(copies(f).length,1);
});

test('a sidecar is bound to the full original record hash, not merely its reusable id',async t=>{
    const f=await fixture(t),encoded=await encodeGalleryArchiveOriginal(f.scope,f.record,f.proof);
    const modified=await encodeGalleryArchiveRecord(f.scope,{...f.record,future:'edited'});
    await assert.rejects(inspectGalleryArchiveOriginal(f.scope,modified,encoded.value),/此画面版本/);
    const tampered=structuredClone(encoded.value);tampered.source.reference.bytes++;await assert.rejects(inspectGalleryArchiveOriginal(f.scope,encoded.record,tampered));
});

test('missing sidecar remains not-preserved and a combined preview read opens its record only once',async t=>{
    const f=await fixture(t),saved=await f.storage.preserveRecord(f.record),before=f.transport.calls.length;
    const read=await f.storage.readMediaRecord(saved.reference);assert.equal(read.media.state,'not-preserved');assert.equal(read.originalVerified,false);
    assert.equal(f.transport.calls.length-before,3);assert.ok(f.transport.calls.slice(before).every(call=>call.options.method!=='POST'));
});

test('verified blob decode closes bitmaps, bounds pixels and rejects page changes',async()=>{
    const blob=new Blob([png],{type:'image/png'});let closed=0;
    const result=await decodeGalleryOriginalBlob(blob,{decode:async()=>({width:1,height:1,close(){closed++;}})});assert.equal(result.width,1);assert.equal(closed,1);
    for(const dimensions of [{width:0,height:1},{width:8000,height:8000},{width:1.5,height:1}])await assert.rejects(decodeGalleryOriginalBlob(blob,{decode:async()=>({...dimensions,close(){closed++;}})}));
    assert.equal(closed,4);await assert.rejects(decodeGalleryOriginalBlob(blob,{guard:async()=>false,decode:async()=>{throw Error('must not decode');}}),/页面/);
});

test('cancelled slow decodes release their late bitmap without publishing it',{timeout:3000},async()=>{
    let resolve,closed=0;const gate=new Promise(done=>{resolve=done;}),task=decodeGalleryOriginalBlob(new Blob([png],{type:'image/png'}),{timeoutMs:100,decode:()=>gate});
    await assert.rejects(task,/取消或超时/);resolve({width:1,height:1,close(){closed++;}});await new Promise(done=>setTimeout(done,0));assert.equal(closed,1);
});
