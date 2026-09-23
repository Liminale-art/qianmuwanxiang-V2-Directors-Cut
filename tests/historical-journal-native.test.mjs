import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeHistoricalJournal} from '../qianmu-historical-journal-native.js';
import {createStAccountStorage,configureStAccountStorage,captureStAccountStorageWorkerContext} from '../qianmu-st-account-storage.js';
import {createHistoricalChatMutation,historicalChatMutationNext} from '../qianmu-historical-chat-journal.js';
import {historicalChatSaveFixture,consent,gate} from './helpers/historical-chat-save-fixture.mjs';
import {collectRestoreStorage,clearRestoreStorage} from '../qianmu-storyboard-restore-storage.js';
import {runRestoreStorage} from '../qianmu-storyboard-restore-storage-runtime.js';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createStoryboardPackageJournal} from '../qianmu-storyboard-package-journal.js';
import {characterWorkerStorageOptions} from '../qianmu-character-worker-storage.js';

// Real native-file protocol/client; deterministic in-memory ST HTTP transport.
// Independent clients are not a claim of real two-device/browser acceptance.
async function fixture(t){
  const f=await historicalChatSaveFixture(t),files=new Map(),calls=[],journals=[];let namespace=f.namespace,current=true,hook=null;
  const config={origin:'https://st.fixture.invalid',resolveNamespace:async()=>namespace,isCurrent:()=>current,
    headers:()=>({'X-CSRF-Token':'fixture-csrf',Authorization:'PRIVATE_KEY','x-api-key':'PRIVATE_KEY'}),fetchImpl:async(url,request)=>{
      const path=new URL(url).pathname;calls.push({url,request});const altered=await hook?.({path,request,files});if(altered)return altered;
      if(path==='/api/files/upload'){const {name,data}=JSON.parse(request.body);files.set(name,Buffer.from(data,'base64').toString('utf8'));return Response.json({path:'/user/files/'+name});}
      assert.match(path,/^\/user\/files\/qianmu-v2-/);const value=files.get(path.split('/').at(-1));return value===undefined?Response.json({}, {status:404}):new Response(value,{headers:{'content-type':'application/json'}});
    }};
  const makeLegacy=(row=null)=>({row:structuredClone(row),other:null,deleted:0,closed:false,
    async loadHistoricalChatMutation(){return structuredClone(this.row);},async loadMutation(){return this.other;},
    list:async()=>[],loadResource:async()=>null,async prepareMutation(value){this.other=value;return value;},
    close(){this.closed=true;}});
  const open=(legacy=makeLegacy(),options={})=>{const journal=createNativeHistoricalJournal({legacy,createStorage:args=>createStAccountStorage({...config,...args}),...options});journals.push(journal);return journal;};
  t.after(()=>journals.forEach(journal=>journal.close()));
  return Object.assign(f,{files,nativeCalls:calls,config,open,makeLegacy,setAccount:value=>namespace=value,setCurrent:value=>current=value,setHook:value=>hook=value,
    row:await createHistoricalChatMutation(f.proposal,{now:()=>7}),uploads:()=>calls.filter(call=>call.request.method==='POST')});
}

test('native pending rows survive independent clients; phases reuse immutable proposal blocks',async t=>{
  const f=await fixture(t),a=f.open(),prepared=await a.prepareHistoricalChatMutation(f.row,{confirmed:true});
  assert.deepEqual(prepared,f.row);assert.equal(a.persistence,'st-account-file');assert.equal(a.concurrency,'optimistic-non-cas');a.close();
  const b=f.open();assert.deepEqual(await b.loadHistoricalChatMutation(f.namespace),f.row);
  const count=f.uploads().filter(call=>JSON.parse(call.request.body).name.includes('-part-')).length;
  const submitted=await b.updateHistoricalChatMutation(f.row,'submitted');assert.equal(submitted.revision,2);
  assert.equal(f.uploads().filter(call=>JSON.parse(call.request.body).name.includes('-part-')).length,count);
  assert.deepEqual(await f.open().loadHistoricalChatMutation(f.namespace),submitted);
  for(const {url,request} of f.nativeCalls){assert.ok(url.startsWith(f.config.origin));assert.equal(request.headers.Authorization,undefined);assert.equal(request.headers['x-api-key'],undefined);assert.equal(request.headers['X-CSRF-Token'],'fixture-csrf');assert.ok(!url.includes('/api/plugins/'));}
  assert.doesNotMatch([...f.files.values()].join(''),/PRIVATE_HISTORY|PRIVATE_KEY|PRIVATE_VOICE/);assert.equal(f.saves,0);
});

