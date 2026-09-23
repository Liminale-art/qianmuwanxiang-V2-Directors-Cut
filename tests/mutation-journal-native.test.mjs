import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createNativeMutationJournal} from '../qianmu-mutation-journal-native.js';
import {createNativeHistoricalJournal} from '../qianmu-historical-journal-native.js';
import {createStoryboardPackageJournal} from '../qianmu-storyboard-package-journal.js';
import {createHistoricalChatMutation} from '../qianmu-historical-chat-journal.js';
import {validateMutationBodyReference} from '../qianmu-mutation-journal-body.js';
import {characterNativeFixture,namespace} from './helpers/character-native-fixture.mjs';
import {mappingLegacyFixture} from './helpers/mapping-legacy-fixture.mjs';
import {historicalChatSaveFixture} from './helpers/historical-chat-save-fixture.mjs';
import {createPackageImportFixture} from './helpers/storyboard-package-fixture.mjs';
import {collectRestoreStorage,clearRestoreStorage} from '../qianmu-storyboard-restore-storage.js';
import {runRestoreStorage} from '../qianmu-storyboard-restore-storage-runtime.js';
import {characterWorkerStorageOptions} from '../qianmu-character-worker-storage.js';

const row=(ns=namespace)=>({namespace:ns,chatHash:'c'.repeat(64),fileHash:'a'.repeat(64),version:1,revision:1,createdAt:7,phase:'prepared',
  patch:[{area:'settings',key:'prompt',before:{exists:true,value:'  old 🦋\ntext  '},after:{exists:true,value:'new'}}]});
const headSuffix='-configuration-mutation-journal.json';
function local(value=null){return {value:structuredClone(value),async loadMutation(){return structuredClone(this.value);},loadHistoricalChatMutation:async()=>null,
  list:async()=>[],loadResource:async()=>null,close(){}};}
async function fixture(t,{account=namespace}={}){const f=await characterNativeFixture(t,{account}),journals=[];
  t.after(()=>journals.forEach(j=>j.close()));const open=(legacy=local())=>{const j=createNativeMutationJournal({legacy,createStorage:f.createStorage});journals.push(j);return j;};
  return {...f,openMutation:open,combined:(legacy=local())=>{const j=createNativeHistoricalJournal({legacy:open(legacy),createStorage:f.createStorage});journals.push(j);return j;}};}

test('full before/after values survive independent clients; phase changes reuse original parts',async t=>{
  const f=await fixture(t),a=f.openMutation(),prepared=await a.prepareMutation(row());assert.deepEqual(prepared,row());
  const count=[...f.files.keys()].filter(name=>name.includes('-mutation-journal-part-')).length;
  const applied=await a.updateMutation(prepared,'applied');assert.equal(applied.revision,2);assert.deepEqual(await f.openMutation().loadMutation(namespace),applied);
  assert.equal([...f.files.keys()].filter(name=>name.includes('-mutation-journal-part-')).length,count);assert.ok(!f.calls.some(call=>/plugins|delete|completions/.test(call.path)));
});

test('large Unicode, absent fields and unknown nested configuration survive without native structure limit increases',async t=>{
  const f=await fixture(t),input=row();input.patch[0].before.value='🦋汉字'.repeat(180000);
  input.patch.push({area:'chat',key:'storyboardImages',before:{exists:false},after:{exists:true,value:[{id:'saved',future:{keep:false,zero:0,text:'\u0000'}}]}});
  assert.ok(new Blob([JSON.stringify(input)]).size>1500000);await f.openMutation().prepareMutation(input);
  assert.deepEqual(await f.openMutation().loadMutation(namespace),input);const parts=[...f.files].filter(([name])=>name.includes('-mutation-journal-part-'));assert.ok(parts.length>2);
  for(const [,value] of parts)assert.ok(Buffer.byteLength(value)<512*1024+1024);
});

