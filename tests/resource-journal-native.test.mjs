import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {createNativeResourceJournal} from '../qianmu-resource-journal-native.js';
import {prepareResourceCheckpoint,advanceResourceCheckpoint} from '../qianmu-resource-journal-contract.js';
import {createStoryboardPackageJournal} from '../qianmu-storyboard-package-journal.js';
import {characterNativeFixture,namespace} from './helpers/character-native-fixture.mjs';
import {mappingLegacyFixture} from './helpers/mapping-legacy-fixture.mjs';
import {collectRestoreStorage,clearRestoreStorage} from '../qianmu-storyboard-restore-storage.js';
import {runRestoreStorage} from '../qianmu-storyboard-restore-storage-runtime.js';
import {characterWorkerStorageOptions} from '../qianmu-character-worker-storage.js';

const descriptor=(kind='characters',source='a')=>({namespace,kind,sourceDigest:source.repeat(64),planDigest:'b'.repeat(64),...(kind==='bundle'?{chatHash:'c'.repeat(64),environmentDigest:'d'.repeat(64),subjectMappingDigest:'e'.repeat(64)}:{})});
function local(row=null){return {row:structuredClone(row),async loadResource(ns,kind='characters'){assert.equal(ns,namespace);return this.row?.kind===kind?structuredClone(this.row):null;},
  list:async()=>[],loadMutation:async()=>null,loadHistoricalChatMutation:async()=>null,close(){}};}
async function fixture(t){const f=await characterNativeFixture(t),journals=[];t.after(()=>journals.forEach(j=>j.close()));
  return {...f,openJournal:(legacy=local(),options={})=>{const j=createNativeResourceJournal({legacy,createStorage:f.createStorage,now:()=>10,...options});journals.push(j);return j;}};}
const headName=kind=>`-resource-journal-${kind}.json`;

test('both resource phases survive independent native clients and never invoke a model or local writer',async t=>{
  const f=await fixture(t),a=f.openJournal();
  for(const kind of ['characters','bundle']){const row=await a.prepareResource(descriptor(kind),{confirmed:true});assert.equal(row.phase,'prepared');
    const b=f.openJournal();assert.deepEqual(await b.loadResource(namespace,kind),row);const next=await b.updateResource(row,'originals');assert.equal(next.revision,2);
    assert.deepEqual(await f.openJournal().loadResource(namespace,kind),next);}
  assert.ok(f.files.size>0);assert.equal(f.calls.some(call=>/delete|plugins|completions/.test(call.path)),false);
});

test('read-only migration retains exact legacy checkpoint and explicit ending does not resurrect it',async t=>{
  const f=await fixture(t),row=prepareResourceCheckpoint(descriptor(),null,null,7),old=local(row),a=f.openJournal(old);
  assert.deepEqual(await a.loadResource(namespace),row);assert.deepEqual(old.row,row);const next=await a.updateResource(row,'originals');
  assert.deepEqual(await f.openJournal(local(row)).loadResource(namespace),next);await assert.rejects(a.dismissResource(next));
  await a.dismissResource(next,{confirmed:true});assert.equal(await f.openJournal(local(row)).loadResource(namespace),null);
  const fresh=await a.prepareResource(descriptor('characters','f'),{confirmed:true});assert.equal(fresh.sourceDigest,'f'.repeat(64));
  assert.deepEqual(await f.openJournal(local(row)).loadResource(namespace),fresh);assert.deepEqual(old.row,row);
});

test('different or edited old record is not silently overwritten by a native winner',async t=>{
  const f=await fixture(t),row=prepareResourceCheckpoint(descriptor(),null,null,7);await f.openJournal(local(row)).loadResource(namespace);
  const before=f.uploads;for(const input of [prepareResourceCheckpoint(descriptor('characters','f'),null,null,8),advanceResourceCheckpoint(row,row,'originals',8)]){
    const old=local(input);await assert.rejects(f.openJournal(old).loadResource(namespace),/不同/);assert.deepEqual(old.row,input);}
  assert.equal(f.uploads,before);
});

