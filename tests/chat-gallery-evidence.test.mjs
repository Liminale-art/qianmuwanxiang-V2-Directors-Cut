import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {chatEvidenceFixture,sha} from './helpers/chat-evidence-fixture.mjs';
import {createStoryboardChatEvidenceCapture,captureStoryboardChatEvidence,inspectStoryboardChatEvidence,createStoryboardEvidenceLinkResolver} from '../qianmu-storyboard-chat-evidence.js';
import {chatGalleryEvidenceRequest,chatGalleryEvidenceResponse,CHAT_GALLERY_EVIDENCE_LIMITS as LIMIT} from '../qianmu-chat-gallery-evidence.js';
import {createChatGalleryEvidenceClient} from '../qianmu-chat-character-receipt-client.js';
import {fixture as bundleFixture} from './fixtures/storyboard-bundle.mjs';
import {openStoryboardBundle} from '../qianmu-storyboard-bundle.js';
import {init,exit} from '../server-plugin.js';
const gate=()=>{let release;return {promise:new Promise(done=>release=done),release:value=>release(value)};};
const reject=(promise,code)=>assert.rejects(promise,{code:'chat_character_receipt_'+code});
const client=(f,options={})=>createChatGalleryEvidenceClient({namespace:'st-user:alice',target:f.target,fetchImpl:f.fetch,...options});

test('streaming capture is byte-compatible with existing v1 evidence and cannot finish after a failed message',async()=>{
  const messages=[{mes:'first',is_user:true},{mes:'🌸'.repeat(10000),swipe_id:2},{mes:'last',name:'a'}];
  const stream=createStoryboardChatEvidenceCapture('chat');for(const row of messages)await stream.append(row);
  const result=await stream.finish();assert.deepEqual(result,await captureStoryboardChatEvidence(messages,'chat'));await assert.rejects(stream.finish());
  const broken=createStoryboardChatEvidenceCapture('chat');await broken.append(messages[0]);await assert.rejects(broken.append({mes:{}}));await assert.rejects(broken.finish());
  const waiting=gate(),busy=createStoryboardChatEvidenceCapture('chat',{guard:()=>waiting.promise});const a=busy.append(messages[0]);const rejected=assert.rejects(a);
  await assert.rejects(busy.append(messages[1]));waiting.release();await rejected;await assert.rejects(busy.finish());
});

test('saved body snapshot yields the same floors/digests without returning text, hidden swipes, recipes or extra fields',async t=>{
  const f=await chatEvidenceFixture(t),before=await fs.readFile(f.file),result=await f.service.readGalleryEvidence(f.req,f.request());
  assert.deepEqual(result.chatEvidence,await captureStoryboardChatEvidence(f.messages,f.target.chatId));
  assert.deepEqual(await chatGalleryEvidenceResponse(result),result);assert.equal(result.source.sha256,sha(before));assert.equal(result.source.bytes,before.length);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_|正文|USER 的选择|snapshot|swipes|apiKey/);assert.deepEqual(await fs.readFile(f.file),before);
  assert.deepEqual(await fs.readdir(f.user),['chats','group chats']);
});

test('UTF8 fragments, BOM header, CRLF, final line without newline and zero-message chat retain exact floors',async t=>{
  let closed=0;const f=await chatEvidenceFixture(t,{io:{...fs,async open(...args){const handle=await fs.open(...args);return {stat:o=>handle.stat(o),read:(b,o,l,p)=>handle.read(b,o,Math.min(3,l),p),close:async()=>{closed++;await handle.close();}};}}});
  for(const body of [f.messages,[]]){const before=await f.write({bom:'\uFEFF',newline:'\r\n',trailing:false,body});
    const result=await f.service.readGalleryEvidence(f.req,f.request());assert.equal(result.source.sha256,sha(before));assert.deepEqual(result.chatEvidence,await captureStoryboardChatEvidence(body,f.target.chatId));}
  assert.equal(closed,2);
});

