import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {chatStateFixture} from './helpers/chat-state-fixture.mjs';
import {sha} from './helpers/chat-evidence-fixture.mjs';
import {chatGalleryDigest} from '../qianmu-chat-gallery-digest.js';
import {createChatGalleryHeaderCapture} from '../qianmu-chat-gallery-header.js';
import {createChatGallerySupplementClient} from '../qianmu-chat-character-receipt-client.js';
import {chatGallerySupplementResponse,chatGallerySupplementDigest,CHAT_GALLERY_SUPPLEMENT_LIMITS as LIMIT} from '../qianmu-chat-gallery-supplement.js';
import {chatCharacterReceiptErrorPayload} from '../qianmu-chat-character-receipt.js';
import {init,exit} from '../server-plugin.js';

const failure=error=>String(error?.code).startsWith('chat_character_receipt_');
const gate=()=>{let release;const promise=new Promise(r=>{release=r;});return {promise,release};};
async function fixture(t,options){
  const f=await chatStateFixture(t,options),base=f.request();f.request=()=>({...base,gallerySha256:chatGalleryDigest(f.rows).sha256});
  f.fetch=async(url,options)=>{
    assert.equal(url,'/api/plugins/qianmu-tts/chat-gallery/supplement');
    try{return Response.json(await f.service.readGallerySupplement(f.req,JSON.parse(options.body),{signal:options.signal}));}
    catch(error){const result=chatCharacterReceiptErrorPayload(error);return Response.json(result.body,{status:result.status});}
  };
  f.client=options=>createChatGallerySupplementClient({namespace:'st-user:alice',target:f.target,fetchImpl:f.fetch,...options});return f;
}

test('large saved header returns exact supplements and original order, not another copy of image bodies',async t=>{
  const f=await fixture(t);f.rows.splice(0,f.rows.length,...[4,1,9,2,7,0].map(i=>({id:'frame-'+i,createdAt:i,prompt:'PRIVATE_PROMPT',payload:'x'.repeat(450000)})));
  const before=await f.write(),result=await f.service.readGallerySupplement(f.req,f.request());assert.ok(result.source.bytes>2*1048576);
  assert.deepEqual(result.order,f.rows.map(row=>row.id));assert.deepEqual(result.saved,{storyboardCollections:f.saved.storyboardCollections,characterDrafts:f.saved.characterDrafts});
  assert.deepEqual(result.gallery,chatGalleryDigest(f.rows));assert.equal(result.proof,'read-only-chat-supplement');
  assert.doesNotMatch(JSON.stringify(result),/storyboardImages|PRIVATE_PROMPT|PRIVATE_RECIPE|PRIVATE_HISTORY|PRIVATE_KEY|WRONG_GLOBAL/);
  assert.ok(Buffer.byteLength(JSON.stringify(result))<10000);assert.deepEqual(await fs.readFile(f.file),before);
  const client=f.client();t.after(()=>client.close());assert.deepEqual(await client.read(f.request().gallerySha256),result);
});

test('missing fields, empty collections and unknown nested draft fields remain distinct and lossless',async t=>{
  const f=await fixture(t);f.saved.storyboardCollections[0].future={zero:0,flag:false,empty:'',nested:['🌸',null],sameName:{characterDrafts:'not a root field'}};await f.write();
  const full=await f.service.readGallerySupplement(f.req,f.request());assert.deepEqual(full.saved.storyboardCollections,f.saved.storyboardCollections);
  assert.deepEqual(full.saved.characterDrafts,f.saved.characterDrafts);
  delete f.saved.characterDrafts;f.saved.storyboardCollections=[];await f.write();const empty=await f.service.readGallerySupplement(f.req,f.request());assert.deepEqual(empty.saved,{storyboardCollections:[]});
  delete f.saved.storyboardCollections;await f.write();const missing=await f.service.readGallerySupplement(f.req,f.request());assert.deepEqual(missing.saved,{});assert.notEqual(missing.sha256,empty.sha256);
});

test('supplement changes create a distinct digest even when gallery content is identical',async t=>{
  const f=await fixture(t),first=await f.service.readGallerySupplement(f.req,f.request());f.saved.storyboardCollections[0].name='new name';await f.write();
  const second=await f.service.readGallerySupplement(f.req,f.request());assert.equal(first.gallery.sha256,second.gallery.sha256);assert.notEqual(first.sha256,second.sha256);
  assert.notEqual(first.source.sha256,second.source.sha256);assert.equal(second.sha256,await chatGallerySupplementDigest(second.order,second.saved));
});