test('large existing proposals are split without dropping Unicode or raising native structure limits',async t=>{
  const f=await fixture(t),proposal=structuredClone(f.proposal);
  for(const value of [proposal.before,proposal.after])value.storyboardImages[0].futureText='🦋'.repeat(270000);
  const row=await createHistoricalChatMutation(proposal),a=f.open();assert.ok(Buffer.byteLength(JSON.stringify(row))>2*1048576);
  await a.prepareHistoricalChatMutation(row,{confirmed:true});a.close();assert.deepEqual(await f.open().loadHistoricalChatMutation(f.namespace),row);
  const partBodies=[...f.files.values()].map(text=>JSON.parse(text)).filter(row=>row.value?.schema==='qianmu.historical-chat-journal-part.v1');
  const head=[...f.files.values()].map(text=>JSON.parse(text)).find(row=>row.value?.schema==='qianmu.historical-chat-journal.v1');
  assert.ok(head.value.reference.parts.length>10);assert.ok(partBodies.length>=3);for(const row of partBodies)assert.ok(Buffer.byteLength(JSON.stringify(row))<512*1024);
});

test('same-account legacy record is copied and read back without deleting local recovery',async t=>{
  const f=await fixture(t),legacy=f.makeLegacy(f.row),a=f.open(legacy);
  assert.deepEqual(await a.loadHistoricalChatMutation(f.namespace),f.row);assert.deepEqual(legacy.row,f.row);
  a.close();assert.deepEqual(await f.open().loadHistoricalChatMutation(f.namespace),f.row);assert.equal(legacy.deleted,0);
});

test('explicit ending is a retained tombstone and does not resurrect the old local copy on later imports',async t=>{
  const f=await fixture(t),legacy=f.makeLegacy(f.row),a=f.open(legacy);await a.loadHistoricalChatMutation(f.namespace);
  await assert.rejects(a.dismissHistoricalChatMutation(f.row));assert.equal(await a.dismissHistoricalChatMutation(f.row,{confirmed:true}),true);
  assert.equal(await f.open(f.makeLegacy(f.row)).loadHistoricalChatMutation(f.namespace),null);assert.deepEqual(legacy.row,f.row);
  const next=await createHistoricalChatMutation({...f.proposal,fileHash:'b'.repeat(64)},{now:()=>9});await a.prepareHistoricalChatMutation(next,{confirmed:true});
  assert.deepEqual(await f.open(f.makeLegacy(f.row)).loadHistoricalChatMutation(f.namespace),next);
  await a.dismissHistoricalChatMutation(next,{confirmed:true});assert.equal(await a.hasMutation(f.namespace),false);
  await a.prepareMutation({namespace:f.namespace,marker:'new-import'});assert.equal(legacy.other.marker,'new-import');
  assert.equal(f.nativeCalls.filter(call=>/delete/i.test(call.url)).length,0);assert.equal(f.saves,0);
});

test('distinct local or newer legacy pending work is never replaced by a remote winner',async t=>{
  const f=await fixture(t);await f.open().prepareHistoricalChatMutation(f.row,{confirmed:true});const count=f.uploads().length;
  for(const local of [await createHistoricalChatMutation({...f.proposal,fileHash:'c'.repeat(64)}),historicalChatMutationNext(f.row,'submitted',9)]){
    const legacy=f.makeLegacy(local);await assert.rejects(f.open(legacy).loadHistoricalChatMutation(f.namespace));assert.deepEqual(legacy.row,local);
  }
  assert.equal(f.uploads().length,count);
});

