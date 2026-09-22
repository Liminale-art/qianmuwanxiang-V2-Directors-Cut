import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import http from 'node:http';
import {chatEvidenceFixture,sha} from './helpers/chat-evidence-fixture.mjs';
import {chatGalleryDigest} from '../qianmu-chat-gallery-digest.js';
import {CHAT_GALLERY_HEADER_LIMITS} from '../qianmu-chat-gallery-header.js';
import {CHAT_GALLERY_EVIDENCE_LIMITS as LIMIT,chatGalleryEvidenceSourceResponse,chatGalleryEvidenceResponse} from '../qianmu-chat-gallery-evidence.js';
import {createChatGalleryEvidenceSourceClient} from '../qianmu-chat-character-receipt-client.js';
import {chatCharacterReceiptErrorPayload} from '../qianmu-chat-character-receipt.js';
import {captureStoryboardChatEvidence} from '../qianmu-storyboard-chat-evidence.js';
import {vibeDigest} from '../qianmu-vibe-file.js';
import {init,exit} from '../server-plugin.js';

const reject=(pending,code)=>assert.rejects(pending,{code:'chat_character_receipt_'+code});
const gate=()=>{let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve};};
async function fixture(t,options){
  const f=await chatEvidenceFixture(t,options),base=f.request();f.request=()=>({...base,gallerySha256:chatGalleryDigest(f.rows).sha256});
  f.fetch=async(url,options)=>{
    assert.equal(url,'/api/plugins/qianmu-tts/chat-gallery/evidence-source');
    try{return Response.json(await f.service.readGalleryEvidenceSource(f.req,JSON.parse(options.body),{signal:options.signal}));}
    catch(error){const result=chatCharacterReceiptErrorPayload(error);return Response.json(result.body,{status:result.status});}
  };
  f.client=options=>createChatGalleryEvidenceSourceClient({namespace:'st-user:alice',target:f.target,fetchImpl:f.fetch,...options});return f;
}

test('large gallery header streams through both evidence endpoints with one bounded sequential file scan',async t=>{
  const reads=[];let opens=0,closes=0;
  const f=await fixture(t,{io:{...fs,async open(...args){opens++;const h=await fs.open(...args);return {stat:o=>h.stat(o),async read(b,o,l,p){assert.ok(l<=65536);const result=await h.read(b,o,Math.min(l,8191),p);reads.push({at:p,bytes:result.bytesRead});return result;},async close(){closes++;await h.close();}};}}});
  f.rows.splice(0,f.rows.length,...Array.from({length:6},(_,i)=>({id:'r'+i,createdAt:i,private:'x'.repeat(450000)})));const raw=await f.write();assert.ok(raw.indexOf(10)>2*1048576);
  const result=await f.service.readGalleryEvidenceSource(f.req,f.request());assert.equal(opens,1);assert.equal(closes,1);assert.equal(reads[0].at,0);
  for(let i=1;i<reads.length;i++)assert.equal(reads[i].at,reads[i-1].at+reads[i-1].bytes,'no second header scan or out-of-order reread');
  assert.equal(result.source.sha256,sha(raw));assert.equal(result.header.sha256,sha(raw.subarray(0,raw.indexOf(10))));assert.equal(result.header.bytes,raw.indexOf(10));
  assert.deepEqual(result.chatEvidence,await captureStoryboardChatEvidence(f.messages,f.target.chatId));assert.ok(JSON.stringify(result).length<2000);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_|private|mes"/);
  const legacy=await f.service.readGalleryEvidence(f.req,f.request()),{header,...withoutHeader}=result;assert.deepEqual(legacy,withoutHeader);assert.deepEqual(await chatGalleryEvidenceResponse(legacy),legacy);
  assert.deepEqual(await fs.readFile(f.file),raw);
});

test('large unrelated header fields are validated without entering the response or changing narrative evidence',async t=>{
  const f=await fixture(t),base=await f.service.readGalleryEvidenceSource(f.req,f.request());const header=f.header();header.chat_metadata.otherPlugin={text:'x'.repeat(3*1048576)};await f.write({header});
  const result=await f.service.readGalleryEvidenceSource(f.req,f.request());assert.deepEqual(result.chatEvidence,base.chatEvidence);assert.notEqual(result.header.sha256,base.header.sha256);assert.equal(result.gallerySha256,base.gallerySha256);assert.ok(JSON.stringify(result).length<2000);
});

test('header evidence matches supplement source including BOM and CRLF across fragmented UTF8',async t=>{
  const f=await fixture(t,{io:{...fs,async open(...args){const h=await fs.open(...args);return {stat:o=>h.stat(o),read:(b,o,l,p)=>h.read(b,o,Math.min(l,3),p),close:()=>h.close()};}}});
  const raw=await f.write({bom:'\uFEFF',newline:'\r\n',trailing:false});
  const result=await f.service.readGalleryEvidenceSource(f.req,f.request()),companion=await f.service.readGallerySupplement(f.req,f.request());
  assert.deepEqual(result.header,{bytes:companion.source.bytes,sha256:companion.source.sha256});assert.equal(result.source.sha256,sha(raw));assert.deepEqual(result.chatEvidence,await captureStoryboardChatEvidence(f.messages,f.target.chatId));
});