test('BOM and CRLF belong to exact source bytes but do not change decoded supplements',async t=>{
  const f=await fixture(t),plain=await f.service.readGallerySupplement(f.req,f.request()),raw=await f.write({bom:'\uFEFF',newline:'\r\n'});
  const result=await f.service.readGallerySupplement(f.req,f.request()),header=raw.subarray(0,raw.indexOf(10));
  assert.equal(result.source.bytes,header.length);assert.equal(result.source.sha256,sha(header));assert.equal(result.sha256,plain.sha256);assert.notEqual(result.source.sha256,plain.source.sha256);
});

test('one-character parser chunks capture either field order without collecting similarly named foreign fields',async t=>{
  const f=await fixture(t),store={characterDrafts:f.saved.characterDrafts,storyboardImages:f.rows,storyboardCollections:f.saved.storyboardCollections};
  const text=JSON.stringify({other:{storyboardCollections:[{private:true}]},chat_metadata:{story_director_liminale:store,characterDrafts:{private:true}}});
  const capture=createChatGalleryHeaderCapture({supplement:true});for(const char of text)capture.write(char);const result=capture.finish();
  assert.deepEqual(result.saved,{characterDrafts:store.characterDrafts,storyboardCollections:store.storyboardCollections});assert.deepEqual(result.order,['image']);assert.deepEqual(result.records,[]);
  assert.deepEqual(result.gallery,chatGalleryDigest(f.rows));
});

test('supplement parsing rejects duplicate IDs, malformed selected fields, hidden tails and partial objects',async t=>{
  const f=await fixture(t);for(const patch of [{storyboardCollections:null},{storyboardCollections:{}},{characterDrafts:[]},{characterDrafts:null}]){
    const saved={...f.saved,...patch};await f.write({header:{chat_metadata:{story_director_liminale:saved}}});await assert.rejects(f.service.readGallerySupplement(f.req,f.request()),failure);
  }
  const original=f.header();for(const suffix of [',"bad":tru}',',"bad":{"a":1,"a":2}}',',"bad":"\\z"}',',"bad":'] ){
    await fs.writeFile(f.file,JSON.stringify(original).slice(0,-1)+suffix+'\n');await assert.rejects(f.service.readGallerySupplement(f.req,f.request()),failure);
  }
  f.rows.push({...f.rows[0]});await f.write();await assert.rejects(f.service.readGallerySupplement(f.req,f.request()),failure);
});

test('wrong owner, embedded credentials and oversized companion fields reject without sanitizing originals',async t=>{
  const f=await fixture(t),original=structuredClone(f.saved);
  for(const patch of [value=>value.characterDrafts.owner.namespace='st-user:bob',value=>value.storyboardCollections[0].apiKey='SECRET',
    value=>value.storyboardCollections[0].padding='x'.repeat(LIMIT.bytes+1)]){
    const saved=structuredClone(original);patch(saved);const raw=await f.write({header:{chat_metadata:{story_director_liminale:saved}}});
    await assert.rejects(f.service.readGallerySupplement(f.req,f.request()),failure);assert.deepEqual(await fs.readFile(f.file),raw);
  }
});

test('10k existing long Unicode IDs fit the separate ordering response budget',async t=>{
  const f=await fixture(t);f.rows.splice(0,f.rows.length,...Array.from({length:10000},(_,i)=>({id:'字'.repeat(234)+'-'+String(i).padStart(5,'0'),createdAt:i})));
  f.saved={storyboardImages:f.rows};await f.write();const client=f.client();t.after(()=>client.close());const result=await client.read(f.request().gallerySha256);
  assert.equal(result.order.length,10000);assert.deepEqual(result.order,f.rows.map(row=>row.id));assert.ok(Buffer.byteLength(JSON.stringify(result))<LIMIT.responseBytes);
  assert.deepEqual(result.saved,{});assert.ok(result.gallery.bytes>2*1048576);
});

test('absent and empty gallery differ, and supplements never synthesize a missing gallery',async t=>{
  const f=await fixture(t);f.rows.splice(0);await f.write();const empty=await f.service.readGallerySupplement(f.req,f.request());assert.deepEqual(empty.order,[]);assert.equal(empty.gallery.count,0);
  delete f.saved.storyboardImages;await f.write();await assert.rejects(f.service.readGallerySupplement(f.req,f.request()),error=>error.code==='chat_character_receipt_record_missing');
});

