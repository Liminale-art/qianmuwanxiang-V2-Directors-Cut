import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import {createHash,randomUUID,webcrypto} from 'node:crypto';
import {createTextCollection} from '../qianmu-text-collection.js';
import {createTextCollectionNativeService} from '../qianmu-text-collection-native-service.js';
import {installTextCollectionNativeRoutes} from '../qianmu-text-collection-native-routes.js';
import {nativeCollectionCapabilities,nativeCollectionWriteResponse} from '../qianmu-text-collection-native-contract.js';
import {createStAccountStorage} from '../qianmu-st-account-storage.js';
import {createTextCollectionOriginalStore} from '../qianmu-text-collection-original.js';
import {validateNativeCollectionDocument} from '../qianmu-text-collection-document.js';

const sha=text=>createHash('sha256').update(text).digest('hex');
const schema='qianmu.st-account-document.v1',namespace='st-user:alice',expectedAccount='st-user:'+sha('alice'),scope=sha(`${schema}\0${namespace}`);
const gate=()=>{let release;return {promise:new Promise(resolve=>{release=resolve;}),release};};
const full=(id='collection-1',text='第一段😀\n\n第二段',createdAt=1)=>createTextCollection({id,mode:'full',createdAt,
  source:{account:expectedAccount,chatId:'deleted-chat',messageId:0,replyId:'reply-1',charName:'CHAR',userName:'USER',text}});
const mutation=(operation='create',extra={})=>({version:1,expectedAccount,mutationId:randomUUID(),operation,id:'collection-1',baseRevision:operation==='create'||operation==='restore'?0:1,
  ...(operation==='create'?{record:full()}:operation==='edit'?{text:'改后的完整正文😀'}:{}),...extra});
const batch=(...mutations)=>({version:1,expectedAccount,mutations});
async function fixture(t,options={}){
  const parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'qianmu-native-collection-test-'));
  const accountRoot=path.join(root,'alice'),folder=path.join(accountRoot,'files');await fs.mkdir(folder,{recursive:true});
  const req={user:{profile:{handle:'alice'},directories:{root:accountRoot,files:folder}}},services=[];
  const build=extra=>{const service=createTextCollectionNativeService({dataRoot:root,now:()=>100,...options,...extra});services.push(service);return service;};
  const service=build(),head=path.join(folder,`qianmu-v2-${scope}-collections.json`);
  const seed=async value=>{const text=JSON.stringify({schema,scope,slot:'collections',value}),fingerprint=sha(text);
    await fs.writeFile(path.join(folder,`qianmu-v2-${scope}-collections-${fingerprint}.json`),text);
    await fs.writeFile(head,JSON.stringify({schema:'qianmu.st-account-head.v1',scope,slot:'collections',fingerprint}));return {value,fingerprint};};
  const initial={version:2,expectedAccount,revision:0,entries:[],receipts:[]};await seed(initial);
  const read=async()=>{const pointer=JSON.parse(await fs.readFile(head,'utf8')),text=await fs.readFile(path.join(folder,`qianmu-v2-${scope}-collections-${pointer.fingerprint}.json`),'utf8');
    assert.equal(sha(text),pointer.fingerprint);const value=JSON.parse(text).value;validateNativeCollectionDocument(value,{expectedAccount,scope});return {value,fingerprint:pointer.fingerprint};};
  t.after(async()=>{await Promise.all(services.map(service=>service.close()));const real=await fs.realpath(root);assert.equal(path.dirname(real),parent);
    assert.match(path.basename(real),/^qianmu-native-collection-test-/);await fs.rm(real,{recursive:true});});
  return {root,accountRoot,folder,req,service,build,seed,initial,head,read,lock:path.join(folder,'.qianmu-native-collections.lock')};
}
const verify=(result,input)=>nativeCollectionWriteResponse(result,input,{scope,cryptoImpl:webcrypto});

test('native capabilities expose only the authenticated account and exact protocol, without filesystem writes',async t=>{
  const f=await fixture(t),before=await fs.readdir(f.folder),cap=f.service.capabilities(f.req);nativeCollectionCapabilities(cap,expectedAccount);
  assert.deepEqual(Object.keys(cap).sort(),['expectedAccount','indexVersion','nativeProtocol','ok','version']);
  assert.deepEqual(await fs.readdir(f.folder),before);assert.doesNotMatch(JSON.stringify(cap),/alice|files|root|key|token/);
  assert.throws(()=>f.service.capabilities({}),{status:401});
});

