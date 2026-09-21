import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {createGalleryDiscoveryClient} from '../qianmu-gallery-discovery-client.js';
import {installGalleryDiscoveryRoutes} from '../qianmu-gallery-discovery-routes.js';
import {GALLERY_DISCOVERY_LIMITS} from '../qianmu-gallery-discovery-contract.js';
import {galleryDiscoveryFixture} from './helpers/gallery-discovery-fixture.mjs';
import {init,exit} from '../server-plugin.js';

const BASE='/api/plugins/qianmu-tts/gallery-archive/versions',account='st-user:alice',expectedAccount='st-user:'+createHash('sha256').update('alice').digest('hex');
const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const response=()=>({ok:true,version:2,expectedAccount,entries:[],nextCursor:null,proof:'read-only-directory'});
const options=patch=>({account:async()=>account,headers:()=>({'X-CSRF-Token':'fixture','Authorization':'DO_NOT_SEND','Cookie':'DO_NOT_SEND','X-API-Key':'DO_NOT_SEND'}),...patch});
const json=(value,status=200)=>Response.json(value,{status});

test('client is lazy, chat-independent, same-origin, and only sends expected account and bounded pagination',async t=>{
  let accounts=0;const calls=[],client=createGalleryDiscoveryClient(options({account:async()=>{accounts++;return account;},fetchImpl:async(url,request)=>{calls.push({url,...request});return json(response());}}));t.after(()=>client.close());
  assert.equal(accounts,0);assert.deepEqual((await client.list()).entries,[]);assert.equal(calls.length,1);
  const call=calls[0];assert.equal(call.url,BASE);assert.equal(call.method,'POST');assert.equal(call.credentials,'same-origin');assert.equal(call.redirect,'error');assert.equal(call.cache,'no-store');
  assert.deepEqual(call.headers,{Accept:'application/json','Content-Type':'application/json','X-CSRF-Token':'fixture'});
  assert.deepEqual(JSON.parse(call.body),{version:2,expectedAccount,limit:24,cursor:null});
});

test('source options are captured before awaits; invalid options cannot add a path or raw content',async t=>{
  const wait=gate(),started=gate(),calls=[];let once=true;
  const client=createGalleryDiscoveryClient(options({account:async()=>{if(once){once=false;started.resolve();await wait.promise;}return account;},fetchImpl:async(_,request)=>{calls.push(JSON.parse(request.body));return json(response());}}));t.after(()=>client.close());
  const input={limit:2},pending=client.list(input);await started.promise;input.limit=32;wait.resolve();await pending;assert.equal(calls[0].limit,2);
  for(const raw of [{path:'private'},{limit:33},{cursor:{after:'../'}},[]])await assert.rejects(client.list(raw));assert.equal(calls.length,1);
});

test('old endpoint 404 and an existing backend missing-file 404 have different, concise meanings',async t=>{
  for(const [reply,code] of [[new Response('not found',{status:404}),'gallery_discovery_unsupported'],[json({ok:false},404),'gallery_discovery_unsupported'],
    [json({ok:false,code:'gallery_discovery_missing',message:'PRIVATE_SERVER_PATH'},404),'gallery_discovery_missing']]){
    const client=createGalleryDiscoveryClient(options({fetchImpl:async()=>reply}));t.after(()=>client.close());
    await assert.rejects(client.list(),error=>error.serviceCode===code&&!error.message.includes('PRIVATE'));
  }
});

test('account changes during a response invalidate the client and discard late metadata',async t=>{
  let owner=account,calls=0;const client=createGalleryDiscoveryClient(options({account:async()=>owner,fetchImpl:async()=>{calls++;owner='st-user:bob';return json(response());}}));
  await assert.rejects(client.list(),error=>error.serviceCode==='gallery_discovery_account');await assert.rejects(client.list(),/结束/);assert.equal(calls,1);
});