test('same-named character and group chats remain separate; current browser context cannot supply historical body',async t=>{
  const f=await chatEvidenceFixture(t);await fs.mkdir(path.join(f.chats,'Bob'));
  const second=path.join(f.chats,'Bob','chat-one.jsonl'),group=path.join(f.groups,'chat-one.jsonl');
  for(const [file,mes] of [[second,'different character'],[group,'group story']])await fs.writeFile(file,JSON.stringify(f.header())+'\n'+JSON.stringify({mes})+'\n');
  const original=await f.service.readGalleryEvidence(f.req,f.request());
  for(const [target,mes] of [[{...f.target,avatar:'Bob.png'},'different character'],[{kind:'group',chatId:'chat-one'},'group story']]){
    const value=await f.service.readGalleryEvidence(f.req,{...f.request(),target});assert.deepEqual(value.chatEvidence,await captureStoryboardChatEvidence([{mes}],'chat-one'));assert.notEqual(value.chatEvidence.digest,original.chatEvidence.digest);
  }
});

test('selectors refuse uploads, paths, missing gallery digests and other accounts before file reads',async t=>{
  const f=await chatEvidenceFixture(t);
  for(const value of [{...f.request(),messages:[]},{...f.request(),path:f.file},{...f.request(),gallerySha256:''},{...f.request(),target:{...f.target,chatId:'../other'}}])assert.throws(()=>chatGalleryEvidenceRequest(value));
  await reject(f.service.readGalleryEvidence(f.req,{...f.request(),expectedAccount:'st-user:'+sha('bob')}),'account');
  await reject(f.service.readGalleryEvidence({},f.request()),'account');
  await reject(f.service.readGalleryEvidence(f.req,{...f.request(),gallerySha256:'0'.repeat(64)}),'record_changed');
});

test('missing sources and absent gallery are not empty evidence; malformed body lines never shift floors',async t=>{
  const f=await chatEvidenceFixture(t);await reject(f.service.readGalleryEvidence(f.req,{...f.request(),target:{...f.target,chatId:'missing'}}),'missing');
  await f.write({header:{chat_metadata:{}}});await reject(f.service.readGalleryEvidence(f.req,f.request()),'record_missing');
  for(const value of ['', '\r', '{broken', '{}', 'null', '[]', JSON.stringify({mes:4}),JSON.stringify({mes:'ok',swipe_id:-1}), '\uFEFF'+JSON.stringify({mes:'body BOM'})]){
    await fs.writeFile(f.file,JSON.stringify(f.header())+'\n'+JSON.stringify(f.messages[0])+'\n'+value+'\n');await reject(f.service.readGalleryEvidence(f.req,f.request()),'content');
  }
  await fs.writeFile(f.file,Buffer.concat([Buffer.from(JSON.stringify(f.header())+'\n'),Buffer.from([0xff,10])]));await reject(f.service.readGalleryEvidence(f.req,f.request()),'content');
});

test('file and line byte limits reject rather than truncate, with oversized files rejected before open',async t=>{
  let opened=0;const f=await chatEvidenceFixture(t,{io:{...fs,async lstat(name,options){const value=await fs.lstat(name,options);if(name.endsWith('.jsonl'))value.size=BigInt(LIMIT.fileBytes+1);return value;},open(){opened++;assert.fail('oversize file must not open');}}});
  await reject(f.service.readGalleryEvidence(f.req,f.request()),'evidence_size');assert.equal(opened,0);
  const g=await chatEvidenceFixture(t);await g.write({body:[{mes:'a'.repeat(LIMIT.lineBytes)}]});const before=await fs.readFile(g.file);await reject(g.service.readGalleryEvidence(g.req,g.request()),'evidence_size');assert.deepEqual(await fs.readFile(g.file),before);
});

test('message count bound refuses the extra line with no partial evidence',async t=>{
  const f=await chatEvidenceFixture(t);const content=JSON.stringify(f.header())+'\n'+(JSON.stringify({mes:''})+'\n').repeat(LIMIT.messages+1);await fs.writeFile(f.file,content);
  await reject(f.service.readGalleryEvidence(f.req,f.request()),'evidence_size');
});

