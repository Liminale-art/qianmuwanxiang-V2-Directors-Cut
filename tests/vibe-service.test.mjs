import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createVibeEncodingService,vibeServiceErrorPayload} from '../qianmu-vibe-service.js';
import {createVibeServiceCache} from '../qianmu-vibe-service-cache.js';
import {createImageServiceStore} from '../qianmu-image-service-store.js';
import {imageServiceAccount} from '../qianmu-image-service-access.js';
import {prepareNovelVibeEncoding,encodeNovelVibe} from '../qianmu-vibe-encoding.js';
import {createVibeServiceClient} from '../qianmu-vibe-service-client.js';
const image='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';
const actor=(handle='alice')=>({user:{profile:{handle,enabled:true}}});
const request=()=>({version:1,provider:'novel',protocol:'novelai',baseUrl:'https://relay.example',model:'nai-diffusion-4-5-full',apiKey:'private-fixture-key',information:0,image});
async function envelope(extra={}){const value=request(),prepared=await prepareNovelVibeEncoding(value);return {version:1,expectedAccount:imageServiceAccount(actor()).namespace,cacheKey:prepared.cacheKey,request:value,confirmed:true,...extra};}
async function fixture(t,options={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'qianmu-vibe-service-')),store=createImageServiceStore({dataRoot:root,scope:'vibe'}),cache=createVibeServiceCache({dataRoot:root,store});
  let posts=0;const services=[];
  const make=(overrides={})=>{const service=createVibeEncodingService({dataRoot:root,encode:(input,hooks)=>encodeNovelVibe(input,{...hooks,fetchImpl:async()=>{
    posts++;return new Response('fixture-opaque-binary',{status:201,headers:{'content-type':'application/binary'}});
  }}),...overrides});services.push(service);return service;};
  const service=make({store,cache,...options});
  t.after(async()=>{await Promise.all(services.map(service=>service.close()));
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'qianmu-vibe-service-'));await fs.rm(root,{recursive:true,force:true});});
  return {service,root,store,cache,make,posts:()=>posts};
}
test('service construction/query are lazy and authenticated; guessed namespaces and stale accounts cannot allocate storage',async t=>{
  const e=await fixture(t),input=await envelope();assert.deepEqual(await fs.readdir(e.root),[]);
  assert.equal((await e.service.query(actor(),input)).task,null);assert.deepEqual(await fs.readdir(e.root),[]);
  for(const req of [{},actor('bob')])await assert.rejects(()=>e.service.submit(req,{...input,namespace:imageServiceAccount(actor()).namespace}),{status:401});
  await assert.rejects(()=>e.service.submit(actor(),{...input,confirmed:'true'}));assert.equal(e.posts(),0);assert.deepEqual(await fs.readdir(e.root),[]);
});
test('actual native encoder, durable ledger and private binary cache complete once and survive service restart and key rotation',async t=>{
  const e=await fixture(t),input=await envelope(),result=await e.service.submit(actor(),input);assert.equal(result.stored,true);assert.equal(result.result.encoding,btoa('fixture-opaque-binary'));assert.equal(e.posts(),1);
  const query={version:1,expectedAccount:input.expectedAccount,cacheKey:input.cacheKey};assert.equal((await e.service.query(actor(),query)).task.status,'ready');
  await e.service.close();const next=e.make();assert.deepEqual((await next.result(actor(),query)).result,result.result);
  assert.deepEqual((await next.submit(actor(),{...input,request:{...input.request,apiKey:'rotated-key'}})).result,result.result);assert.equal(e.posts(),1);
  const folders=await fs.readdir(path.join(e.root,'.qianmu-service'));assert.deepEqual(folders.sort(),['novel-channel-v1','vibe-queue-v1','vibe-results-v1']);
  for(const folder of folders){for(const entry of await fs.readdir(path.join(e.root,'.qianmu-service',folder),{withFileTypes:true})){
    const files=entry.isDirectory()?await fs.readdir(path.join(e.root,'.qianmu-service',folder,entry.name)).then(names=>names.map(name=>path.join(e.root,'.qianmu-service',folder,entry.name,name))):[path.join(e.root,'.qianmu-service',folder,entry.name)];
    for(const file of files){const text=await fs.readFile(file,'utf8');assert.equal(text.includes('private-fixture-key'),false);assert.equal(text.includes(image),false);}
  }}
});
test('same-key concurrent service instances cannot win a second paid submission',async t=>{
  let release,started;const gate=new Promise(resolve=>release=resolve),began=new Promise(resolve=>started=resolve);let posts=0;
  const encode=(input,hooks)=>encodeNovelVibe(input,{...hooks,fetchImpl:async()=>{posts++;started();await gate;return new Response('binary',{headers:{'content-type':'application/binary'}});}});
  const e=await fixture(t,{encode}),other=e.make({encode}),input=await envelope(),first=e.service.submit(actor(),input);await began;
  await assert.rejects(()=>other.submit(actor(),input));assert.equal(posts,1);release();await first;
  assert.equal((await other.submit(actor(),input)).result.encoding,btoa('binary'));assert.equal(posts,1);
});
test('cross-account result query cannot discover, return or replace another account encoding, including an admin',async t=>{
  const e=await fixture(t),input=await envelope();await e.service.submit(actor(),input);const bob=actor('bob');bob.user.profile.admin=true;
  const lookup={version:1,cacheKey:input.cacheKey,expectedAccount:imageServiceAccount(bob).namespace};assert.equal((await e.service.query(bob,lookup)).task,null);
  await assert.rejects(()=>e.service.result(bob,lookup),{status:404});assert.equal(e.posts(),1);
});
test('result content and confirmation fingerprints are recomputed, rejecting smuggled fields and mismatched models before any POST',async t=>{
  const e=await fixture(t),input=await envelope();
  for(const change of [v=>v.cacheKey='0'.repeat(64),v=>v.request.information=.8,v=>v.request.model='different',v=>v.request.mask='',v=>v.request.headers={Authorization:'secret'},v=>v.request.allowPrivateNetwork=true]){
    const copy=structuredClone(input);change(copy);await assert.rejects(()=>e.service.submit(actor(),copy));
  }assert.equal(e.posts(),0);assert.deepEqual(await fs.readdir(e.root),[]);
});
test('uncertain encoding remains blocked after restart; a definitive rejection requires explicit matching retry consent',async t=>{
  for(const status of [500,429]){
    let posts=0;const encode=(input,hooks)=>encodeNovelVibe(input,{...hooks,fetchImpl:async()=>{posts++;return new Response('',{status});}}),e=await fixture(t,{encode}),input=await envelope();
    await assert.rejects(()=>e.service.submit(actor(),input));const before=(await e.service.query(actor(),input)).task;assert.equal(before.status,status===500?'unknown':'rejected');
    await e.service.close();const next=e.make({encode});await assert.rejects(()=>next.submit(actor(),input));assert.equal(posts,1);
    await assert.rejects(()=>next.submit(actor(),{...input,retryAttemptId:before.attemptId}));assert.equal(posts,status===500?1:2);
  }
});
test('browser disconnect after upstream start preserves the completed encoding for later retrieval',async t=>{
  let started,release;const began=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);const controller=new AbortController();let posts=0;
  const e=await fixture(t,{encode:(input,hooks)=>encodeNovelVibe(input,{...hooks,fetchImpl:async()=>{posts++;started();await gate;return new Response('binary',{headers:{'content-type':'application/binary'}});}})}),input=await envelope();
  const work=e.service.submit(actor(),input,{signal:controller.signal});await began;controller.abort();release();await work;
  assert.equal((await e.service.result(actor(),input)).result.encoding,btoa('binary'));assert.equal(posts,1);
});
test('an already-aborted caller cannot reach the paid encoder',async t=>{
  const e=await fixture(t),input=await envelope(),controller=new AbortController();controller.abort();
  await assert.rejects(()=>e.service.submit(actor(),input,{signal:controller.signal}));assert.equal(e.posts(),0);
});
test('account changes after upstream starts retain bytes privately without returning them to the changed session',async t=>{
  const req=actor();const e=await fixture(t,{encode:(input,hooks)=>encodeNovelVibe(input,{...hooks,fetchImpl:async()=>{req.user.profile.handle='bob';return new Response('binary',{headers:{'content-type':'application/binary'}});}})}),input=await envelope();
  await assert.rejects(()=>e.service.submit(req,input),{status:401});assert.equal((await e.service.result(actor(),input)).result.encoding,btoa('binary'));
});
test('independent cache validation rejects corruption without falling back to a new request',async t=>{
  const e=await fixture(t),input=await envelope();await e.service.submit(actor(),input);
  const base=path.join(e.root,'.qianmu-service','vibe-results-v1'),[name]=await fs.readdir(base),file=path.join(base,name,'result.json');
  const value=JSON.parse(await fs.readFile(file,'utf8'));value.result.encoding=btoa('corrupt');await fs.writeFile(file,JSON.stringify(value));
  await assert.rejects(()=>e.service.result(actor(),input),/校验/);await assert.rejects(()=>e.service.submit(actor(),input));assert.equal(e.posts(),1);
});
test('successful binary with interrupted ready manifest is still recoverable from its exact owner and fence',async t=>{
  const e=await fixture(t),input=await envelope(),result=await e.service.submit(actor(),input),base=path.join(e.root,'.qianmu-service','vibe-results-v1'),[name]=await fs.readdir(base),file=path.join(base,name,'manifest.json');
  const meta=JSON.parse(await fs.readFile(file,'utf8'));await fs.writeFile(file,JSON.stringify({...meta,status:'reserved',bytes:0}));
  await e.service.close();const next=e.make();assert.deepEqual((await next.result(actor(),input)).result,result.result);assert.deepEqual((await next.submit(actor(),input)).result,result.result);assert.equal(e.posts(),1);
});
test('cache write failure returns the obtained encoding once, truthfully marks it unpersisted, and never repays on retry',async t=>{
  const e=await fixture(t),service=e.make({cache:{reserve:async()=>{},save:async()=>{throw Error('disk full');},load:async()=>null}}),input=await envelope();
  const result=await service.submit(actor(),input);assert.equal(result.stored,false);assert.match(result.warning,/暂存未完成/);
  await assert.rejects(()=>service.submit(actor(),input));assert.equal(e.posts(),1);
});
test('public errors omit arbitrary implementation details and distinguish an uncertain fee from a known rejection',()=>{
  const unknown=vibeServiceErrorPayload(Error('private-secret-address'));assert.equal(unknown.body.message.includes('private-secret-address'),false);assert.equal(unknown.body.submissionState,'unknown');
  const rejected=vibeServiceErrorPayload(Object.assign(Error('Denied'),{code:'vibe_encoding_http_401',status:401,submissionState:'rejected'}));assert.equal(rejected.status,401);assert.equal(rejected.body.submissionState,'rejected');
});
test('full service cache refuses the next encoding before POST while keeping existing results retrievable',async t=>{
  const e=await fixture(t),cache=createVibeServiceCache({dataRoot:e.root,store:e.store,maxSlots:1}),service=e.make({store:e.store,cache}),input=await envelope();
  await service.submit(actor(),input);const next=structuredClone(input);next.request.information=.7;next.cacheKey=(await prepareNovelVibeEncoding(next.request)).cacheKey;
  await assert.rejects(()=>service.submit(actor(),next),{code:'vibe_service_storage',submissionState:'not_submitted'});assert.equal(e.posts(),1);
  assert.equal((await service.query(actor(),next)).task.status,'rejected');assert.equal((await service.result(actor(),input)).result.encoding,btoa('fixture-opaque-binary'));
});
test('replaced result directory cannot be followed through a junction to another private slot',async t=>{
  const e=await fixture(t),input=await envelope();await e.service.submit(actor(),input);const base=path.join(e.root,'.qianmu-service','vibe-results-v1'),[name]=await fs.readdir(base);
  const original=path.join(base,name),moved=path.join(e.root,'original-slot');await fs.rename(original,moved);
  try{await fs.symlink(moved,original,process.platform==='win32'?'junction':'dir');}catch(error){if(['EPERM','EACCES'].includes(error.code)){t.skip('Host does not permit test junctions');return;}throw error;}
  await assert.rejects(()=>e.service.result(actor(),input),/目录/);await assert.rejects(()=>e.service.submit(actor(),input));assert.equal(e.posts(),1);
});
test('actual registered endpoints and client negotiate account-bound capability and retrieve a lost submit response without another fee',async t=>{
  const e=await fixture(t),plugin=await import('../server-plugin.js'),routes=new Map();let posts=0,lose=true,authorizations=0;const methods=[];
  await plugin.init({get:(name,fn)=>routes.set(`GET ${name}`,fn),post:(name,fn)=>routes.set(`POST ${name}`,fn)},{dataRoot:e.root,vibeServiceOptions:{
    encode:(input,hooks)=>encodeNovelVibe(input,{...hooks,fetchImpl:async()=>{posts++;return new Response('through-plugin',{headers:{'content-type':'application/binary'}});}}),
  }});
  t.after(()=>plugin.exit());
  const fetchImpl=async(url,init)=>{
    assert.ok(url.startsWith('/api/plugins/qianmu-tts/image/vibe/'));const action=url.split('/').at(-1),method=init.method;methods.push(`${method} ${action}`);
    assert.equal(init.credentials,'same-origin');assert.equal(init.redirect,'error');
    const response={statusCode:200,headers:{},set(name,value){this.headers[name]=value;return this;},status(value){this.statusCode=value;return this;},json(body){this.body=body;this.writableEnded=true;return this;}};
    await routes.get(`${method} /image/vibe/${action}`)({...actor(),body:init.body?JSON.parse(init.body):undefined},response);
    assert.equal(response.headers['Cache-Control'],'no-store');assert.equal(response.headers['X-Content-Type-Options'],'nosniff');
    if(action==='submit'&&lose){lose=false;throw new TypeError('lost after server success');}
    return Response.json(response.body,{status:response.statusCode});
  };
  const client=createVibeServiceClient({namespace:'st-user:alice',fetchImpl}),input=request(),prepared=await prepareNovelVibeEncoding(input);
  assert.equal(await client.query(prepared),null);assert.deepEqual(await fs.readdir(e.root),[]);
  await assert.rejects(()=>client.encode(input,{authorize:async()=>{authorizations++;return true;}}),{submissionState:'unknown'});assert.equal(posts,1);assert.equal(authorizations,1);
  const restarted=createVibeServiceClient({namespace:'st-user:alice',fetchImpl});assert.equal((await restarted.query(prepared)).status,'ready');
  assert.equal((await restarted.result(prepared)).encoding,btoa('through-plugin'));assert.equal(posts,1);assert.equal(methods.filter(value=>value==='POST submit').length,1);
  const other=createVibeServiceClient({namespace:'st-user:bob',fetchImpl});await assert.rejects(()=>other.query(prepared),/兼容/);assert.equal(posts,1);
});
test('client refuses unavailable/forged capabilities and never tries a native URL or submits without authorization',async()=>{
  const prepared=await prepareNovelVibeEncoding(request());
  for(const capability of [{ok:false,version:1},{ok:true,version:2},{ok:true,version:1,accountBindingVersion:1,expectedAccount:'st-user:wrong'}]){
    const methods=[];const client=createVibeServiceClient({namespace:'st-user:alice',fetchImpl:async(url,init)=>{methods.push([url,init.method]);return Response.json(capability);}});
    await assert.rejects(()=>client.query(prepared));assert.equal(methods.length,1);assert.equal(methods[0][1],'GET');
  }
  let writes=0;const client=createVibeServiceClient({namespace:'st-user:alice',fetchImpl:async(_url,init)=>{
    if(init.method!=='GET')writes++;return Response.json({ok:true,version:1,accountBindingVersion:1,expectedAccount:imageServiceAccount(actor()).namespace,nativeEncoding:true,resultRetrieval:true,automaticReplay:false,maxEncodingBytes:8*1024*1024,sharedNativeChannelVersion:1});
  }});
  for(const authorize of [undefined,async()=>false,async()=>({yes:true})])await assert.rejects(()=>client.encode(request(),{authorize}));assert.equal(writes,0);
});
test('client captures the Key before consent and treats malformed or oversized responses as uncertain, never retrying',async()=>{
  const input=request(),prepared=await prepareNovelVibeEncoding(input);let body,writes=0;
  const client=createVibeServiceClient({namespace:'st-user:alice',fetchImpl:async(_url,init)=>{
    if(init.method==='GET')return Response.json({ok:true,version:1,accountBindingVersion:1,expectedAccount:imageServiceAccount(actor()).namespace,nativeEncoding:true,resultRetrieval:true,automaticReplay:false,maxEncodingBytes:8*1024*1024,sharedNativeChannelVersion:1});
    writes++;body=JSON.parse(init.body);return Response.json({ok:true,version:1,result:{version:1,cacheKey:prepared.cacheKey,identity:prepared.identity,encoding:btoa('binary'),durationMs:1}});
  }});
  await client.encode(input,{authorize:async()=>{input.apiKey='replaced';return true;}});assert.equal(body.request.apiKey,'private-fixture-key');assert.equal(writes,1);
  for(const response of [()=>new Response('bad',{headers:{'content-type':'text/html'}}),()=>Response.json({ok:true,version:1,result:{}}),()=>new Response('{}',{headers:{'content-type':'application/json','content-length':String(13*1024*1024)}})]){
    let calls=0;const bad=createVibeServiceClient({namespace:'st-user:alice',fetchImpl:async()=>{calls++;return response();}});
    await assert.rejects(()=>bad.result(prepared));assert.equal(calls,1);
  }
});
test('client retains an unpersisted-server warning as delivery metadata without trusting arbitrary server warning text',async()=>{
  const input=request(),prepared=await prepareNovelVibeEncoding(input),client=createVibeServiceClient({namespace:'st-user:alice',fetchImpl:async(_url,init)=>{
    if(init.method==='GET')return Response.json({ok:true,version:1,accountBindingVersion:1,expectedAccount:imageServiceAccount(actor()).namespace,nativeEncoding:true,resultRetrieval:true,automaticReplay:false,maxEncodingBytes:8*1024*1024,sharedNativeChannelVersion:1});
    return Response.json({ok:true,version:1,stored:false,warning:'untrusted warning',result:{version:1,cacheKey:prepared.cacheKey,identity:prepared.identity,encoding:btoa('binary'),durationMs:1}});
  }});
  const result=await client.encode(input,{authorize:async()=>true});assert.equal(result.serviceStored,false);assert.equal(JSON.stringify(result).includes('untrusted warning'),false);
  assert.deepEqual(result.identity,prepared.identity);
});