test('one native write is readable through the actual ST-native storage and original adapters',async t=>{
  const f=await fixture(t),input=batch(mutation()),result=await f.service.write(f.req,input);await verify(result,input);
  assert.equal(result.acknowledgements.libraryRevision,1);assert.deepEqual(result.verified,await f.read());
  const storage=await createStAccountStorage({resolveNamespace:async()=>namespace,isCurrent:()=>true,headers:()=>({}),cryptoImpl:webcrypto,origin:'https://st.fixture.invalid',
    fetchImpl:async(url,request)=>{assert.equal(request.method,'GET');assert.equal(new URL(url).origin,'https://st.fixture.invalid');
      const name=new URL(url).pathname.split('/').at(-1);assert.match(name,new RegExp(`^qianmu-v2-${scope}-`));
      return new Response(await fs.readFile(path.join(f.folder,name)),{headers:{'content-type':'application/json'}});}});
  t.after(()=>storage.close());const state=(await storage.read('collections')).value;
  const original=await createTextCollectionOriginalStore({storage,expectedAccount}).read(state.entries[0]);assert.deepEqual(original.record,input.mutations[0].record);
  assert.equal(state.entries[0].original.scope,scope);assert.notEqual(scope,expectedAccount.slice(8),'native scope uses raw ST handle, not the hashed request account');
  const files=await fs.readdir(f.folder);assert.equal(files.some(name=>name.includes('unused')||name.includes('.v1')||name.endsWith('.lock')||name.endsWith('.tmp')),false);
});

test('create, edit and restore share existing descriptors, preserve historical bytes and fixed receipts',async t=>{
  const f=await fixture(t),first=batch(mutation()),a=await f.service.write(f.req,first),originalName=`qianmu-v2-${scope}-collection-record-${a.verified.value.entries[0].original.fingerprint}.json`;
  const originalBytes=await fs.readFile(path.join(f.folder,originalName)),edited=batch(mutation('edit'));
  const b=await f.service.write(f.req,edited);await verify(b,edited);assert.equal(b.acknowledgements.results[0].revision,2);
  assert.deepEqual(await fs.readFile(path.join(f.folder,originalName)),originalBytes);assert.notEqual(b.verified.value.entries[0].original.fingerprint,a.verified.value.entries[0].original.fingerprint);
  const restore=batch(mutation('restore',{id:'restored-copy-1',record:first.mutations[0].record,text:'恢复草稿😀'})),c=await f.service.write(f.req,restore);await verify(c,restore);
  assert.equal(c.verified.value.entries.length,2);const bytes=await fs.readFile(f.head),names=await fs.readdir(f.folder);
  const replay=await f.build().write(f.req,edited);await verify(replay,edited);assert.deepEqual(replay.acknowledgements.results,b.acknowledgements.results);
  assert.equal(replay.acknowledgements.libraryRevision,3);assert.deepEqual(await fs.readFile(f.head),bytes);assert.deepEqual(await fs.readdir(f.folder),names);
  await assert.rejects(f.service.write(f.req,batch({...edited.mutations[0],text:'同编号不同内容'})),{code:'text_collection_sync_mutation_conflict'});
  assert.deepEqual(await fs.readFile(f.head),bytes);
});

test('batch deletion needs no original read and missing originals do not prevent a tombstone',async t=>{
  const f=await fixture(t),created=batch(mutation(),mutation('create',{id:'collection-2',record:full('collection-2')}));
  const saved=await f.service.write(f.req,created);
  await fs.unlink(path.join(f.folder,`qianmu-v2-${scope}-collection-record-${saved.verified.value.entries[0].original.fingerprint}.json`));
  const writer=f.build({io:{...fs,open:async(file,...args)=>{assert.equal(/-collection-record-[a-f0-9]+\.json$/.test(file),false,'delete never opens full originals');return fs.open(file,...args);}}});
  const input=batch(mutation('delete'),mutation('delete',{id:'collection-2'})),removed=await writer.write(f.req,input);await verify(removed,input);
  assert.equal(removed.verified.value.revision,4);assert.equal(removed.verified.value.entries.every(row=>row.deleted&&row.record===null),true);
  assert.doesNotMatch(JSON.stringify(removed.verified.value.entries),/CHAR|USER|deleted-chat|第一段/);
});