test('hard links, linked directories and outside account bases are refused',async t=>{
  const f=await chatEvidenceFixture(t);const link=path.join(f.folder,'linked.jsonl');await fs.link(f.file,link);
  await reject(f.service.readGalleryEvidence(f.req,f.request()),'path');await fs.unlink(link);
  await fs.symlink(f.folder,path.join(f.chats,'Alias'),'junction');await reject(f.service.readGalleryEvidence(f.req,{...f.request(),target:{...f.target,avatar:'Alias.png'}}),'path');
  f.req.user.directories.chats=f.root;await reject(f.service.readGalleryEvidence(f.req,f.request()),'path');
});

test('in-place mutation, replacement, account switch and abort during reading discard the entire observation',async t=>{
  for(const mode of ['append','replace','account','abort']){
    const controller=new AbortController();let f,first=true,closed=0;
    f=await chatEvidenceFixture(t,{io:{...fs,async open(...args){const h=await fs.open(...args);return {stat:o=>h.stat(o),close:async()=>{closed++;await h.close();},async read(...readArgs){const result=await h.read(...readArgs);if(first){first=false;
      if(mode==='append')await fs.appendFile(f.file,JSON.stringify({mes:'late'})+'\n');
      else if(mode==='replace'){const old=await fs.readFile(f.file);await fs.rename(f.file,f.file+'.old');await fs.writeFile(f.file,old);}
      else if(mode==='account')f.req.user.profile.handle='bob';else controller.abort();}return result;}};}}});
    await reject(f.service.readGalleryEvidence(f.req,f.request(),{signal:controller.signal}),'changed');assert.equal(closed,1);
  }
});

test('bounded pending readers close their handles on service shutdown and do not publish late evidence',async t=>{
  const blocked=gate(),entered=gate();let reads=0,closed=0;
  const f=await chatEvidenceFixture(t,{io:{...fs,async open(...args){const h=await fs.open(...args);return {stat:o=>h.stat(o),close:async()=>{closed++;await h.close();},async read(...a){if(++reads===4)entered.release();await blocked.promise;return h.read(...a);}};}}});
  const pending=Array.from({length:4},()=>reject(f.service.readGalleryEvidence(f.req,f.request()),'changed'));await entered.promise;
  await reject(f.service.readGalleryEvidence(f.req,f.request()),'busy');const closing=f.service.close();blocked.release();await Promise.all([...pending,closing]);assert.equal(closed,4);
});

test('existing QMB retains server-derived evidence and its resolver refuses ambiguous or missing original anchors',async t=>{
  const f=await chatEvidenceFixture(t),result=await f.service.readGalleryEvidence(f.req,f.request()),bundle=await bundleFixture();bundle.options.chatEvidence=result.chatEvidence;
  const built=await bundle.build(),opened=await openStoryboardBundle(built.file);assert.deepEqual(await opened.readJson('chat-evidence'),result.chatEvidence);
  const target=await captureStoryboardChatEvidence([{mes:'inserted'},...f.messages],'chat-one'),resolve=createStoryboardEvidenceLinkResolver(result.chatEvidence,target);
  const row=result.chatEvidence.messages[0];assert.equal(resolve({floor:0,messageHash:row.messageHash,swipeId:row.swipeId}),1);assert.equal(resolve({floor:0}),null);
  const duplicate=await captureStoryboardChatEvidence([...f.messages,...f.messages],'chat-one');assert.equal(createStoryboardEvidenceLinkResolver(result.chatEvidence,duplicate)({floor:0,messageHash:row.messageHash,swipeId:row.swipeId}),null);
});

test('historical client requests only selected server scope and exact digest, strips unrelated headers',async t=>{
  const f=await chatEvidenceFixture(t);let sent;
  const c=client(f,{headers:()=>({'X-CSRF-Token':'fixture','Authorization':'PRIVATE'}),fetchImpl:(url,options)=>{sent={url,...options};return f.fetch(url,options);}});t.after(()=>c.close());
  const value=await c.read(f.request().gallerySha256);assert.deepEqual(value.chatEvidence,await captureStoryboardChatEvidence(f.messages,'chat-one'));
  assert.deepEqual(JSON.parse(sent.body),f.request());assert.equal(sent.url,'/api/plugins/qianmu-tts/chat-gallery/evidence');assert.equal(sent.credentials,'same-origin');assert.equal(sent.cache,'no-store');assert.equal(sent.redirect,'error');
  assert.deepEqual(sent.headers,{'Content-Type':'application/json',Accept:'application/json','X-CSRF-Token':'fixture'});
});

