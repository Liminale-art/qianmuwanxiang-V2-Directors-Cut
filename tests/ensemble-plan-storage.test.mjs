import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createEnsemblePlanStorage as create} from '../qianmu-ensemble-plan-storage.js';
import {ENSEMBLE_RECOVERY_SCHEMA,normalizeEnsembleRecoveryRecord} from '../qianmu-ensemble-record.js';
import {normalizeStoryboardState} from '../qianmu-storyboard.js';
import {prepareConfigRestore} from '../qianmu-config-connections.js';
import {clone,mergeDefaults} from '../qianmu-storyboard-utils.js';
import {streamCheckpointTransport} from './helpers/stream-checkpoint-fixture.mjs';

const scope=()=>({namespace:'st-user:ensemble-storage-test',chatKey:'private-chat',planId:'plan',messageKey:'message',revisionId:'revision'});
const record=(owner=scope(),revision='r1')=>({schema:ENSEMBLE_RECOVERY_SCHEMA,scope:{...owner},selectionRevision:revision,
  shots:[{id:'shot',shotId:'S1',contentHash:'a'.repeat(64),schemeId:'current',revision:'r1',bindingKey:'b'.repeat(64),reason:''}],executionAuthorized:false});
const fixture=()=>{const owner=scope(),transport=streamCheckpointTransport(owner.namespace);let current=true;
  return {owner,transport,record:()=>record(owner),open:()=>create({scope:owner,guard:()=>current,createStorage:transport.createStorage}),stop:()=>{current=false;}};};
const gate=()=>{let resolve;return {promise:new Promise(done=>resolve=done),resolve};};
const uploads=transport=>transport.calls.filter(row=>row.options.method==='POST');
const copy=value=>structuredClone(value);

test('plan record opens lazily, confirms native readback and is available to an independent client',async()=>{
  const f=fixture(),a=await f.open();assert.equal(f.transport.calls.length,0);
  const empty=await a.read();assert.equal(empty.record,null);const saved=await a.save(f.record(),empty);
  assert.equal(saved.persistence,'st-account-file');assert.ok(Object.isFrozen(saved.record.shots[0]));assert.equal(saved.record.executionAuthorized,false);a.close();
  const b=await f.open();assert.deepEqual((await b.read()).record,normalizeEnsembleRecoveryRecord(f.record()));assert.equal(await b.verify(f.record()),true);
  assert.equal(f.transport.files.size,2);assert.ok([...f.transport.files.keys()].every(name=>!name.includes(f.owner.chatKey)&&!name.includes(f.owner.namespace)));
  assert.doesNotMatch([...f.transport.files.values()].join(''),/prompt|apiKey|baseUrl|workflow/);b.close();
});

test('only this plan client can issue an expected revision and stale writers cannot replace a saved plan',async()=>{
  const f=fixture(),a=await f.open(),b=await f.open(),empty=await a.read(),other=await b.read();
  await assert.rejects(a.save(f.record(),copy(empty)),/先核对/);await assert.rejects(a.save(f.record(),other),/先核对/);
  await a.save(f.record(),empty);const before=uploads(f.transport).length;
  await assert.rejects(b.save(record(f.owner,'r2'),other),{code:'st_account_storage_conflict'});
  assert.equal(uploads(f.transport).length,before);assert.equal(await a.verify(f.record()),true);a.close();b.close();
});

test('changed selection saves against a confirmed prior version and retains the old immutable body',async()=>{
  const f=fixture(),store=await f.open(),first=await store.save(f.record(),await store.read()),keys=[...f.transport.files.keys()];
  const next=record(f.owner,'r2');await store.save(next,first);assert.ok(keys.every(key=>f.transport.files.has(key)));assert.equal(f.transport.files.size,3);
  await assert.rejects(store.verify(f.record()),/尚未确认/);assert.equal(await store.verify(next),true);
  const current=await store.read(),count=uploads(f.transport).length;await store.save(next,current);assert.equal(uploads(f.transport).length,count,'identical data is confirmed without uploading again');store.close();
});