test('old IDB record is only read, preserved, ended explicitly and not resurrected after another import',async t=>{
  const f=await fixture(t),old=local(row()),a=f.openMutation(old);assert.deepEqual(await a.loadMutation(namespace),row());assert.deepEqual(old.value,row());
  const applied=await a.updateMutation(row(),'applied');await assert.rejects(a.dismissMutation(applied));await a.dismissMutation(applied,{confirmed:true});
  assert.equal(await f.openMutation(local(row())).loadMutation(namespace),null);
  const input={...row(),fileHash:'f'.repeat(64),createdAt:9};await a.prepareMutation(input);assert.deepEqual(await f.openMutation(local(row())).loadMutation(namespace),input);assert.deepEqual(old.value,row());
});

test('distinct and newer old records cannot replace remote pending work',async t=>{
  const f=await fixture(t);await f.openMutation().prepareMutation(row());const before=f.uploads;
  for(const input of [{...row(),fileHash:'f'.repeat(64)},{...row(),phase:'applied',revision:2}]){
    const old=local(input);await assert.rejects(f.openMutation(old).loadMutation(namespace));assert.deepEqual(old.value,input);}
  assert.equal(f.uploads,before);
});

test('non-JSON old configuration is retained and rejected before any lossy native publication',async t=>{
  for(const value of [NaN,undefined,new Date(0),new Array(2),-0]){const f=await fixture(t),input=row();input.patch.push({area:'chat',key:'storyboardImages',before:{exists:false},after:{exists:true,value:[{future:value}]}});
    const old=local(input);await assert.rejects(f.openMutation(old).loadMutation(namespace));assert.equal(f.uploads,0);assert.deepEqual(old.value,input);}
  const f=await fixture(t),remote=row();remote.patch.push({area:'chat',key:'storyboardImages',before:{exists:false},after:{exists:true,value:[{future:null}]}});await f.openMutation().prepareMutation(remote);
  const old=structuredClone(remote);old.patch[1].after.value[0].future=NaN;const writes=f.uploads;await assert.rejects(f.openMutation(local(old)).loadMutation(namespace));assert.equal(f.uploads,writes);
});

test('repeated identical body with deterministic creation time keeps monotonic revisions and valid ending markers',async t=>{
  const f=await fixture(t),input={...row(),createdAt:0},old=local(input),a=f.openMutation(old);let current=await a.loadMutation(namespace),revision=current.revision;
  for(let i=0;i<3;i++){current=await a.updateMutation(current,'applied');await a.dismissMutation(current,{confirmed:true});current=await a.prepareMutation(input);
    assert.ok(current.revision>revision);revision=current.revision;assert.deepEqual(await f.openMutation(local(input)).loadMutation(namespace),current);}
  assert.deepEqual(old.value,input);
});

test('missing or corrupted original part fails closed, not an empty mutation',async t=>{
  for(const corrupt of [false,true]){const f=await fixture(t),a=f.openMutation();await a.prepareMutation(row());
    const name=[...f.files.keys()].find(value=>value.includes('-mutation-journal-part-'));assert.ok(name);if(corrupt)f.files.set(name,f.files.get(name).replace('old','bad'));else f.files.delete(name);
    const before=f.uploads;await assert.rejects(f.openMutation().loadMutation(namespace));assert.equal(f.uploads,before);}
});

test('known missing head, oversized forged references and wrong accounts cannot become empty storage',async t=>{
  const f=await fixture(t),a=f.openMutation();await a.prepareMutation(row());const head=[...f.files.keys()].find(name=>name.endsWith(headSuffix));f.files.delete(head);
  await assert.rejects(a.loadMutation(namespace),/目录缺失/);assert.throws(()=>validateMutationBodyReference({digest:'a'.repeat(64),bytes:65*1048576,parts:[]},'b'.repeat(64)));
  const before=f.calls.length;f.account('st-user:changed');await assert.rejects(f.openMutation().loadMutation(namespace));assert.equal(f.calls.length,before);
});

test('lost native head acknowledgement is readable on reopen and never blindly resubmitted',async t=>{
  const f=await fixture(t);f.hook(call=>{if(call.request.method==='POST'){const {name,data}=JSON.parse(call.request.body);if(name.endsWith(headSuffix)){f.files.set(name,Buffer.from(data,'base64').toString());throw Error('lost reply');}}});
  await assert.rejects(f.openMutation().prepareMutation(row()));f.hook(null);const before=f.uploads;
  assert.deepEqual(await f.openMutation().loadMutation(namespace),row());assert.equal(f.uploads,before);
});