test('body and metadata changes alter the right identities without conflating snapshots',async t=>{
  const f=await fixture(t),first=await f.service.readGalleryEvidenceSource(f.req,f.request());await f.write({body:[...f.messages,{mes:'new body'}]});
  const body=await f.service.readGalleryEvidenceSource(f.req,f.request());assert.deepEqual(body.header,first.header);assert.notEqual(body.source.sha256,first.source.sha256);assert.notEqual(body.chatEvidence.digest,first.chatEvidence.digest);
  const header=f.header();header.chat_metadata.story_director_liminale.storyboardCollections=[{id:'collection',name:'new'}];await f.write({header,body:[...f.messages,{mes:'new body'}]});
  const metadata=await f.service.readGalleryEvidenceSource(f.req,f.request());assert.notEqual(metadata.header.sha256,body.header.sha256);assert.deepEqual(metadata.chatEvidence,body.chatEvidence);assert.equal(metadata.gallerySha256,body.gallerySha256);
});

test('duplicate keys and malformed skipped header tails never silently choose one gallery or body',async t=>{
  const f=await fixture(t),header=JSON.stringify(f.header()),body=JSON.stringify(f.messages[0]);
  for(const text of [header.replace('"chat_metadata":','"chat_metadata":{},"chat_metadata":')+'\n'+body+'\n',
    header.slice(0,-1)+',"skipped":"'+ 'x'.repeat(2100000)+'","bad":[1,]}\n'+body+'\n',
    header+'\n{"mes":"first","mes":"second"}\n',header+'\n{"mes":"fine","extra":{"same":1,"same":2}}\n']){
    await fs.writeFile(f.file,text);await reject(f.service.readGalleryEvidenceSource(f.req,f.request()),'content');assert.equal(await fs.readFile(f.file,'utf8'),text);
  }
});

test('header changes after capture during handle close cannot escape the final file and account checks',async t=>{
  for(const mode of ['file','account','abort']){
    const controller=new AbortController();let f,closes=0;
    f=await fixture(t,{io:{...fs,async open(...args){const h=await fs.open(...args);return {stat:o=>h.stat(o),read:(...a)=>h.read(...a),async close(){await h.close();closes++;
      if(mode==='file')await fs.appendFile(f.file,'{}\n');else if(mode==='account')f.req.user.profile.handle='bob';else controller.abort();}};}}});
    await reject(f.service.readGalleryEvidenceSource(f.req,f.request(),{signal:controller.signal}),'changed');assert.equal(closes,1);
  }
});

test('no-newline header, empty gallery and empty body remain explicit valid evidence',async t=>{
  const f=await fixture(t);f.rows.length=0;const raw=await f.write({body:[],trailing:false}),result=await f.service.readGalleryEvidenceSource(f.req,f.request());
  assert.equal(result.header.bytes,raw.length);assert.deepEqual(result.header,result.source);assert.deepEqual(result.chatEvidence.messages,[]);
  await f.write({header:{chat_metadata:{}},body:[]});await reject(f.service.readGalleryEvidenceSource(f.req,f.request()),'record_missing');
});

test('existing body/file/message protections are unchanged while header uses the established stream budget',async t=>{
  assert.equal(LIMIT.headerBytes,CHAT_GALLERY_HEADER_LIMITS.bytes);assert.equal(LIMIT.lineBytes,2*1048576);assert.equal(LIMIT.fileBytes,128*1048576);assert.equal(LIMIT.messages,100000);assert.equal(LIMIT.durationMs,30000);
  const f=await fixture(t);f.rows.splice(0,1,...Array.from({length:6},(_,i)=>({id:'r'+i,createdAt:i,text:'x'.repeat(400000)})));
  const raw=await f.write({body:[{mes:'x'.repeat(LIMIT.lineBytes)}]});await reject(f.service.readGalleryEvidenceSource(f.req,f.request()),'evidence_size');assert.deepEqual(await fs.readFile(f.file),raw);
});

test('new source client sends only exact selectors and CSRF and accepts no fallback to the old response',async t=>{
  const f=await fixture(t),calls=[],client=f.client({headers:()=>({'X-CSRF-Token':'fixture','Authorization':'private'}),fetchImpl:(url,options)=>{calls.push({url,...options});return f.fetch(url,options);}});t.after(()=>client.close());
  const result=await client.read(f.request().gallerySha256);assert.deepEqual(await chatGalleryEvidenceSourceResponse(result),result);assert.equal(calls.length,1);
  assert.deepEqual(JSON.parse(calls[0].body),f.request());assert.deepEqual(calls[0].headers,{'Content-Type':'application/json',Accept:'application/json','X-CSRF-Token':'fixture'});assert.equal(calls[0].redirect,'error');
  for(const reply of [new Response('old',{status:404}),Response.json(await f.service.readGalleryEvidence(f.req,f.request()))]){
    let requests=0;const old=f.client({fetchImpl:async()=>{requests++;return reply;}});t.after(()=>old.close());await assert.rejects(old.read(f.request().gallerySha256));assert.equal(requests,1);
  }
});