test('unauthenticated responses invalidate the client without echoing arbitrary server text',async()=>{
  for(const status of [401,403]){
    const client=createGalleryDiscoveryClient(options({fetchImpl:async()=>json({message:'PRIVATE_SERVER_SECRET'},status)}));
    await assert.rejects(client.list(),error=>error.serviceCode==='gallery_discovery_account'&&!error.message.includes('PRIVATE'));
    await assert.rejects(client.list(),/结束/);
  }
});

test('wrong account and malformed response never become an empty library',async t=>{
  for(const value of [{...response(),expectedAccount:'st-user:'+'a'.repeat(64)},{...response(),extra:true},{...response(),entries:[{key:'bad'}]},{}]){
    const client=createGalleryDiscoveryClient(options({fetchImpl:async()=>json(value)}));t.after(()=>client.close());await assert.rejects(client.list());
  }
});

test('redirects, wrong content type, excessive or invalid encoded bodies are rejected and discarded',async t=>{
  const variants=[()=>new Response('html',{headers:{'content-type':'text/html'}}),()=>new Response('{}',{status:302,headers:{'content-type':'application/json'}}),
    ()=>new Response(new Uint8Array([0xff]),{headers:{'content-type':'application/json'}}),
    ()=>new Response(' '.repeat(GALLERY_DISCOVERY_LIMITS.responseBytes+1),{headers:{'content-type':'application/json'}}),
    ()=>new Response('{"ok":true,"ok":false}',{headers:{'content-type':'application/json'}}),
    ()=>{const reply=json(response());Object.defineProperty(reply,'url',{value:'https://other.invalid/private'});return reply;}];
  for(const make of variants){const reply=make(),client=createGalleryDiscoveryClient(options({fetchImpl:async()=>reply}));t.after(()=>client.close());
    await assert.rejects(client.list());assert.equal(reply.body.locked,false);}
});

test('deadline includes identity, lifecycle guard and headers; late resolution never dispatches',async t=>{
  for(const phase of ['account','guard','headers']){
    const wait=gate();let calls=0;const configured=options({timeoutMs:100,fetchImpl:async()=>{calls++;return json(response());}});
    configured[phase]=async()=>{await wait.promise;return phase==='account'?account:phase==='guard'?true:{};};
    const client=createGalleryDiscoveryClient(configured);t.after(()=>client.close());await assert.rejects(client.list(),/超时|取消/);
    wait.resolve();await new Promise(resolve=>setTimeout(resolve,10));assert.equal(calls,0);
  }
});

test('timeout retains pending fetch slots until late transport cleanup; close and abort stop waiting',async t=>{
  const release=gate(),started=gate();let calls=0;
  const client=createGalleryDiscoveryClient(options({timeoutMs:100,fetchImpl:async()=>{if(++calls===2)started.resolve();await release.promise;return json(response());}}));t.after(()=>client.close());
  const first=client.list(),second=client.list(),finished=Promise.allSettled([first,second]);await started.promise;
  assert.ok((await finished).every(item=>item.status==='rejected'));await assert.rejects(client.list(),/正在读取/);assert.equal(calls,2);
  release.resolve();await new Promise(resolve=>setTimeout(resolve,10));await client.list();assert.equal(calls,3);
  for(const mode of ['close','abort']){
    const begin=gate(),end=gate(),controller=new AbortController(),other=createGalleryDiscoveryClient(options({fetchImpl:async()=>{begin.resolve();await end.promise;return json(response());}}));t.after(()=>other.close());
    const pending=other.list({}, {signal:controller.signal});await begin.promise;mode==='close'?other.close():controller.abort();await assert.rejects(pending,/取消/);end.resolve();
  }
});

test('stalled response stream is cancelled on close and cannot append a late page',async t=>{
  const started=gate();let cancelled=0;const client=createGalleryDiscoveryClient(options({fetchImpl:async()=>new Response(new ReadableStream({pull(){started.resolve();},cancel(){cancelled++;}}),{headers:{'content-type':'application/json'}})}));t.after(()=>client.close());
  const pending=client.list();await started.promise;client.close();await assert.rejects(pending,/取消/);assert.equal(cancelled,1);
});