test('strict request identity, source hash and group-chat mapping protect the new reader',async t=>{
  const f=await fixture(t);for(const [req,body] of [[{},f.request()],[f.req,{...f.request(),expectedAccount:'st-user:'+sha('bob')}],
    [f.req,{...f.request(),gallerySha256:'0'.repeat(64)}],[f.req,{...f.request(),file:f.file}],[f.req,{...f.request(),saved:{}}]])
    await assert.rejects(f.service.readGallerySupplement(req,body),failure);
  await fs.writeFile(path.join(f.groups,'chat-one.jsonl'),await fs.readFile(f.file));const result=await f.service.readGallerySupplement(f.req,{...f.request(),target:{kind:'group',chatId:'chat-one'}});
  assert.equal(result.target.kind,'group');assert.deepEqual(result.order,['image']);
});

test('new reader stops at the header and does not parse or return malformed private body data',async t=>{
  let positions=[];const f=await fixture(t,{io:{...fs,open:async(...args)=>{const h=await fs.open(...args);return {stat:x=>h.stat(x),read:async(buffer,offset,length,position)=>{
    positions.push(position);return h.read(buffer,offset,length,position);},close:()=>h.close()};}}});
  const header=JSON.stringify(f.header());await fs.writeFile(f.file,header+'\n'+('PRIVATE_BODY '.repeat(300000))+'{bad');
  const result=await f.service.readGallerySupplement(f.req,f.request());assert.deepEqual(positions,[0]);assert.equal(result.source.bytes,Buffer.byteLength(header));assert.doesNotMatch(JSON.stringify(result),/PRIVATE_BODY/);
});

test('late file replacement, account change and cancellation cannot confirm captured supplements',async t=>{
  for(const mode of ['file','account','abort']){
    let f,closed=0;const controller=new AbortController();
    f=await fixture(t,{io:{...fs,open:async(...args)=>{const h=await fs.open(...args);return {stat:x=>h.stat(x),read:(...parts)=>h.read(...parts),close:async()=>{
      await h.close();closed++;if(mode==='file')await fs.appendFile(f.file,' ');if(mode==='account')f.req.user.profile.handle='bob';if(mode==='abort')controller.abort();
    }};}}});
    await assert.rejects(f.service.readGallerySupplement(f.req,f.request(),{signal:controller.signal}),failure);assert.equal(closed,1);
  }
});

test('supplement capture rejects hardlinks before content access',async t=>{
  const f=await fixture(t);await fs.link(f.file,f.file+'.other');await assert.rejects(f.service.readGallerySupplement(f.req,f.request()),error=>error.code==='chat_character_receipt_path');
});

test('pending slot is retained until cancelled late file handles close',{timeout:10000},async t=>{
  const wait=gate(),entered=gate();let closed=0,opened=0;t.signal.addEventListener('abort',wait.release,{once:true});
  const f=await fixture(t,{io:{...fs,open:async(...args)=>{const h=await fs.open(...args);if(++opened===4)entered.release();await wait.promise;return {stat:x=>h.stat(x),read:(...parts)=>h.read(...parts),close:async()=>{closed++;await h.close();}};}}});
  const pending=Array.from({length:4},()=>assert.rejects(f.service.readGallerySupplement(f.req,f.request()),failure));await entered.promise;
  await assert.rejects(f.service.readGallerySupplement(f.req,f.request()),error=>error.code==='chat_character_receipt_busy');const closing=f.service.close();wait.release();await Promise.all([...pending,closing]);assert.equal(closed,4);
});

test('client sends only source selectors and refuses altered order, account, digest or source responses',async t=>{
  const f=await fixture(t),value=await f.service.readGallerySupplement(f.req,f.request());let sent;
  const good=f.client({headers:()=>({'X-CSRF-Token':'fixture','Authorization':'SECRET'}),fetchImpl:async(url,options)=>{sent={url,...options};return f.fetch(url,options);}});t.after(()=>good.close());
  await good.read(f.request().gallerySha256);assert.equal(sent.credentials,'same-origin');assert.equal(sent.headers.Authorization,undefined);assert.equal(sent.headers['X-CSRF-Token'],'fixture');
  assert.deepEqual(Object.keys(JSON.parse(sent.body)).sort(),['expectedAccount','gallerySha256','target','version']);
  for(const patch of [v=>v.order.push('extra'),v=>v.order[0]='changed',v=>v.gallery.sha256='0'.repeat(64),v=>v.expectedAccount='st-user:'+sha('bob'),
    v=>v.source.bytes=LIMIT.headerBytes+1,v=>v.proof='saved',v=>v.saved.storyboardCollections[0].name='changed',v=>v.saved.storyboardImages=[]]){
    const bad=structuredClone(value);patch(bad);const client=f.client({fetchImpl:async()=>Response.json(bad)});await assert.rejects(client.read(f.request().gallerySha256),failure);client.close();
  }
  assert.deepEqual(await chatGallerySupplementResponse(value,{namespace:'st-user:alice'}),value);
});