test('stale approval, invalid phase and changed bundle mappings reject before advancing',async t=>{
  const f=await fixture(t),a=f.openJournal();await assert.rejects(a.prepareResource(descriptor('bundle')));assert.equal(f.uploads,0);
  const row=await a.prepareResource(descriptor('bundle'),{confirmed:true});await a.updateResource(row,'originals');const before=f.uploads;
  await assert.rejects(a.prepareResource(descriptor('bundle'),{previous:row,confirmed:true}));
  await assert.rejects(a.updateResource(row,'originals'));await assert.rejects(a.updateResource(row,'metadata'));
  const current=await a.loadResource(namespace,'bundle');
  for(const key of ['sourceDigest','chatHash','environmentDigest','subjectMappingDigest'])await assert.rejects(a.prepareResource({...descriptor('bundle'),[key]:'f'.repeat(64)},{previous:current,confirmed:true}));
  assert.equal(f.uploads,before);
});

test('a verified checkpoint can begin a different file only with the exact previous row',async t=>{
  const f=await fixture(t),a=f.openJournal();let row=await a.prepareResource(descriptor(),{confirmed:true});
  for(const phase of ['originals','workflows','metadata','verified'])row=await a.updateResource(row,phase);
  await assert.rejects(a.prepareResource(descriptor('characters','f'),{confirmed:true}));
  const next=await a.prepareResource(descriptor('characters','f'),{previous:row,confirmed:true});assert.equal(next.phase,'prepared');assert.equal(next.revision,row.revision+1);
});

test('wrong account and expired caller scope cannot migrate or write',async t=>{
  const f=await fixture(t),a=f.openJournal(local(prepareResourceCheckpoint(descriptor(),null,null,7)));f.account('st-user:other');
  await assert.rejects(a.loadResource(namespace));assert.equal(f.calls.length,0);f.account(namespace);
  await assert.rejects(f.openJournal().prepareResource(descriptor(),{confirmed:true,isCurrent:()=>false}));assert.equal(f.uploads,0);
});

test('legacy edit during preservation prevents publishing an obsolete checkpoint',async t=>{
  const f=await fixture(t),row=prepareResourceCheckpoint(descriptor(),null,null,7),old=local(row);let changed=false;
  f.hook(call=>{if(call.request.method==='POST'&&!changed){changed=true;old.row=advanceResourceCheckpoint(row,row,'originals',8);}});
  await assert.rejects(f.openJournal(old).loadResource(namespace),/本机/);assert.ok(![...f.files.keys()].some(name=>name.endsWith(headName('characters'))));assert.equal(old.row.phase,'originals');
});

test('missing preserved legacy body and known missing native head are never empty fallback',async t=>{
  const f=await fixture(t),row=prepareResourceCheckpoint(descriptor(),null,null,7),a=f.openJournal(local(row));await a.loadResource(namespace);
  const name=[...f.files.keys()].find(key=>key.includes('-resource-journal-original-'));assert.ok(name);f.files.delete(name);
  await assert.rejects(f.openJournal(local(row)).loadResource(namespace));
  f.files.delete([...f.files.keys()].find(key=>key.endsWith(headName('characters'))));await assert.rejects(a.loadResource(namespace),/目录缺失/);
});

test('lost publication acknowledgement leaves a readable checkpoint without an automatic retry',async t=>{
  const f=await fixture(t);f.hook(call=>{if(call.request.method==='POST'){const {name,data}=JSON.parse(call.request.body);if(name.endsWith(headName('characters'))){f.files.set(name,Buffer.from(data,'base64').toString());throw Error('lost response');}}});
  await assert.rejects(f.openJournal().prepareResource(descriptor(),{confirmed:true}));f.hook(null);const before=f.uploads;
  assert.equal((await f.openJournal().loadResource(namespace)).phase,'prepared');assert.equal(f.uploads,before);
});

