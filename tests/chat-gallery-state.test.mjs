import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {chatStateFixture} from './helpers/chat-state-fixture.mjs';
import {sha} from './helpers/chat-evidence-fixture.mjs';
import {createChatGalleryStateClient} from '../qianmu-chat-character-receipt-client.js';
import {chatGalleryStateRequest,chatGalleryStateResponse,CHAT_GALLERY_STATE_LIMITS} from '../qianmu-chat-gallery-state.js';
import {init,exit} from '../server-plugin.js';
const reject=(promise,code)=>assert.rejects(promise,{code:'chat_character_receipt_'+code});
const client=(f,options={})=>createChatGalleryStateClient({namespace:'st-user:alice',target:f.target,fetchImpl:f.fetch,...options});
const gate=()=>{let release;return {promise:new Promise(done=>release=done),release:value=>release(value)};};

test('saved state preserves actual originals and future fields, never current settings or unrelated metadata',async t=>{
  const f=await chatStateFixture(t),before=await fs.readFile(f.file),names=await fs.readdir(f.user);
  const result=await f.service.readGalleryState(f.req,f.request());assert.deepEqual(result.saved,f.saved);
  assert.equal(result.sha256,sha(JSON.stringify(f.saved)));assert.equal(result.source.kind,'jsonl-header');
  const header=before.subarray(0,before.indexOf(10));assert.equal(result.source.bytes,header.length);assert.equal(result.source.sha256,sha(header));
  assert.doesNotMatch(JSON.stringify(result),/WRONG_GLOBAL|PRIVATE_HISTORY|PRIVATE_VOICE|PRIVATE_KEY|PRIVATE_HIDDEN|USER 的选择/);
  assert.equal(result.saved.characterDrafts.items[0].future.note,' preserve exact fields ');
  assert.equal(result.saved.storyboardImages[0].snapshot.private,'PRIVATE_RECIPE');
  assert.deepEqual(await fs.readFile(f.file),before);assert.deepEqual(await fs.readdir(f.user),names);
  result.saved.characterDrafts.items[0].document.name='local edit';assert.deepEqual((await f.service.readGalleryState(f.req,f.request())).saved,f.saved);
});

test('optional absence is not an invented empty collection; null, malformed and wrong-owner drafts fail closed',async t=>{
  const f=await chatStateFixture(t),saved=structuredClone(f.saved);
  delete f.saved.characterDrafts;delete f.saved.storyboardCollections;await f.write();
  assert.deepEqual(Object.keys((await f.service.readGalleryState(f.req,f.request())).saved),['storyboardImages']);
  for(const patch of [{characterDrafts:null},{storyboardCollections:null},{characterDrafts:{...saved.characterDrafts,owner:{namespace:'st-user:bob',chatKey:f.target.chatId}}},
    {characterDrafts:{...saved.characterDrafts,owner:{namespace:'st-user:alice',chatKey:'other'}}}]){
    f.saved={storyboardImages:f.rows,...patch};await f.write();await reject(f.service.readGalleryState(f.req,f.request()),'state_content');
  }
  f.saved={storyboardImages:[],storyboardCollections:[]};f.rows.length=0;await f.write();assert.deepEqual((await f.service.readGalleryState(f.req,f.request())).saved,f.saved);
  delete f.saved.storyboardImages;await f.write();await reject(f.service.readGalleryState(f.req,f.request()),'record_missing');
});

test('scope is authenticated exact file identity and full gallery digest, no paths or uploaded snapshots',async t=>{
  const f=await chatStateFixture(t);
  for(const patch of [{path:f.file},{saved:f.saved},{target:{kind:'group',chatId:'../chat'}},{gallerySha256:'short'}])assert.throws(()=>chatGalleryStateRequest({...f.request(),...patch}));
  await reject(f.service.readGalleryState({},f.request()),'account');
  await reject(f.service.readGalleryState(f.req,{...f.request(),expectedAccount:'st-user:'+sha('bob')}),'account');
  await reject(f.service.readGalleryState(f.req,{...f.request(),gallerySha256:'0'.repeat(64)}),'record_changed');
  const group=path.join(f.groups,'chat-one.jsonl');await fs.writeFile(group,JSON.stringify({chat_metadata:{story_director_liminale:{storyboardImages:f.rows,storyboardCollections:[{id:'group',name:'群聊'}]}}})+'\n');
  const result=await f.service.readGalleryState(f.req,{...f.request(),target:{kind:'group',chatId:'chat-one'}});assert.equal(result.saved.storyboardCollections[0].id,'group');
});

test('known structured credentials, encoded workflow credentials and authenticated URLs are never returned or redacted',async t=>{
  const f=await chatStateFixture(t),base=structuredClone(f.rows[0]);
  for(const patch of [{apiKey:'SECRET'},{future:{headers:{Authorization:'SECRET'}}},{workflow:'{"node":{"inputs":{"api_key":"SECRET"}}}'},{baseUrl:'https://user:SECRET@example.invalid'}]){
    f.rows[0]={...base,...patch};await f.write();await reject(f.service.readGalleryState(f.req,f.request()),'state_content');
    assert.match(await fs.readFile(f.file,'utf8'),/SECRET/);
  }
});

