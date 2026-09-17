import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGalleryPreviewImage as load, GALLERY_PREVIEW_MAX_BYTES as MAX } from '../qianmu-gallery-preview-media.js';
const url='/user/images/fixture.png',png=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]);
const response=(bytes=png,headers={})=>new Response(bytes,{headers:{'content-type':'image/png',...headers}});
const decode=async()=>({width:800,height:1200,close(){}});
test('preview fetches one same-origin no-store image with no headers, redirect or provider request',async()=>{
  let closed=0,guards=0;
  const result=await load(url,{guard:async()=>{guards++;},decode:async()=>({width:800,height:1200,close(){closed++;}}),fetchImpl:async(path,options)=>{
    assert.equal(path,url);assert.equal(options.headers,undefined);assert.equal(options.credentials,'same-origin');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');return response();
  }});
  assert.equal(result.width,800);assert.equal(result.height,1200);assert.equal(result.blob.size,png.length);assert.equal(closed,1);assert.equal(guards,3);
});
test('external, transient, non-image and traversal locations never reach fetch',async()=>{
  for(const value of ['https://private.invalid/a.png','//private.invalid/a.png','blob:old','data:image/png;base64,AAAA','/api/delete.png','/user/images/../a.png','/user/images/%2e%2e/a.png','/user/images/a.svg','/user/images/a.png?token=private']){
    let calls=0;await assert.rejects(load(value,{fetchImpl:async()=>{calls++;return response();},decode}));assert.equal(calls,0);
  }
});
test('bad status, MIME, signatures, suffix and empty bytes fail before decoding',async()=>{
  for(const reply of [new Response('missing',{status:404}),response(new Uint8Array()),response(new Uint8Array([1,2,3])),response(png,{'content-type':'text/html'}),response(png,{'content-type':'image/jpeg'})]){
    let calls=0;await assert.rejects(load(url,{fetchImpl:async()=>reply,decode:async()=>{calls++;return decode();}}));assert.equal(calls,0);
  }
});
test('advertised and streamed size limits cancel rather than accumulate unbounded bytes',async()=>{
  let cancelled=0;
  const declared=new Response(new ReadableStream({cancel(){cancelled++;}}),{headers:{'content-type':'image/png','content-length':String(MAX+1)}});
  await assert.rejects(load(url,{fetchImpl:async()=>declared,decode}));assert.equal(cancelled,1);
  const oversized=new ReadableStream({start(c){c.enqueue(new Uint8Array(MAX));c.enqueue(png);},cancel(){cancelled++;}});
  await assert.rejects(load(url,{fetchImpl:async()=>new Response(oversized,{headers:{'content-type':'image/png'}}),decode}));assert.equal(cancelled,2);
});
test('abort before fetch, stalled body and stalled guard never decode or dispatch after deadline',async()=>{
  const controller=new AbortController();controller.abort();let calls=0;
  await assert.rejects(load(url,{signal:controller.signal,fetchImpl:async()=>{calls++;return response();},decode}));assert.equal(calls,0);
  let cancelled=false;const stream=new ReadableStream({cancel(){cancelled=true;}});
  await assert.rejects(load(url,{timeoutMs:100,fetchImpl:async()=>new Response(stream,{headers:{'content-type':'image/png'}}),decode}));assert.equal(cancelled,true);
  let release;const gate=new Promise(resolve=>release=resolve);
  await assert.rejects(load(url,{timeoutMs:100,guard:()=>gate,fetchImpl:async()=>{calls++;return response();},decode}));release();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,0);
});
test('late decode and pixel-limit failure close temporary bitmaps, never issue a preview URL',async()=>{
  let closed=0;
  await assert.rejects(load(url,{fetchImpl:async()=>response(),decode:async()=>({width:10000,height:10000,close(){closed++;}})}));assert.equal(closed,1);
  let release;const gate=new Promise(resolve=>release=resolve);
  await assert.rejects(load(url,{timeoutMs:100,fetchImpl:async()=>response(),decode:()=>gate}));
  release({width:1,height:1,close(){closed++;}});await new Promise(resolve=>setImmediate(resolve));assert.ok(closed>=2);
});
test('account change after image read discards bytes before decode or result handoff',async()=>{
  let guards=0,decodes=0;
  await assert.rejects(load(url,{fetchImpl:async()=>response(),guard:async()=>{if(++guards===2)throw Error('changed');},decode:async()=>{decodes++;return decode();}}));
  assert.equal(decodes,0);
});