test('old backend is explicit and never falls back to full-state reads or retries',async t=>{
  const f=await fixture(t);let calls=0;const client=f.client({fetchImpl:async url=>{calls++;assert.ok(url.endsWith('/supplement'));return new Response('old',{status:404});}});t.after(()=>client.close());
  await assert.rejects(client.read(f.request().gallerySha256),/更新千幕配套后端/);assert.equal(calls,1);
});

test('valid-looking redirect responses cannot lend another endpoint authority',async t=>{
  const f=await fixture(t),value=await f.service.readGallerySupplement(f.req,f.request());
  for(const status of [200,302]){
    const response=Response.json(value,{status});if(status===200)Object.defineProperty(response,'redirected',{value:true});
    const client=f.client({fetchImpl:async()=>response});await assert.rejects(client.read(f.request().gallerySha256),/跳转/);client.close();
  }
});

test('duplicate returned keys, malformed UTF8 and oversized declared responses are not accepted as supplements',async t=>{
  const f=await fixture(t),value=await f.service.readGallerySupplement(f.req,f.request()),json=JSON.stringify(value);
  for(const response of [new Response(json.slice(0,-1)+',"order":["image"]}',{headers:{'content-type':'application/json'}}),
    new Response(new Uint8Array([0xff,0xfe]),{headers:{'content-type':'application/json'}}),
    new Response(json,{headers:{'content-type':'application/json','content-length':String(LIMIT.responseBytes+1)}})]){
    const client=f.client({fetchImpl:async()=>response});await assert.rejects(client.read(f.request().gallerySha256),failure);client.close();
  }
});

test('client deadlines cover stalled headers and bodies, and late scope changes discard results',async t=>{
  const f=await fixture(t),wait=gate();let calls=0,cancelled=false;
  const a=f.client({timeoutMs:100,headers:()=>wait.promise,fetchImpl:async()=>{calls++;}});await assert.rejects(a.read(f.request().gallerySha256),failure);wait.release({});await new Promise(r=>setTimeout(r,10));assert.equal(calls,0);a.close();
  const b=f.client({timeoutMs:100,fetchImpl:async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}})});
  await assert.rejects(b.read(f.request().gallerySha256),failure);assert.equal(cancelled,true);b.close();
  let changed=false;const c=f.client({guard:async()=>{if(changed)throw Error('private');},fetchImpl:async(...args)=>{const result=await f.fetch(...args);changed=true;return result;}});
  await assert.rejects(c.read(f.request().gallerySha256),failure);c.close();
});

test('actual authenticated plugin route returns source-bound supplements and no-store responses',async t=>{
  const f=await fixture(t),routes=new Map();await init({get:(p,h)=>routes.set(p,h),post:(p,h)=>routes.set(p,h)},{dataRoot:f.root});t.after(()=>exit());
  const server=http.createServer(async(req,res)=>{try{const parts=[];for await(const part of req)parts.push(part);req.body=JSON.parse(Buffer.concat(parts).toString());
    if(req.headers['x-fixture']==='alice')req.user=f.req.user;res.set=(k,v)=>{res.setHeader(k,v);return res;};res.status=c=>{res.statusCode=c;return res;};res.json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};await routes.get(req.url)(req,res);
  }catch{res.statusCode=500;res.end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const call=(body=f.request(),auth=true)=>fetch('http://127.0.0.1:'+server.address().port+'/chat-gallery/supplement',{method:'POST',headers:{'Content-Type':'application/json',...(auth?{'x-fixture':'alice'}:{})},body:JSON.stringify(body)});
  assert.equal((await call(f.request(),false)).status,401);assert.equal((await call({...f.request(),path:f.file})).status,400);
  const response=await call();assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  assert.deepEqual((await response.json()).saved,{storyboardCollections:f.saved.storyboardCollections,characterDrafts:f.saved.characterDrafts});
});