test('strict header parsing refuses duplicate escaped keys, unsafe fields, oversized headers and invalid UTF8',async t=>{
  const f=await chatStateFixture(t),header=JSON.stringify(f.header());
  for(const raw of [header.replace('"storyboardImages":','"storyboardImages":[],"storyboard\\u0049mages":'),header.replace('"chat_metadata":','"__proto__":{},"chat_metadata":'),Buffer.from([0xff,10])]){
    await fs.writeFile(f.file,raw);await reject(f.service.readGalleryState(f.req,f.request()),'content');
  }
  await fs.writeFile(f.file,' '.repeat(CHAT_GALLERY_STATE_LIMITS.bytes+1)+'\n');await reject(f.service.readGalleryState(f.req,f.request()),'size');
});

test('reads only the bounded first line; BOM/CRLF header fingerprint differs without altering saved data',async t=>{
  const f=await chatStateFixture(t),plain=await f.service.readGalleryState(f.req,f.request());
  await fs.writeFile(f.file,Buffer.concat([Buffer.from('\uFEFF'+JSON.stringify(f.header())+'\r\n'),Buffer.from([0xff,0xfe])]));
  const bom=await f.service.readGalleryState(f.req,f.request());assert.deepEqual(bom.saved,plain.saved);assert.equal(bom.sha256,plain.sha256);assert.notEqual(bom.source.sha256,plain.source.sha256);
  const {gallerySha256,...receipt}=f.request();assert.equal((await f.service.inspectGallery(f.req,receipt)).gallery.sha256,gallerySha256);
  await reject(f.service.readGalleryEvidence(f.req,f.request()),'content');
});

test('links, missing file and a changed file/account during read are rejected and handles closed',async t=>{
  const f=await chatStateFixture(t);await fs.link(f.file,f.file+'.hard');await reject(f.service.readGalleryState(f.req,f.request()),'path');await fs.unlink(f.file+'.hard');
  await fs.rename(f.file,f.file+'.old');await reject(f.service.readGalleryState(f.req,f.request()),'missing');
  for(const mode of ['file','account','abort']){
    let x,closed=0;const controller=new AbortController();
    x=await chatStateFixture(t,{io:{...fs,async open(...args){const h=await fs.open(...args);return {stat:o=>h.stat(o),close:async()=>{closed++;await h.close();},read:async(...a)=>{
      const result=await h.read(...a);if(mode==='file')await fs.appendFile(x.file,' ');else if(mode==='account')x.req.user.profile.handle='bob';else controller.abort();return result;}};}}});
    await reject(x.service.readGalleryState(x.req,x.request(),{signal:controller.signal}),'changed');assert.equal(closed,1);
  }
});

test('a file edit after validation begins is caught by the final file observation',async t=>{
  let f,calls=0;
  f=await chatStateFixture(t,{io:{...fs,async lstat(file,options){if(file===f?.file&&++calls===3)await fs.appendFile(file,'\n');return fs.lstat(file,options);}}});
  await reject(f.service.readGalleryState(f.req,f.request()),'changed');assert.equal(calls,3);
});

test('server read shares the four-request bound and shutdown discards pending sources',async t=>{
  const entered=gate(),waiting=gate();let reads=0,closed=0;
  const f=await chatStateFixture(t,{io:{...fs,async open(...args){const h=await fs.open(...args);return {stat:o=>h.stat(o),close:async()=>{closed++;await h.close();},async read(...a){if(++reads===4)entered.release();await waiting.promise;return h.read(...a);}};}}});
  const pending=Array.from({length:4},()=>reject(f.service.readGalleryState(f.req,f.request()),'changed'));await entered.promise;
  await reject(f.service.readGalleryState(f.req,f.request()),'busy');const end=f.service.close();waiting.release();await Promise.all([...pending,end]);assert.equal(closed,4);
});

test('client sends exact selectors and CSRF only, with bounded same-origin requests and detached originals',async t=>{
  const f=await chatStateFixture(t);let sent;
  const c=client(f,{headers:()=>({'X-CSRF-Token':'fixture',Authorization:'SECRET'}),fetchImpl:(url,options)=>{sent={url,...options};return f.fetch(url,options);}});t.after(()=>c.close());
  const result=await c.read(f.request().gallerySha256);assert.deepEqual(result.saved,f.saved);assert.deepEqual(JSON.parse(sent.body),f.request());
  assert.equal(sent.url,'/api/plugins/qianmu-tts/chat-gallery/state');assert.equal(sent.credentials,'same-origin');assert.equal(sent.cache,'no-store');assert.equal(sent.redirect,'error');
  assert.deepEqual(sent.headers,{'Content-Type':'application/json',Accept:'application/json','X-CSRF-Token':'fixture'});
});