test('a stale target rejects the entire mixed batch before preserving any new body',async t=>{
  const f=await fixture(t);await f.service.write(f.req,batch(mutation()));
  const head=await fs.readFile(f.head),files=await fs.readdir(f.folder),input=batch(mutation('create',{id:'collection-2',record:full('collection-2')}),mutation('edit',{baseRevision:2}));
  await assert.rejects(f.service.write(f.req,input),{code:'text_collection_sync_conflict',writeState:'not_started'});
  assert.deepEqual(await fs.readFile(f.head),head);assert.deepEqual(await fs.readdir(f.folder),files);
});

test('a lost acknowledged head replacement retries the same mutation without another version or file',async t=>{
  const f=await fixture(t),input=batch(mutation());let lose=true,replacements=0;
  const writer=f.build({io:{...fs,rename:async(...args)=>{await fs.rename(...args);replacements++;if(lose){lose=false;throw Error('lost acknowledgement: private disk path');}}}});
  await assert.rejects(writer.write(f.req,input),cause=>cause.writeState==='unconfirmed'&&!cause.message.includes('private disk'));
  assert.equal((await f.read()).value.revision,1);const files=await fs.readdir(f.folder),head=await fs.readFile(f.head),retry=await writer.write(f.req,input);await verify(retry,input);
  assert.equal(replacements,1);assert.equal(retry.verified.value.revision,1);assert.deepEqual(await fs.readFile(f.head),head);assert.deepEqual(await fs.readdir(f.folder),files);
});

test('failed head publication retains new immutable bytes and the prior library, then allows a fixed retry',async t=>{
  const f=await fixture(t),input=batch(mutation()),before=await fs.readFile(f.head);let fail=true;
  const writer=f.build({io:{...fs,rename:async(...args)=>{if(fail){fail=false;throw Error('disk unavailable');}return fs.rename(...args);}}});
  await assert.rejects(writer.write(f.req,input),{writeState:'unconfirmed'});assert.deepEqual(await fs.readFile(f.head),before);
  assert.equal((await fs.readdir(f.folder)).some(name=>name.includes('-collection-record-')),true);assert.equal((await fs.readdir(f.folder)).some(name=>name.endsWith('.tmp')),false);
  const result=await writer.write(f.req,input);await verify(result,input);assert.equal(result.verified.value.revision,1);
});

test('a lost immutable link acknowledgement cleans only its own temporary link and preserves retryable bytes',async t=>{
  const f=await fixture(t),input=batch(mutation());let lose=true;
  const writer=f.build({io:{...fs,link:async(...args)=>{await fs.link(...args);if(lose){lose=false;throw Error('lost copy acknowledgement');}}}});
  await assert.rejects(writer.write(f.req,input),{writeState:'unconfirmed'});assert.equal((await f.read()).value.revision,0);
  const names=await fs.readdir(f.folder),name=names.find(name=>name.includes('-collection-record-'));assert.ok(name);
  assert.equal((await fs.stat(path.join(f.folder,name),{bigint:true})).nlink,1n);assert.equal(names.some(name=>name.endsWith('.tmp')),false);
  const retry=await writer.write(f.req,input);await verify(retry,input);assert.equal(retry.verified.value.revision,1);
});

for(const timing of ['before-head','after-head'])test(`an old native writer changing the head ${timing} is detected without claiming cross-transport CAS`,async t=>{
  const f=await fixture(t),input=batch(mutation()),remote={...f.initial,migration:{source:'other-native-writer'}};let change=true;
  const io=timing==='before-head'?{...fs,link:async(...args)=>{await fs.link(...args);if(change&&args[1].includes('-collections-')){change=false;await f.seed(remote);}}}:
    {...fs,rename:async(...args)=>{await fs.rename(...args);if(change){change=false;await f.seed(remote);}}};
  const writer=f.build({io});await assert.rejects(writer.write(f.req,input),{code:'text_collection_sync_conflict',writeState:'unconfirmed'});
  assert.deepEqual((await f.read()).value,remote);assert.equal((await fs.readdir(f.folder)).some(name=>name.includes('-collection-record-')),true);
});