test('route refuses anonymous users before constructing a service and cancels on a disconnected response',async t=>{
  let handler,roots=0;const services=[];
  installGalleryDiscoveryRoutes({post:(route,fn)=>{assert.equal(route,'/gallery-archive/versions');handler=fn;}},{dataRoot:()=>{roots++;throw Error('PRIVATE_PATH');},register:service=>services.push(service)});
  const req=new EventEmitter(),res=new EventEmitter();let status,value;
  Object.assign(res,{set(){},status(code){status=code;return this;},json(body){value=body;this.writableEnded=true;return this;}});
  await handler(req,res);assert.equal(status,401);assert.equal(roots,0);assert.equal(services.length,0);assert.equal(res.listenerCount('close'),0);assert.equal(req.listenerCount('aborted'),0);
  assert.ok(!JSON.stringify(value).includes('PRIVATE'));
  const f=await galleryDiscoveryFixture(t),started=gate(),release=gate();
  installGalleryDiscoveryRoutes({post:(_,fn)=>{handler=fn;}},{dataRoot:()=>f.host.root,register:service=>{services.push(service);t.after(()=>service.close());},serviceOptions:{io:{...fs,opendir:async()=>({
    async *[Symbol.asyncIterator](){started.resolve();await release.promise;yield {name:'ignored'};},async close(){}
  })}}});
  const owned=Object.assign(new EventEmitter(),{user:f.host.req.user,body:f.input()}),gone=Object.assign(new EventEmitter(),{set(){},json(){assert.fail('disconnected response must not receive JSON');},status(){return this;}});
  const pending=handler(owned,gone);await started.promise;gone.destroyed=true;gone.emit('close');await pending;release.resolve();
  assert.equal(gone.listenerCount('close'),0);assert.equal(owned.listenerCount('aborted'),0);
});

test('production plugin route + real local HTTP + client discovers owned files without an open chat',async t=>{
  const f=await galleryDiscoveryFixture(t);for(let i=1;i<=3;i++)await f.add(i);await f.flush();await fs.unlink(f.host.file);const before=await f.unchanged();
  const routes=new Map(),seen=[];await init({get:(route,handler)=>routes.set('GET '+route,handler),post:(route,handler)=>routes.set('POST '+route,handler)},{dataRoot:f.host.root});
  const server=http.createServer(async(req,res)=>{
    if(req.headers['x-test-login']==='alice')req.user=structuredClone(f.host.req.user);
    const chunks=[];for await(const chunk of req)chunks.push(chunk);req.body=chunks.length?JSON.parse(Buffer.concat(chunks)):{};
    res.set=(key,value)=>{res.setHeader(key,value);return res;};res.status=code=>{res.statusCode=code;return res;};res.json=value=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(value));return res;};
    seen.push(req.url);const handler=routes.get(req.method+' '+req.url.replace('/api/plugins/qianmu-tts',''));if(handler)await handler(req,res);else{res.statusCode=404;res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await exit();});
  const origin=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(origin+BASE,{method:'POST'})).status,401);
  const client=createGalleryDiscoveryClient(options({fetchImpl:async(url,request)=>{
    const reply=await fetch(origin+url,{...request,headers:{...request.headers,'x-test-login':'alice'}});
    assert.equal(reply.headers.get('cache-control'),'no-store');assert.equal(reply.headers.get('x-content-type-options'),'nosniff');return reply;
  }}));t.after(()=>client.close());
  const first=await client.list({limit:2}),next=await client.list({limit:2,cursor:first.nextCursor});
  assert.equal(first.entries.length+next.entries.length,3);assert.equal(next.nextCursor,null);assert.ok(!JSON.stringify([first,next]).includes('PRIVATE_'));
  const rejected=await fetch(origin+BASE,{method:'POST',headers:{'x-test-login':'alice','content-type':'application/json'},body:JSON.stringify({...f.input(),path:f.folder})});
  assert.equal(rejected.status,400);assert.deepEqual(await f.unchanged(),before);assert.ok(seen.every(url=>url===BASE));
});