test('client validates all returned data, account, target, gallery and source type and rejects duplicate response keys',async t=>{
  const f=await chatStateFixture(t),value=await f.service.readGalleryState(f.req,f.request());
  for(const change of [{sha256:'0'.repeat(64)},{source:{...value.source,kind:'full-file'}},{saved:{...value.saved,imagegen:{}}},{saved:{...value.saved,storyboardImages:[]}},
    {source:{...value.source,bytes:CHAT_GALLERY_STATE_LIMITS.bytes+1}}])await assert.rejects(chatGalleryStateResponse({...value,...change},{namespace:'st-user:alice'}));
  await assert.rejects(chatGalleryStateResponse(value,{namespace:'st-user:bob'}));
  for(const change of [{target:{...value.target,avatar:'Other.png'}},{proof:'read-only-details'},{expectedAccount:'st-user:'+sha('bob')}]){
    const c=client(f,{fetchImpl:async()=>Response.json({...value,...change})});await reject(c.read(f.request().gallerySha256),'client');c.close();
  }
  const c=client(f,{fetchImpl:async()=>new Response(JSON.stringify(value).replace('"ok":true','"ok":false,"ok":true'),{headers:{'content-type':'application/json'}})});await reject(c.read(f.request().gallerySha256),'client');c.close();
});

test('old backend, oversized and truncated responses do not fall back to local or current state',async t=>{
  const f=await chatStateFixture(t);
  for(const response of [()=>new Response('old',{status:404}),()=>Response.json({ok:false},{status:404})]){
    const c=client(f,{fetchImpl:async()=>response()});await assert.rejects(c.read(f.request().gallerySha256),/更新千幕配套后端/);c.close();
  }
  for(const response of [()=>new Response('{}',{headers:{'content-type':'application/json','content-length':String(CHAT_GALLERY_STATE_LIMITS.responseBytes+1)}}),
    ()=>new Response('{',{headers:{'content-type':'application/json'}}),()=>new Response(new Uint8Array([0xff]),{headers:{'content-type':'application/json'}}),
    ()=>new Response(' '.repeat(CHAT_GALLERY_STATE_LIMITS.responseBytes+1),{headers:{'content-type':'application/json'}})]){
    const c=client(f,{fetchImpl:async()=>response()});await reject(c.read(f.request().gallerySha256),'client');c.close();
  }
});

test('timeouts cover stalled headers/body and late guards, closing or aborting does not publish a source',async t=>{
  const f=await chatStateFixture(t),waiting=gate();let calls=0,cancelled=false;
  const a=client(f,{timeoutMs:100,headers:()=>waiting.promise,fetchImpl:async()=>{calls++;return f.fetch();}});await reject(a.read(f.request().gallerySha256),'client');waiting.release({});await new Promise(done=>setTimeout(done,10));assert.equal(calls,0);a.close();
  const b=client(f,{timeoutMs:100,fetchImpl:async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}})});await reject(b.read(f.request().gallerySha256),'client');assert.equal(cancelled,true);b.close();
  let changed=false;const c=client(f,{guard:async()=>{if(changed)throw Error('changed');},fetchImpl:async(...args)=>{const result=await f.fetch(...args);changed=true;return result;}});await reject(c.read(f.request().gallerySha256),'client');c.close();await reject(c.read(f.request().gallerySha256),'client');
  const abort=new AbortController();abort.abort();const d=client(f);await reject(d.read(f.request().gallerySha256,{signal:abort.signal}),'client');d.close();
});

test('real plugin endpoint rejects anonymous requests and returns no-store/nosniff only within authenticated scope',async t=>{
  const f=await chatStateFixture(t),routes=new Map();await init({get:(p,h)=>routes.set(p,h),post:(p,h)=>routes.set(p,h)},{dataRoot:f.root});t.after(()=>exit());
  const server=http.createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);req.body=JSON.parse(Buffer.concat(chunks).toString());if(req.headers['x-fixture']==='alice')req.user=f.req.user;
    res.set=(k,v)=>{res.setHeader(k,v);return res;};res.status=c=>{res.statusCode=c;return res;};res.json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};await routes.get(req.url)(req,res);});
  await new Promise(done=>server.listen(0,'127.0.0.1',done));t.after(()=>new Promise(done=>server.close(done)));
  const call=(body=f.request(),auth=true)=>fetch('http://127.0.0.1:'+server.address().port+'/chat-gallery/state',{method:'POST',headers:{'Content-Type':'application/json',...(auth?{'x-fixture':'alice'}:{})},body:JSON.stringify(body)});
  assert.equal((await call(f.request(),false)).status,401);assert.equal((await call({...f.request(),saved:f.saved})).status,400);
  const reply=await call();assert.equal(reply.status,200);assert.equal(reply.headers.get('cache-control'),'no-store');assert.equal(reply.headers.get('x-content-type-options'),'nosniff');assert.deepEqual((await reply.json()).saved,f.saved);
});
