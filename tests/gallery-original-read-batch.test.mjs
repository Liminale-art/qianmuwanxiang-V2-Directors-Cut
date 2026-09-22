import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createGalleryOriginalClient} from '../qianmu-gallery-original-client.js';
import {GALLERY_ORIGINAL_MAX_BYTES} from '../qianmu-gallery-original-contract.js';
import {originalPng as png,originalHash as sha} from './helpers/gallery-original-http-fixture.mjs';
const gate=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve};};
function fixture(t){
  const expectedAccount='st-user:'+sha('alice'),state={account:'st-user:alice',calls:[],hook:null};
  const references=Array.from({length:8},()=>({version:1,id:sha(png)+'-'+randomUUID(),sha256:sha(png),bytes:png.length,mime:'image/png'}));
  const client=createGalleryOriginalClient({account:async()=>state.account,headers:()=>({'X-CSRF-Token':'test-only',Authorization:'DO_NOT_SEND'}),fetchImpl:async(url,options)=>{
    state.calls.push({url,options});assert.equal(options.headers.Authorization,undefined);assert.equal(options.headers['X-CSRF-Token'],'test-only');
    assert.equal(options.credentials,'same-origin');assert.equal(options.redirect,'error');
    if(state.hook){const result=await state.hook(url,options);if(result)return result;}
    if(url.endsWith('/capabilities'))return Response.json({ok:true,version:1,expectedAccount,selectorOnly:true,maxBytes:GALLERY_ORIGINAL_MAX_BYTES,canPrune:false});
    assert.ok(url.endsWith('/read'));const body=JSON.parse(options.body);assert.equal(body.expectedAccount,expectedAccount);
    return new Response(png,{headers:{'Content-Type':'image/png','Content-Length':String(png.length),'X-Qianmu-Original-Sha256':sha(png),'X-Qianmu-Original-Account':expectedAccount}});
  }});t.after(()=>client.close());return {state,references,client,expectedAccount};
}

test('eight verified originals share one capability check, preserve order, and return no Blob array',async t=>{
  const f=fixture(t),visited=[],input=structuredClone(f.references),pending=f.client.readBatch(input,{visit:async(result,index)=>{
    assert.equal(index,visited.length);assert.deepEqual(result.reference,f.references[index]);assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()),png);visited.push(index);
  }});input.reverse();input[0].id='changed';const result=await pending;
  assert.deepEqual(visited,[0,1,2,3,4,5,6,7]);assert.deepEqual(result,{count:8,proof:'original-batch-readback',originalVerified:true,canPrune:false});
  assert.equal(f.state.calls.length,9);assert.equal(f.state.calls.filter(c=>c.url.endsWith('/capabilities')).length,1);
});

test('invalid batches and missing receivers reject before any network or capability calls',async t=>{
  const f=fixture(t);for(const refs of [[],[...f.references,f.references[0]],[f.references[0],f.references[0]],[,],[{...f.references[0],bytes:0}]])await assert.rejects(f.client.readBatch(refs,{visit(){}}));
  await assert.rejects(f.client.readBatch([f.references[0]]));assert.equal(f.state.calls.length,0);
});

test('batch backpressure prevents reading ahead and receiver failure does not retry or read the rest',async t=>{
  const f=fixture(t),wait=gate();let entered;const started=new Promise(r=>entered=r),pending=f.client.readBatch(f.references,{visit:async()=>{entered();await wait.promise;throw Error('receiver failed');}});
  await started;assert.equal(f.state.calls.length,2);await assert.rejects(f.client.read(f.references[0]),/正在读取/);wait.resolve();await assert.rejects(pending,/receiver failed/);assert.equal(f.state.calls.length,2);
});

test('bad bytes, wrong account headers and missing second file never return batch success or fallback',async t=>{
  for(const mode of ['bytes','account','missing']){
    const f=fixture(t);let reads=0,delivered=0;f.state.hook=(url)=>{
      if(!url.endsWith('/read')||++reads!==2)return;
      if(mode==='missing')return new Response('',{status:404});
      const bytes=mode==='bytes'?Buffer.alloc(png.length):png;
      return new Response(bytes,{headers:{'Content-Type':'image/png','Content-Length':String(png.length),'X-Qianmu-Original-Sha256':sha(png),'X-Qianmu-Original-Account':mode==='account'?'st-user:'+sha('other'):f.expectedAccount}});
    };
    await assert.rejects(f.client.readBatch(f.references,{visit:()=>{delivered++;}}));assert.equal(delivered,1);assert.equal(reads,2);assert.equal(f.state.calls.length,3);
  }
});

test('account switch after a delivered image prevents the next read within the same batch',async t=>{
  const f=fixture(t);await assert.rejects(f.client.readBatch(f.references,{visit:()=>{f.state.account='st-user:other';}}),/账户/);assert.equal(f.state.calls.length,2);
});

test('closing a blocked callback rejects promptly and cannot trigger another image after it settles',async t=>{
  const f=fixture(t),wait=gate();let entered;const started=new Promise(r=>entered=r),pending=f.client.readBatch(f.references,{visit:async()=>{entered();await wait.promise;}});
  await started;f.client.close();await assert.rejects(pending,/取消/);wait.resolve();await new Promise(r=>setTimeout(r,0));assert.equal(f.state.calls.length,2);
});