test('legacy edits during preservation and expired scopes stop before head publication',async t=>{
  const f=await fixture(t),old=local(row());let changed=false;f.hook(call=>{if(call.request.method==='POST'&&!changed){changed=true;old.value.patch[0].after.value='late edit';}});
  await assert.rejects(f.openMutation(old).loadMutation(namespace),/本机/);assert.ok(![...f.files.keys()].some(name=>name.endsWith(headSuffix)));f.hook(null);const before=f.uploads;
  await assert.rejects(f.openMutation().prepareMutation(row(),{isCurrent:()=>false}));assert.equal(f.uploads,before);
});

test('caller input capture, stale phase and unconfirmed dismissal preserve current pending record',async t=>{
  const f=await fixture(t),a=f.openMutation(),input=row(),work=a.prepareMutation(input);input.patch[0].after.value='changed';const prepared=await work;assert.deepEqual(prepared,row());
  const applied=await a.updateMutation(prepared,'applied'),before=f.uploads;await assert.rejects(a.updateMutation(prepared,'uncertain'));await assert.rejects(a.dismissMutation(applied));
  assert.equal(f.uploads,before);assert.deepEqual(await f.openMutation().loadMutation(namespace),applied);
});

test('common production factory routes configuration records to ST and keeps old IDB read-only',async t=>{
  const f=await fixture(t),old=mappingLegacyFixture();f.configure();const a=createStoryboardPackageJournal({indexedDB:old.indexedDB,keyRange:old.keyRange});t.after(()=>a.close());
  await a.prepareMutation(row());assert.equal(await a.hasMutation(namespace),true);assert.deepEqual(await f.openMutation().loadMutation(namespace),row());assert.ok(old.state.reads.includes('mutations'));
});

test('production pending checks read only small heads and IDB keys, not full configuration parts',async t=>{
  const f=await fixture(t),old=mappingLegacyFixture();f.configure();const a=createStoryboardPackageJournal({indexedDB:old.indexedDB,keyRange:old.keyRange});t.after(()=>a.close());
  const input=row();input.patch[0].before.value='🦋'.repeat(120000);const prepared=await a.prepareMutation(input);f.reset();
  for(let n=0;n<3;n++)assert.equal(await a.hasMutation(namespace),true);
  assert.ok(!f.calls.some(call=>call.path.includes('-mutation-journal-part-')));assert.equal(f.uploads,0);
  await a.dismissMutation(prepared,{confirmed:true});f.reset();assert.equal(await a.hasMutation(namespace),false);assert.ok(!f.calls.some(call=>call.path.includes('-mutation-journal-part-')));
});

test('configuration and historical-chat pending work exclude each other through the combined native factory',async t=>{
  const h=await historicalChatSaveFixture(t),f=await fixture(t,{account:h.namespace}),a=f.combined(),b=f.combined(),history=await createHistoricalChatMutation(h.proposal);
  await a.prepareMutation(row(h.namespace));await assert.rejects(b.prepareHistoricalChatMutation(history,{confirmed:true}),/待核对/);assert.equal(h.saves,0);
  await a.dismissMutation(await a.loadMutation(h.namespace),{confirmed:true});await b.prepareHistoricalChatMutation(history,{confirmed:true});
  assert.equal(await a.hasMutation(h.namespace),true);await assert.rejects(a.prepareMutation(row(h.namespace)),/原聊天/);assert.equal(h.saves,0);
});

test('historical pending work appearing while configuration parts upload prevents publication and host writes',async t=>{
  const h=await historicalChatSaveFixture(t),f=await fixture(t,{account:h.namespace}),a=f.combined(),b=f.combined(),history=await createHistoricalChatMutation(h.proposal);let entered=false;
  f.hook(async call=>{if(call.request.method==='POST'&&!entered&&JSON.parse(call.request.body).name.includes('-mutation-journal-part-')){entered=true;await b.prepareHistoricalChatMutation(history,{confirmed:true});}});
  await assert.rejects(a.prepareMutation(row(h.namespace)),/原聊天恢复记录已变化/);f.hook(null);assert.equal(await f.openMutation().loadMutation(h.namespace),null);
  assert.deepEqual(await b.loadHistoricalChatMutation(h.namespace),history);assert.equal(h.saves,0);
});