test('one service serializes independent writes while a second service cannot enter its account lock',async t=>{
  const f=await fixture(t),held=gate(),entered=gate();let hold=true;
  const writer=f.build({io:{...fs,link:async(...args)=>{if(hold){hold=false;entered.release();await held.promise;}return fs.link(...args);}}});
  const first=writer.write(f.req,batch(mutation()));await entered.promise;
  await assert.rejects(f.service.write(f.req,batch(mutation('create',{id:'collection-2',record:full('collection-2')}))),{code:'text_collection_sync_busy',status:423});
  const second=writer.write(f.req,batch(mutation('create',{id:'collection-2',record:full('collection-2')})));held.release();await first;await second;
  assert.equal((await f.read()).value.revision,2);assert.equal((await f.read()).value.entries.length,2);
});

for(const change of ['account','files','abort','close'])test(`${change} changes during an awaited operation never publish success or cross-account data`,async t=>{
  const f=await fixture(t),held=gate(),entered=gate(),controller=new AbortController();let hold=true;
  const writer=f.build({io:{...fs,realpath:async(...args)=>{const result=await fs.realpath(...args);if(hold){hold=false;entered.release();await held.promise;}return result;}}});
  const pending=writer.write(f.req,batch(mutation()),{signal:controller.signal});const rejected=assert.rejects(pending,{writeState:'not_started'});await entered.promise;let closing;
  if(change==='account')f.req.user.profile.handle='bob';else if(change==='files')f.req.user.directories.files=path.join(f.accountRoot,'other-files');else if(change==='abort')controller.abort();else closing=writer.close();
  held.release();await rejected;if(closing)await closing;assert.equal((await f.read()).value.revision,0);assert.equal((await fs.readdir(f.folder)).some(name=>name.includes('-collection-record-')),false);
});

test('timeout retains a hung filesystem slot and stops queued work before publication',async t=>{
  const f=await fixture(t),held=gate(),entered=gate();let hold=true,calls=0;
  const writer=f.build({timeoutMs:100,io:{...fs,realpath:async(...args)=>{calls++;const result=await fs.realpath(...args);if(hold){hold=false;entered.release();await held.promise;}return result;}}});
  const pending=writer.write(f.req,batch(mutation()));const rejected=assert.rejects(pending,{code:'text_collection_sync_native_closed',writeState:'not_started'});
  await entered.promise;const queued=writer.write(f.req,batch(mutation('create',{id:'collection-2',record:full('collection-2')})));
  await Promise.all([rejected,assert.rejects(queued,{code:'text_collection_sync_native_closed',writeState:'not_started'})]);assert.equal(calls,1,'queued retry does not multiply hung filesystem operations');
  held.release();await writer.close();await f.service.write(f.req,batch(mutation('create',{id:'collection-2',record:full('collection-2')})));
  assert.equal((await f.read()).value.revision,1);assert.equal((await f.read()).value.entries[0].id,'collection-2');
});

test('missing and v1 native libraries are not initialized, migrated or replaced from a legacy backend file',async t=>{
  const f=await fixture(t),input=batch(mutation()),legacy=path.join(f.accountRoot,'.qianmu-text-collection-v1.json');await fs.writeFile(legacy,'legacy content must stay untouched');
  await fs.unlink(f.head);const missingFiles=await fs.readdir(f.folder);
  await assert.rejects(f.service.write(f.req,input),{code:'text_collection_sync_native_missing',writeState:'not_started'});assert.deepEqual(await fs.readdir(f.folder),missingFiles);
  await f.seed({...f.initial,version:1});const old=await fs.readFile(f.head);
  await assert.rejects(f.service.write(f.req,input),{code:'text_collection_sync_native_version',writeState:'not_started'});assert.deepEqual(await fs.readFile(f.head),old);
  assert.equal(await fs.readFile(legacy,'utf8'),'legacy content must stay untouched');
});