test('stale revision, implicit prepare and other pending mutation stop before overwriting',async t=>{
  const f=await fixture(t),a=f.open(),b=f.open();await assert.rejects(a.prepareHistoricalChatMutation(f.row));assert.equal(f.uploads().length,0);
  await a.prepareHistoricalChatMutation(f.row,{confirmed:true});await b.updateHistoricalChatMutation(f.row,'submitted');const count=f.uploads().length;
  await assert.rejects(a.updateHistoricalChatMutation(f.row,'verified'));await assert.rejects(a.dismissHistoricalChatMutation(f.row,{confirmed:true}));
  await assert.rejects(a.prepareMutation({namespace:f.namespace}));assert.equal(f.uploads().length,count);
  const g=await fixture(t),legacy=g.makeLegacy();legacy.other={namespace:g.namespace};await assert.rejects(g.open(legacy).prepareHistoricalChatMutation(g.row,{confirmed:true}));assert.equal(g.uploads().length,0);
});

test('wrong account and expired current-page guards cannot read or migrate a record',async t=>{
  const f=await fixture(t),a=f.open(f.makeLegacy(f.row));f.setAccount('st-user:bob');await assert.rejects(a.loadHistoricalChatMutation(f.namespace));assert.equal(f.nativeCalls.length,0);
  f.setAccount(f.namespace);const b=f.open();await assert.rejects(b.prepareHistoricalChatMutation(f.row,{confirmed:true,isCurrent:()=>false}));assert.equal(f.nativeCalls.length,0);
});

test('missing/corrupted block fails closed, never becomes an empty journal',async t=>{
  for(const corrupt of [false,true]){
    const f=await fixture(t);await f.open().prepareHistoricalChatMutation(f.row,{confirmed:true});
    const key=[...f.files].find(([,text])=>JSON.parse(text).value?.schema==='qianmu.historical-chat-journal-part.v1')[0];
    corrupt?f.files.set(key,f.files.get(key).replace('storyboardImages','storyboardImagEs')):f.files.delete(key);
    const count=f.uploads().length;await assert.rejects(f.open().loadHistoricalChatMutation(f.namespace));assert.equal(f.uploads().length,count);
  }
});

test('head acknowledgement loss retains work and a new client can inspect it without resubmission',async t=>{
  const f=await fixture(t);f.setHook(({path,request,files})=>{
    if(path==='/api/files/upload'){const value=JSON.parse(request.body);if(value.name.endsWith('-historical-chat-journal.json')){files.set(value.name,Buffer.from(value.data,'base64').toString());throw Error('lost response');}}
  });
  await assert.rejects(f.open().prepareHistoricalChatMutation(f.row,{confirmed:true}));f.setHook(null);const count=f.uploads().length;
  assert.deepEqual(await f.open().loadHistoricalChatMutation(f.namespace),f.row);assert.equal(f.uploads().length,count);
});

test('close during a pending write stops late phases and preserves the legacy original',async t=>{
  const f=await fixture(t),entered=gate(),held=gate(),legacy=f.makeLegacy(f.row),a=f.open(legacy);
  f.setHook(async({path})=>{if(path==='/api/files/upload'){entered.release();await held.promise;return Response.json({},{status:503});}});
  const work=a.loadHistoricalChatMutation(f.namespace);await entered.promise;a.close();await assert.rejects(work);held.release();
  await new Promise(resolve=>setTimeout(resolve,5));assert.deepEqual(legacy.row,f.row);assert.equal(f.uploads().length,1);assert.equal(f.saves,0);
});

test('actual native save stage journals before host writes, and second client recovers by fresh readback only',async t=>{
  const f=await fixture(t),journal=f.open(),before=structuredClone(f.store);
  f.host=async()=>{const row=await f.open().loadHistoricalChatMutation(f.namespace);assert.equal(row.phase,'submitted');await f.persist();};
  const session=f.open; // journal factory and host fixture open are deliberately separate.
  const {createHistoricalChatSaveSession}=await import('../qianmu-historical-chat-save.js');
  const a=createHistoricalChatSaveSession({...f.options(),journal}),result=await a.save(f.proposal,consent);a.close();
  assert.equal(result.status,'saved');assert.equal(result.durableJournal,true);assert.equal(f.saves,1);assert.notDeepEqual(f.store,before);
  const b=createHistoricalChatSaveSession({...f.options(),journal:session()});t.after(()=>b.close());
  assert.equal((await b.recover()).status,'saved');assert.equal(f.saves,1);
});