test('configuration pending work appearing while historical parts upload prevents publishing that historical head',async t=>{
  const h=await historicalChatSaveFixture(t),f=await fixture(t,{account:h.namespace}),a=f.combined(),b=f.combined(),history=await createHistoricalChatMutation(h.proposal);let entered=false;
  f.hook(async call=>{if(call.request.method==='POST'&&!entered&&JSON.parse(call.request.body).name.includes('-historical-journal-part-')){entered=true;await b.prepareMutation(row(h.namespace));}});
  await assert.rejects(a.prepareHistoricalChatMutation(history,{confirmed:true}),/配置恢复/);f.hook(null);assert.equal(await a.loadHistoricalChatMutation(h.namespace),null);
  assert.deepEqual(await b.loadMutation(h.namespace),row(h.namespace));assert.equal(h.saves,0);
});

for(const failSave of [false,true])test(`actual import entrance uses native configuration records: ${failSave?'save failure leaves live settings unchanged':'explicit recover and ending retain old originals'}`,async t=>{
  const source=createPackageImportFixture(),f=await fixture(t,{account:source.e.namespace});
  source.modules.storyboardPackageJournal.createStoryboardPackageJournal=()=>f.combined();
  if(failSave)f.hook(call=>call.request.method==='POST'?new Response('{}',{status:503}):null);
  const before=JSON.stringify(source.e.state),file=new Blob([JSON.stringify({type:'qianmu-storyboard',version:6,credentialsIncluded:false,settings:{promptMode:'combined'},chat:{images:[],collections:[]},media:[]})]);
  await source.import(file);
  if(failSave){assert.equal(JSON.stringify(source.e.state),before);assert.equal(source.e.events.length,0);return;}
  assert.equal(source.e.state.promptMode,'combined');assert.equal((await f.openMutation().loadMutation(source.e.namespace)).phase,'applied');assert.equal(source.e.pending,null);
  source.e.choice='2';await source.recover();assert.equal(source.e.state.promptMode,'manual');source.e.choice='3';await source.recover();assert.equal(await f.openMutation().loadMutation(source.e.namespace),null);
});

test('actual manager Worker reads and ends native configuration records without transferring before/after bodies',async t=>{
  const f=await fixture(t);f.configure();await f.combined().prepareMutation(row());t.mock.method(globalThis,'fetch',f.fetchImpl);
  const source=(await readFile(new URL('../qianmu-storyboard-restore-storage-worker.js',import.meta.url),'utf8')).replace(/^import[^\n]*\n/gm,''),posts=[];
  class Worker{listeners={};closed=false;constructor(){const old=mappingLegacyFixture(),self={location:{origin:'https://st.fixture.invalid'},addEventListener:(_,fn)=>{this.handler=fn;},close:()=>{},postMessage:data=>{posts.push(data);queueMicrotask(()=>{if(!this.closed)this.listeners.message({data});});}};
    vm.runInNewContext(source,{self,characterWorkerStorageOptions,createStoryboardPackageJournal:options=>createStoryboardPackageJournal({...options,indexedDB:old.indexedDB,keyRange:old.keyRange}),collectRestoreStorage,
      clearRestoreStorage:options=>clearRestoreStorage({...options,locks:{request:async(_,__,fn)=>fn({})}})});}
    addEventListener(name,fn){this.listeners[name]=fn;}postMessage(data){queueMicrotask(()=>{if(!this.closed)void this.handler({data});});}terminate(){this.closed=true;}}
  const options={namespace,guard:async()=>{},WorkerClass:Worker},summary=await runRestoreStorage('inspect',options);assert.equal(summary.count,1);assert.equal(summary.items[0].kind,'configuration');
  const selected=summary.items.map(({kind,key,fingerprint})=>({kind,key,fingerprint}));assert.equal((await runRestoreStorage('clear',{...options,selected,confirmed:true,recoveryLossAccepted:true})).complete,true);
  assert.equal((await runRestoreStorage('inspect',options)).count,0);assert.doesNotMatch(JSON.stringify(posts),/"patch"|old 🦋|synthetic|Authorization/);
});