test('corrupt head, wrong fingerprint, invalid native JSON and foreign original scopes are retained, not repaired',async t=>{
  const f=await fixture(t),input=batch(mutation());
  await fs.writeFile(f.head,'broken head');const broken=await fs.readFile(f.head);
  await assert.rejects(f.service.write(f.req,input),{code:'text_collection_sync_native_content'});assert.deepEqual(await fs.readFile(f.head),broken);
  await f.seed(f.initial);const pointer=JSON.parse(await fs.readFile(f.head,'utf8')),body=path.join(f.folder,`qianmu-v2-${scope}-collections-${pointer.fingerprint}.json`);
  await fs.writeFile(body,JSON.stringify({schema,scope,slot:'collections',value:{...f.initial,migration:{bad:'changed'}}}));
  await assert.rejects(f.service.write(f.req,input),{code:'text_collection_sync_native_content'});
  await f.seed({...f.initial,migration:{bad:'\u0000'}});await assert.rejects(f.service.write(f.req,input),{code:'text_collection_sync_native_content'});
  await f.seed({...f.initial,migration:{bad:'\ud800'}});await assert.rejects(f.service.write(f.req,input),{code:'text_collection_sync_native_content'});
  await f.seed(f.initial);const saved=await f.service.write(f.req,input),state=structuredClone(saved.verified.value);state.entries[0].original.scope='f'.repeat(64);await f.seed(state);
  await assert.rejects(f.service.write(f.req,batch(mutation('edit'))),{code:'text_collection_sync_native_content'});
});

test('native file heads and bodies refuse hard links, and account folder junctions cannot redirect writes',async t=>{
  const f=await fixture(t),input=batch(mutation()),copy=path.join(f.folder,'head-copy.json');await fs.link(f.head,copy);
  await assert.rejects(f.service.write(f.req,input),{code:'text_collection_sync_native_content'});await fs.unlink(copy);
  const moved=path.join(f.accountRoot,'moved-files');await fs.rename(f.folder,moved);await fs.symlink(moved,f.folder,process.platform==='win32'?'junction':'dir');
  await assert.rejects(f.service.write(f.req,input),{code:'text_collection_sync_path'});assert.equal((await fs.readdir(moved)).some(name=>name.includes('-collection-record-')),false);
});

test('client-selected paths, roots, namespaces and accounts cannot reach a filesystem mutation',async t=>{
  const f=await fixture(t),input=batch(mutation()),before=await fs.readdir(f.folder);
  for(const extra of [{path:f.head},{root:f.folder},{namespace},{slot:'other'}])await assert.rejects(f.service.write(f.req,{...input,...extra}),{status:400});
  const foreign='st-user:'+sha('bob');await assert.rejects(f.service.write(f.req,{...input,expectedAccount:foreign,mutations:[{...mutation('delete'),expectedAccount:foreign}]}),{code:'text_collection_sync_account',status:401});
  await assert.rejects(f.service.write({user:{profile:{handle:'alice'},directories:{root:f.root,files:f.folder}}},input),{status:403});
  assert.deepEqual(await fs.readdir(f.folder),before);
});

test('invalid clock rejects before publishing an original or changing the directory',async t=>{
  const f=await fixture(t);await f.service.write(f.req,batch(mutation()));const files=await fs.readdir(f.folder),head=await fs.readFile(f.head);
  await assert.rejects(f.build({now:()=>NaN}).write(f.req,batch(mutation('edit'))),{code:'text_collection_sync_clock',writeState:'not_started'});
  assert.deepEqual(await fs.readdir(f.folder),files);assert.deepEqual(await fs.readFile(f.head),head);
});