test('plan, revision, chat and message are separate exact storage slots',async()=>{
  const f=fixture(),store=await f.open();await store.save(f.record(),await store.read());
  for(const key of ['planId','revisionId','chatKey','messageKey']){
    const other=await create({scope:{...f.owner,[key]:'other'},guard:()=>true,createStorage:f.transport.createStorage});
    assert.equal((await other.read()).exists,false);await assert.rejects(other.verify(f.record()),/不属于/);other.close();
  }store.close();
});

test('invalid or executable records, wrong scopes and unknown data do not upload',async()=>{
  const f=fixture(),store=await f.open(),empty=await store.read();
  for(const change of [r=>r.executionAuthorized=true,r=>r.apiKey='untrusted',r=>r.scope.chatKey='other',r=>r.schema='future',r=>r.shots=[]]){
    const value=f.record();change(value);await assert.rejects(store.save(value,empty));
  }assert.equal(uploads(f.transport).length,0);store.close();
});

test('save does not resolve until the final native body readback completes',async()=>{
  const f=fixture(),store=await f.open(),empty=await store.read(),held=gate(),entered=gate();let commits=0,completed=false;
  f.transport.hook=async({path,options})=>{if(path==='/api/files/upload')commits++;else if(commits===2){entered.resolve();await held.promise;}};
  const pending=store.save(f.record(),empty).then(()=>{completed=true;});await entered.promise;assert.equal(completed,false);held.resolve();await pending;assert.equal(completed,true);store.close();
});

test('lost upload acknowledgement remains unconfirmed with no implicit retry or fallback',async()=>{
  const f=fixture(),store=await f.open(),empty=await store.read();f.transport.hook=({path})=>{if(path==='/api/files/upload')throw Error('lost acknowledgement');};
  await assert.rejects(store.save(f.record(),empty),error=>error.writeState==='unconfirmed');assert.equal(uploads(f.transport).length,1);store.close();
});

test('changing source or account during readback rejects the save and keeps committed data',async()=>{
  for(const mode of ['source','account','close','scope']){
    const f=fixture(),store=await f.open(),empty=await store.read();let posts=0;
    f.transport.hook=({path,options,files,json})=>{if(path==='/api/files/upload'&&++posts===2){const {name,data}=JSON.parse(options.body);files.set(name,Buffer.from(data,'base64').toString('utf8'));
      if(mode==='source')f.stop();if(mode==='account')f.transport.namespace='st-user:other';if(mode==='close')store.close();if(mode==='scope')f.owner.planId='new';return json({path:`/user/files/${name}`});}};
    await assert.rejects(store.save(f.record(),empty));assert.equal(f.transport.files.size,2);store.close();
  }
});

test('bad setup, a promised guard and a different native account are rejected before file requests',async()=>{
  for(const guard of [undefined,()=>false,async()=>true,()=>Promise.reject(Error('late'))]){
    const f=fixture();await assert.rejects(create({scope:f.owner,guard,createStorage:f.transport.createStorage}));assert.equal(f.transport.calls.length,0);
  }
  const f=fixture();f.transport.namespace='st-user:other';await assert.rejects(f.open(),/账户不一致/);assert.equal(f.transport.calls.length,0);
});

test('login failure never falls back to cached records or a successful save flag',async()=>{
  const f=fixture(),store=await f.open();await store.save(f.record(),await store.read());f.transport.hook=({json})=>json({},401);
  await assert.rejects(store.verify(f.record()),{code:'st_account_storage_account'});assert.equal(f.transport.files.size,2);store.close();
});

test('future, malformed and foreign native bodies remain untouched',async()=>{
  for(const mode of ['future','null','foreign']){
    const f=fixture(),store=await f.open();await store.save(f.record(),await store.read());const native=await f.transport.createStorage();
    const head=[...f.transport.files.values()].map(value=>JSON.parse(value)).find(row=>row.schema==='qianmu.st-account-head.v1');
    await native.update(head.slot,value=>{if(mode==='null')return null;if(mode==='future')value.schema='future';if(mode==='foreign')value.scope.messageKey='different';return value;});
    const posts=uploads(f.transport).length;await assert.rejects(store.read());await assert.rejects(store.verify(f.record()));assert.equal(uploads(f.transport).length,posts);native.close();store.close();
  }
});