test('native journal failure prevents the existing host writer from changing live metadata',async t=>{
  const f=await fixture(t),before=structuredClone(f.store);f.setHook(({path})=>path==='/api/files/upload'?Response.json({}, {status:503}):null);
  const {createHistoricalChatSaveSession}=await import('../qianmu-historical-chat-save.js'),a=createHistoricalChatSaveSession({...f.options(),journal:f.open()});t.after(()=>a.close());
  await assert.rejects(a.save(f.proposal,consent));assert.deepEqual(f.store,before);assert.equal(f.saves,0);
});

test('restore manager sees the account record and ending only changes its journal head',async t=>{
  const f=await fixture(t),journal=f.open();await journal.prepareHistoricalChatMutation(f.row,{confirmed:true});
  const options={journal,namespace:f.namespace,guard:async()=>{},isCurrent:()=>true,locks:{request:async(_,__,run)=>run({})}};
  const summary=await collectRestoreStorage(options);assert.equal(summary.count,1);assert.equal(summary.items[0].kind,'historical-chat');
  const selected=summary.items.map(({kind,key,fingerprint})=>({kind,key,fingerprint})),before=structuredClone(f.store);
  assert.equal((await clearRestoreStorage({...options,selected,confirmed:true,recoveryLossAccepted:true})).complete,true);
  assert.equal((await collectRestoreStorage({...options,journal:f.open()})).count,0);assert.deepEqual(f.store,before);assert.equal(f.saves,0);
});

test('manager Worker handoff only contains current ST account/origin/CSRF and rechecks identity',async t=>{
  const f=await fixture(t);configureStAccountStorage(f.config);
  assert.deepEqual(await captureStAccountStorageWorkerContext(),{namespace:f.namespace,origin:f.config.origin,csrf:'fixture-csrf'});
  let payload,terminated=0;
  class Worker {listeners={};addEventListener(name,fn){this.listeners[name]=fn;}terminate(){terminated++;}postMessage(value){payload=value;queueMicrotask(()=>this.listeners.message({data:{id:value.id,result:{version:1,status:'ready',namespace:f.namespace,bytes:0,count:0,items:[]}}}));}}
  await runRestoreStorage('inspect',{namespace:f.namespace,guard:async()=>{},WorkerClass:Worker});
  assert.deepEqual(payload.nativeHistory,{namespace:f.namespace,origin:f.config.origin,csrf:'fixture-csrf'});assert.doesNotMatch(JSON.stringify(payload),/PRIVATE_KEY|Authorization/);assert.equal(terminated,1);
  f.setAccount('st-user:other');await assert.rejects(runRestoreStorage('inspect',{namespace:f.namespace,guard:async()=>{},WorkerClass:Worker}));assert.equal(terminated,1);
});

test('default main factory selects native journal while explicit legacy workers remain isolated',async t=>{
  const f=await fixture(t);configureStAccountStorage(f.config);
  const a=createStoryboardPackageJournal();assert.equal(a.persistence,'st-account-file');a.close();
  const b=createStoryboardPackageJournal({native:false});assert.equal(b.persistence,undefined);b.close();assert.equal(f.uploads().length,0);
});

test('real manager Worker script inspects and ends the native row without sending raw proposals to its main thread',async t=>{
  t.mock.method(globalThis,'fetch',(...args)=>configFetch(...args));let configFetch;
  const f=await fixture(t);configureStAccountStorage(f.config);await f.open().prepareHistoricalChatMutation(f.row,{confirmed:true});
  const source=(await readFile(new URL('../qianmu-storyboard-restore-storage-worker.js',import.meta.url),'utf8')).replace(/^import[^\n]*\n/gm,''),posts=[];
  class Worker{
    listeners={};handler=null;closed=false;
    constructor(){
      const self={location:{origin:f.config.origin},addEventListener:(_,fn)=>{this.handler=fn;},close:()=>{},postMessage:data=>{posts.push(data);queueMicrotask(()=>{if(!this.closed)this.listeners.message({data});});}};
      configFetch=f.config.fetchImpl;
      vm.runInNewContext(source,{self,characterWorkerStorageOptions,createStoryboardPackageJournal:({native})=>{assert.ok(native.createStorage);return f.open(f.makeLegacy(),native);},
        createStAccountStorage:options=>createStAccountStorage({...f.config,...options}),collectRestoreStorage,clearRestoreStorage:options=>clearRestoreStorage({...options,locks:{request:async(_,__,fn)=>fn({})}})});
    }
    addEventListener(name,fn){this.listeners[name]=fn;}postMessage(data){queueMicrotask(()=>{if(!this.closed)void this.handler({data});});}terminate(){this.closed=true;}
  }
  const options={namespace:f.namespace,guard:async()=>{},WorkerClass:Worker},summary=await runRestoreStorage('inspect',options);
  assert.equal(summary.count,1);assert.equal(summary.items[0].kind,'historical-chat');
  const selected=summary.items.map(({kind,key,fingerprint})=>({kind,key,fingerprint}));
  assert.equal((await runRestoreStorage('clear',{...options,selected,confirmed:true,recoveryLossAccepted:true})).complete,true);
  assert.equal((await runRestoreStorage('inspect',options)).count,0);assert.equal(f.saves,0);
  assert.doesNotMatch(JSON.stringify(posts),/storyboardImages|characterDrafts|PRIVATE_|original extension|"proposal"/);
});