test('caller input is captured and close during publication prevents later phases',async t=>{
  const f=await fixture(t),a=f.openJournal(),input=descriptor(),pending=a.prepareResource(input,{confirmed:true});input.sourceDigest='f'.repeat(64);
  assert.equal((await pending).sourceDigest,'a'.repeat(64));const row=await a.loadResource(namespace);
  f.hook(call=>{if(call.request.method==='POST')a.close();});await assert.rejects(a.updateResource(row,'originals'));f.hook(null);
  assert.equal((await f.openJournal().loadResource(namespace)).phase,'prepared');
});

test('default production factory uses native resource journal while old IDB remains read-only',async t=>{
  const f=await fixture(t),old=mappingLegacyFixture();f.configure();const a=createStoryboardPackageJournal({indexedDB:old.indexedDB,keyRange:old.keyRange});t.after(()=>a.close());
  const row=await a.prepareResource(descriptor(),{confirmed:true});assert.deepEqual(await f.openJournal().loadResource(namespace),row);assert.ok(old.state.reads.includes('resources'));
  const b=createStoryboardPackageJournal({native:false,indexedDB:old.indexedDB,keyRange:old.keyRange});t.after(()=>b.close());assert.equal(await b.loadResource(namespace),null);
});

test('restore manager reads both native checkpoints and explicit clearing retains originals',async t=>{
  const f=await fixture(t),j=f.openJournal();for(const kind of ['characters','bundle'])await j.prepareResource(descriptor(kind),{confirmed:true});
  const options={journal:j,namespace,guard:async()=>{},isCurrent:()=>true,locks:{request:async(_,__,fn)=>fn({})}};
  const summary=await collectRestoreStorage(options);assert.equal(summary.count,2);const before=new Set(f.files.keys());
  const selected=summary.items.map(({kind,key,fingerprint})=>({kind,key,fingerprint}));assert.equal((await clearRestoreStorage({...options,selected,confirmed:true,recoveryLossAccepted:true})).complete,true);
  assert.equal((await collectRestoreStorage({...options,journal:f.openJournal()})).count,0);for(const name of before)assert.ok(f.files.has(name));
});

test('actual manager Worker script uses the common native factory and sends only checkpoint summaries',async t=>{
  const f=await fixture(t);f.configure();await f.openJournal().prepareResource(descriptor('bundle'),{confirmed:true});
  t.mock.method(globalThis,'fetch',f.fetchImpl);const source=(await readFile(new URL('../qianmu-storyboard-restore-storage-worker.js',import.meta.url),'utf8')).replace(/^import[^\n]*\n/gm,''),posts=[];
  class Worker{listeners={};closed=false;constructor(){const old=mappingLegacyFixture(),self={location:{origin:'https://st.fixture.invalid'},addEventListener:(_,fn)=>{this.handler=fn;},close:()=>{},postMessage:data=>{posts.push(data);queueMicrotask(()=>{if(!this.closed)this.listeners.message({data});});}};
    vm.runInNewContext(source,{self,characterWorkerStorageOptions,createStoryboardPackageJournal:options=>createStoryboardPackageJournal({...options,indexedDB:old.indexedDB,keyRange:old.keyRange}),collectRestoreStorage,
      clearRestoreStorage:options=>clearRestoreStorage({...options,locks:{request:async(_,__,fn)=>fn({})}})});}
    addEventListener(name,fn){this.listeners[name]=fn;}postMessage(data){queueMicrotask(()=>{if(!this.closed)void this.handler({data});});}terminate(){this.closed=true;}}
  const options={namespace,guard:async()=>{},WorkerClass:Worker},summary=await runRestoreStorage('inspect',options);assert.equal(summary.count,1);assert.equal(summary.items[0].kind,'bundle');
  const selected=summary.items.map(({kind,key,fingerprint})=>({kind,key,fingerprint}));assert.equal((await runRestoreStorage('clear',{...options,selected,confirmed:true,recoveryLossAccepted:true})).complete,true);
  assert.equal((await runRestoreStorage('inspect',options)).count,0);assert.doesNotMatch(JSON.stringify(posts),/"legacy"|"reference"|synthetic|Authorization/);
});