test('unverified persistence receipts cannot confirm a save',async()=>{
  const owner=scope();let value=null;
  const store=await create({scope:owner,guard:()=>true,createStorage:async()=>({namespace:owner.namespace,close(){},
    read:async()=>({exists:false,value:null,fingerprint:null,persistence:'st-account-file',concurrency:'optimistic-non-cas'}),
    write:async(_slot,next)=>{value=next;return {exists:true,value,fingerprint:'a'.repeat(64),persistence:'memory',concurrency:'optimistic-non-cas'};}})});
  await assert.rejects(store.save(record(owner),await store.read()),error=>error.code==='ensemble_plan_storage'&&error.writeState==='unconfirmed');store.close();
});

test('plan normalization keeps exact recovery data and invalid required markers across repeated normalization',()=>{
  const normalized=normalizeStoryboardState({shotPlans:[{id:'plan',chatKey:'private-chat',ensembleRecovery:record()}]}).shotPlans[0];
  assert.deepEqual(normalized.ensembleRecovery,normalizeEnsembleRecoveryRecord(record()));
  for(const value of [null,{},record(scope(),'bad revision'),{...record(),schema:'future'}]){
    let plan={id:'plan',ensembleRecovery:value};for(let i=0;i<2;i++)plan=normalizeStoryboardState({shotPlans:[plan]}).shotPlans[0];
    assert.equal(plan.ensembleRecovery.invalid,true);assert.equal(plan.ensembleRecovery.executionAuthorized,false);
  }
  assert.equal(Object.hasOwn(normalizeStoryboardState({shotPlans:[{id:'legacy'}]}).shotPlans[0],'ensembleRecovery'),false);
});

test('actual lightweight summary, archive export and config restore retain descriptive recovery without granting execution',async()=>{
  const source=await readFile(new URL('../index.js',import.meta.url),'utf8');
  const summaryCode=source.slice(source.indexOf('function storyboardPlanLightweightSummary('),source.indexOf('async function storyboardArchiveShotPlans('));
  const summarize=Function('clone',summaryCode+';return storyboardPlanLightweightSummary;')(clone);
  const plan=normalizeStoryboardState({shotPlans:[{id:'plan',chatKey:'private-chat',status:'completed',ensembleRecovery:record(),shots:[{id:'shot',prompt:'private prompt'}]}]}).shotPlans[0];
  const summary=summarize(plan,'archive');assert.deepEqual(summary.ensembleRecovery,plan.ensembleRecovery);assert.equal(summary.shots[0].prompt,'');
  assert.deepEqual(normalizeStoryboardState({shotPlans:[summary]}).shotPlans[0].ensembleRecovery,plan.ensembleRecovery);
  const prepared=prepareConfigRestore({imagegen:{shotPlans:[summary]}},{},{},true,{clone,mergeDefaults,normalizeStoryboardState});
  assert.deepEqual(prepared.imagegen.shotPlans[0].ensembleRecovery,plan.ensembleRecovery);assert.equal(Object.hasOwn(prepared.imagegen.shotPlans[0],'archiveRef'),false);
  const exportCode=source.slice(source.indexOf('async function storyboardPlansForPortableExport('),source.indexOf('async function storyboardDeletePlanArchives('));
  const cache=new Map([['archive',copy(plan)]]),exportPlans=Function('clone','storyboardPlanArchiveCache','blobStore',exportCode+';return storyboardPlansForPortableExport;')(clone,cache,{blobStoreAvailable:()=>false});
  const newer=normalizeEnsembleRecoveryRecord(record(scope(),'r2'));summary.ensembleRecovery=newer;
  const [exported]=await exportPlans([summary],{strict:true});assert.deepEqual(exported.ensembleRecovery,newer);assert.equal(exported.shots[0].prompt,'private prompt');assert.equal(Object.hasOwn(exported,'archiveRef'),false);
  assert.equal(cache.get('archive').ensembleRecovery.selectionRevision,'r1','portable export must not overwrite the historical original');
});