test('legacy edit during migration prevents publication of an obsolete head',async t=>{
  const f=await fixture(t),legacy=f.makeLegacy(f.row);let changed=false;
  f.setHook(({path})=>{if(path==='/api/files/upload'&&!changed){changed=true;legacy.row=historicalChatMutationNext(f.row,'submitted',10);}});
  await assert.rejects(f.open(legacy).loadHistoricalChatMutation(f.namespace));
  assert.ok(![...f.files.keys()].some(key=>key.endsWith('-historical-chat-journal.json')));assert.equal(legacy.row.phase,'submitted');assert.equal(f.saves,0);
});

test('caller mutations cannot redirect a queued journal prepare',async t=>{
  const f=await fixture(t),row=structuredClone(f.row),a=f.open(),work=a.prepareHistoricalChatMutation(row,{confirmed:true});row.proposal.target.avatar='Elsewhere.png';
  assert.deepEqual(await work,f.row);assert.deepEqual(await f.open().loadHistoricalChatMutation(f.namespace),f.row);
});

test('actual historical import entrance lets exact pending recovery reach the coordinator but blocks other imports',async()=>{
  const source=(await readFile(new URL('../qianmu-historical-import-runtime.js',import.meta.url),'utf8')).replace('export async function','async function');
  let previews=0,coordinators=0,other=false,notices=[];const state={shotPlans:[]},store={},parent={classList:{contains:()=>true}};
  const journal={assertNoHistoricalChatMutation(){assert.fail('own pending recovery must not be blocked');},loadMutation:async()=>other?{}:null,close(){}};
  const modules={storyboardPackageAssets:{createStoryboardPackageGuard:async()=>({namespace:'st-user:alice',guard:async()=>{}})},imageAdmission:{resolveImageAccountNamespace:async()=> 'st-user:alice'},
    storyboardPackageJournal:{createStoryboardPackageJournal:()=>journal},historicalRestore:{createHistoricalRestore:()=>{coordinators++;return {preview:async()=>{previews++;return {mode:'recovery'};},close(){}};}},
    historicalRestoreView:{openHistoricalRestoreReview:({connect})=>({isOpen:true,close(){},finished:connect().then(async value=>{assert.equal((await value.preview()).mode,'recovery');value.close();return {};})})}};
  const context=vm.createContext({document:{getElementById:()=>parent},navigator:{locks:{request:async(_,__,fn)=>fn({})}}});vm.runInContext(source,context);
  const base=()=>({state,store,chatKey:'chat',epoch:0}),host=()=>({saveMetadata(){}}),transfer={busy:false};base.release=()=>{};
  const args=[base,host,transfer,{busy:false},'modal',()=>false,()=>0,{load:async key=>modules[key]},()=>{},()=>{},()=>{},message=>notices.push(message)];
  await context.importHistoricalStoryboardBundle(new Blob(),args);assert.equal(coordinators,1);assert.equal(previews,1);assert.equal(transfer.busy,false);assert.equal(notices.length,0);
  other=true;await context.importHistoricalStoryboardBundle(new Blob(),args);assert.equal(coordinators,1);assert.match(notices[0],/其他分镜导入记录/);assert.equal(transfer.busy,false);
});