test('authenticated routes return exact native contracts and sanitize errors without exposing files or old libraries',async t=>{
  const f=await fixture(t),handlers=new Map(),services=[];
  const router={get:(route,handler)=>handlers.set('GET '+route,handler),post:(route,handler)=>handlers.set('POST '+route,handler)};
  installTextCollectionNativeRoutes(router,{dataRoot:()=>f.root,register:service=>services.push(service),serviceOptions:{now:()=>100}});t.after(()=>Promise.all(services.map(service=>service.close())));
  const call=async(method,route,body,user=f.req.user)=>{const req=Object.assign(new EventEmitter(),{body,user}),res=Object.assign(new EventEmitter(),{
    headers:{},statusCode:200,writableEnded:false,destroyed:false,set(name,value){this.headers[name]=value;return this;},status(code){this.statusCode=code;return this;},json(value){this.value=value;this.writableEnded=true;return this;}});
    await handlers.get(method+' '+route)(req,res);assert.equal(res.headers['Cache-Control'],'no-store');return res;};
  const cap=await call('GET','/text-collections/native-capabilities');nativeCollectionCapabilities(cap.value,expectedAccount);
  const input=batch(mutation()),saved=await call('POST','/text-collections/native-write',input);await verify(saved.value,input);assert.equal(saved.statusCode,200);
  const unauthenticated=await call('POST','/text-collections/native-write',input,null);assert.equal(unauthenticated.statusCode,401);
  assert.deepEqual(Object.keys(unauthenticated.value).sort(),['code','message','ok','version','writeState']);assert.doesNotMatch(JSON.stringify(unauthenticated.value),/alice|\\|private|root/);
  const bad=await call('POST','/text-collections/native-write',{...input,path:f.head});assert.equal(bad.statusCode,400);assert.equal(bad.value.writeState,'not_started');
  assert.equal(handlers.size,2);assert.equal((await fs.readdir(f.accountRoot)).includes('.qianmu-text-collection-v1.json'),false);
});

test('native routes recover the ST data root during the plugin startup boundary',async t=>{
  const f=await fixture(t),handlers=new Map(),services=[];
  const router={get:(route,handler)=>handlers.set('GET '+route,handler),post:(route,handler)=>handlers.set('POST '+route,handler)};
  // A real ST request already contains its authenticated account directories,
  // while DATA_ROOT can still be unset for the first plugin request. The route
  // may derive only the containing root from that host-owned directory.
  installTextCollectionNativeRoutes(router,{dataRoot:()=>undefined,register:service=>services.push(service),serviceOptions:{now:()=>100}});
  t.after(()=>Promise.all(services.map(service=>service.close())));
  const call=async body=>{
    const req=Object.assign(new EventEmitter(),{body,user:f.req.user}),res=Object.assign(new EventEmitter(),{
      headers:{},statusCode:200,writableEnded:false,destroyed:false,set(name,value){this.headers[name]=value;return this;},
      status(code){this.statusCode=code;return this;},json(value){this.value=value;this.writableEnded=true;return this;},
    });
    await handlers.get('POST /text-collections/native-write')(req,res);return res;
  };
  const input=batch(mutation()),saved=await call(input);await verify(saved.value,input);
  assert.equal(saved.statusCode,200);assert.equal(services.length,1);assert.equal((await f.read()).value.revision,1);
});

test('a cold capability probe never poisons the later native write with an unavailable startup root',async t=>{
  const f=await fixture(t),handlers=new Map(),services=[];let ready=false;
  const router={get:(route,handler)=>handlers.set('GET '+route,handler),post:(route,handler)=>handlers.set('POST '+route,handler)};
  installTextCollectionNativeRoutes(router,{dataRoot:()=>ready?f.root:undefined,register:service=>services.push(service),serviceOptions:{now:()=>100}});
  t.after(()=>Promise.all(services.map(service=>service.close())));
  const call=async(method,route,body,user)=>{
    const req=Object.assign(new EventEmitter(),{body,user}),res=Object.assign(new EventEmitter(),{
      headers:{},statusCode:200,writableEnded:false,destroyed:false,set(name,value){this.headers[name]=value;return this;},
      status(code){this.statusCode=code;return this;},json(value){this.value=value;this.writableEnded=true;return this;},
    });
    await handlers.get(method+' '+route)(req,res);return res;
  };
  const coldUser={profile:{handle:'alice'}};
  const cap=await call('GET','/text-collections/native-capabilities',undefined,coldUser);
  nativeCollectionCapabilities(cap.value,expectedAccount);assert.equal(cap.statusCode,200);assert.equal(services.length,0);
  ready=true;const input=batch(mutation()),saved=await call('POST','/text-collections/native-write',input,f.req.user);
  await verify(saved.value,input);assert.equal(saved.statusCode,200);assert.equal(services.length,1);assert.equal((await f.read()).value.revision,1);
});