test('response validation rejects altered floors/digests, raw fields and another account, target or gallery',async t=>{
  const f=await chatEvidenceFixture(t),valid=await f.service.readGalleryEvidence(f.req,f.request());
  for(const change of [{chatEvidence:{...valid.chatEvidence,digest:'0'.repeat(64)}},{source:{...valid.source,bytes:LIMIT.fileBytes+1}},{messages:[]},
    {chatEvidence:{...valid.chatEvidence,messages:[{...valid.chatEvidence.messages[0],mes:'PRIVATE'}]}}])await assert.rejects(chatGalleryEvidenceResponse({...valid,...change}));
  for(const change of [{expectedAccount:'st-user:'+sha('bob')},{target:{...valid.target,avatar:'Bob.png'}},{gallerySha256:'0'.repeat(64)},{proof:'read-only-record'}]){
    const c=client(f,{fetchImpl:async()=>Response.json({...valid,...change})});t.after(()=>c.close());await reject(c.read(f.request().gallerySha256),'client');
  }
});

test('old backend, cancellation, close, stalled headers/body and late account guard never deliver partial evidence',async t=>{
  const f=await chatEvidenceFixture(t);
  const old=client(f,{fetchImpl:async()=>new Response('old',{status:404})});await assert.rejects(old.read(f.request().gallerySha256),/更新千幕配套后端/);old.close();
  let released=false;const waiting=client(f,{timeoutMs:100,fetchImpl:async()=>new Response(new ReadableStream({cancel(){released=true;}}),{headers:{'content-type':'application/json'}})});
  await reject(waiting.read(f.request().gallerySha256),'client');assert.equal(released,true);waiting.close();
  const headers=gate();let calls=0;const delayed=client(f,{timeoutMs:100,headers:()=>headers.promise,fetchImpl:()=>{calls++;assert.fail('late request');}});
  await reject(delayed.read(f.request().gallerySha256),'client');headers.release({});await new Promise(done=>setTimeout(done,10));assert.equal(calls,0);delayed.close();
  const c=client(f);c.close();await reject(c.read(f.request().gallerySha256),'client');const controller=new AbortController();controller.abort();const aborted=client(f);await reject(aborted.read(f.request().gallerySha256,{signal:controller.signal}),'client');aborted.close();
  let changed=false;const late=client(f,{guard:async()=>{if(changed)throw Error('account changed');},fetchImpl:async(...args)=>{const result=await f.fetch(...args);changed=true;return result;}});await reject(late.read(f.request().gallerySha256),'client');late.close();
});

test('real plugin endpoint authenticates, validates scope and exposes only no-store evidence',async t=>{
  const f=await chatEvidenceFixture(t),routes=new Map();await init({get:(p,h)=>routes.set(p,h),post:(p,h)=>routes.set(p,h)},{dataRoot:f.root});t.after(()=>exit());
  const server=http.createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);req.body=JSON.parse(Buffer.concat(chunks).toString());if(req.headers['x-fixture']==='alice')req.user=f.req.user;
    res.set=(k,v)=>{res.setHeader(k,v);return res;};res.status=c=>{res.statusCode=c;return res;};res.json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};await routes.get(req.url)(req,res);});
  await new Promise(done=>server.listen(0,'127.0.0.1',done));t.after(()=>new Promise(done=>server.close(done)));
  const call=(body=f.request(),auth=true)=>fetch('http://127.0.0.1:'+server.address().port+'/chat-gallery/evidence',{method:'POST',headers:{'Content-Type':'application/json',...(auth?{'x-fixture':'alice'}:{})},body:JSON.stringify(body)});
  assert.equal((await call(f.request(),false)).status,401);assert.equal((await call({...f.request(),messages:[]})).status,400);
  const reply=await call();assert.equal(reply.status,200);assert.equal(reply.headers.get('cache-control'),'no-store');assert.equal(reply.headers.get('x-content-type-options'),'nosniff');const value=await reply.json();await inspectStoryboardChatEvidence(value.chatEvidence);assert.doesNotMatch(JSON.stringify(value),/PRIVATE_|正文/);
});