test('source response rejects invalid header, raw fields and mismatched owner or gallery',async t=>{
  const f=await fixture(t),valid=await f.service.readGalleryEvidenceSource(f.req,f.request());
  for(const change of [{header:{...valid.header,bytes:0}},{header:{...valid.header,bytes:LIMIT.headerBytes+1}},{header:{...valid.header,bytes:valid.source.bytes+1}},
    {header:{...valid.header,sha256:'x'}},{header:{...valid.header,raw:'PRIVATE'}},{body:'PRIVATE'},
    {target:{...valid.target,avatar:'Other.png'}},{expectedAccount:'st-user:'+sha('bob')},{gallerySha256:'0'.repeat(64)}]){
    const bad=f.client({fetchImpl:async()=>Response.json({...valid,...change})});t.after(()=>bad.close());await assert.rejects(bad.read(f.request().gallerySha256));
  }
});

test('client rejects duplicate returned JSON keys, invalid UTF8 and redirects without adopting a valid-looking body',async t=>{
  const f=await fixture(t),valid=await f.service.readGalleryEvidenceSource(f.req,f.request());
  for(const reply of [new Response(JSON.stringify(valid).replace('"header":','"header":{},"header":'),{headers:{'content-type':'application/json'}}),
    new Response(new Uint8Array([0xff]),{headers:{'content-type':'application/json'}}),new Response(JSON.stringify(valid),{status:302,headers:{'content-type':'application/json'}})]){
    const c=f.client({fetchImpl:async()=>reply});t.after(()=>c.close());await assert.rejects(c.read(f.request().gallerySha256));
  }
});

test('client accepts the full supported 100000-row evidence contract without reducing its node budget',async t=>{
  const f=await fixture(t),valid=await f.service.readGalleryEvidenceSource(f.req,f.request());
  // Synthetic wire-boundary check only, not fabricated proof of an actual chat.
  const core={schema:valid.chatEvidence.schema,chatKey:valid.chatEvidence.chatKey,messages:Array.from({length:LIMIT.messages},(_,floor)=>({floor,sha256:'a'.repeat(64),messageHash:'b'.repeat(8),revisionHash:'c'.repeat(8),swipeId:0}))};
  const value={...valid,chatEvidence:{...core,digest:await vibeDigest(JSON.stringify(core))},source:{bytes:4*1048576,sha256:'d'.repeat(64)}};
  const c=f.client({fetchImpl:async()=>Response.json(value)});t.after(()=>c.close());assert.equal((await c.read(f.request().gallerySha256)).chatEvidence.messages.length,LIMIT.messages);
});

test('source client cancellation covers stalled headers and body, discarding late guard results',async t=>{
  const f=await fixture(t);let discarded=false;
  const body=f.client({timeoutMs:100,fetchImpl:async()=>new Response(new ReadableStream({cancel(){discarded=true;}}),{headers:{'content-type':'application/json'}})});t.after(()=>body.close());
  await assert.rejects(body.read(f.request().gallerySha256));assert.equal(discarded,true);
  const held=gate(),headers=f.client({timeoutMs:100,fetchImpl:()=>held.promise});t.after(()=>headers.close());await assert.rejects(headers.read(f.request().gallerySha256));held.resolve(Response.json({}));
  let changed=false;const guard=f.client({guard:async()=>{if(changed)throw Error('changed');},fetchImpl:async(...args)=>{const reply=await f.fetch(...args);changed=true;return reply;}});t.after(()=>guard.close());await assert.rejects(guard.read(f.request().gallerySha256));
});

test('actual source endpoint authenticates and exposes only no-store header and body digests',async t=>{
  const f=await fixture(t),routes=new Map();await init({get:(p,h)=>routes.set(p,h),post:(p,h)=>routes.set(p,h)},{dataRoot:f.root});t.after(()=>exit());
  const server=http.createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);req.body=JSON.parse(Buffer.concat(chunks).toString());if(req.headers['x-fixture']==='alice')req.user=f.req.user;
    res.set=(k,v)=>{res.setHeader(k,v);return res;};res.status=c=>{res.statusCode=c;return res;};res.json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};await routes.get(req.url)(req,res);});
  await new Promise(done=>server.listen(0,'127.0.0.1',done));t.after(()=>new Promise(done=>server.close(done)));
  const call=(body=f.request(),auth=true)=>fetch('http://127.0.0.1:'+server.address().port+'/chat-gallery/evidence-source',{method:'POST',headers:{'Content-Type':'application/json',...(auth?{'x-fixture':'alice'}:{})},body:JSON.stringify(body)});
  assert.equal((await call(f.request(),false)).status,401);assert.equal((await call({...f.request(),raw:'PRIVATE'})).status,400);
  const reply=await call();assert.equal(reply.status,200);assert.equal(reply.headers.get('cache-control'),'no-store');assert.equal(reply.headers.get('x-content-type-options'),'nosniff');
  const value=await reply.json();await chatGalleryEvidenceSourceResponse(value);assert.doesNotMatch(JSON.stringify(value),/PRIVATE_|正文|swipes/);
});
