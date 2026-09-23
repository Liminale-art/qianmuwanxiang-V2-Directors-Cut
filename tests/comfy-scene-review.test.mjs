import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createNativeComfySceneStore} from '../qianmu-comfy-scene-native-store.js';
import {createComfySceneCoordinator} from '../qianmu-comfy-lock-runtime.js';
import {COMFY_SCENE_NATIVE_SLOT as slot,validateSceneEvent,validateSceneEventLink,sceneHash} from '../qianmu-comfy-scene-native-contract.js';
import {COMFY_SELECTION_SCHEMA} from '../qianmu-comfy-selection.js';
import {renderComfySceneReview,mountComfySceneReview} from '../qianmu-comfy-scene-view.js';
import {characterNativeFixture,namespace} from './helpers/character-native-fixture.mjs';
import {comfySceneIdbFixture,comfySceneJournalFixture} from './helpers/comfy-scene-idb-fixture.mjs';
import {fakeWebLocks} from './helpers/web-locks-fixture.mjs';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
const scope={namespace,chatKey:'chat',continuityId:'scene',narrativeLayer:'present'};
const lock=id=>({schema:COMFY_SELECTION_SCHEMA,scope,poolKey:'a'.repeat(64),candidateId:id,executionKey:'b'.repeat(64)});
const request=id=>({lock:lock(id),expectedRevision:0,expectedGeneration:0,attemptId:id,ownerId:'page-'+id,token:'private-ticket-'+id,label:{planId:'plan',floor:1,workflowName:id}});
async function fixture(t){
  const f=await characterNativeFixture(t),open=(legacy=comfySceneIdbFixture())=>{
    const local=legacy.open(),journal=comfySceneJournalFixture(),store=createNativeComfySceneStore({legacy:local,journal:journal.open(),createStorage:f.createStorage,now:()=>100});t.after(()=>store.close());return {store,legacy,journal};
  };
  const source=async(id,pending=false)=>{const old=comfySceneIdbFixture(),store=old.open();t.after(()=>store.close());const reserved=await store.reserve(scope,request(id));await store.begin(reserved.receipt);if(!pending)await store.settle(reserved.receipt,'succeeded');return old;};
  const a=open(await source('A'));await a.store.inspect(scope);const b=open(await source('B'));return Object.assign(f,{a,b,open,source});
}
const choice=row=>({heads:row.heads,generation:row.generation,selected:row.branches[0].digest,acknowledged:true});

test('forked sources are individually inspectable and explicitly resolved without deleting old originals or creating receipts',async t=>{
  const f=await fixture(t),snapshot=await f.b.store.review(namespace,'chat');assert.equal(snapshot.rows.length,1);const row=snapshot.rows[0];assert.equal(row.branches.length,2);assert.equal(row.error,'');
  await assert.rejects(f.b.store.inspect(scope),/分叉/);const before=new Map(f.files),result=await f.b.store.resolveSource(scope,choice(row));
  assert.equal(result.view.lock.candidateId,row.branches[0].record.lock.candidateId);assert.equal(result.view.revision,4);assert.equal(result.view.lockRevision,4);assert.equal(result.receipt,undefined);
  const other=f.open();assert.equal((await other.store.inspect(scope)).lock.candidateId,result.view.lock.candidateId);
  const saved=await f.b.store.exportScene(scope);assert.equal(saved.versions.length,3);assert.equal(saved.versions.at(-1).action.type,'resolve');assert.deepEqual(saved.versions.at(-1).before,row.branches);
  for(const [name,body]of before)if(!name.endsWith('-head.json')){const value=JSON.parse(body);if(value.schema!=='qianmu.st-account-head.v1')assert.equal(f.files.get(name),body);}
  assert.equal((await f.b.store.exportJournal(namespace)).claims.length,0);
});

test('a reviewed merge binds every original predecessor, rejects altered evidence and cannot hide unresolved tickets',async t=>{
  const f=await fixture(t),row=(await f.b.store.review(namespace,'chat')).rows[0];await f.b.store.resolveSource(scope,choice(row));const packet=await f.b.store.exportScene(scope),event=packet.versions.at(-1),meta=packet.entry.versions.at(-1);
  await validateSceneEventLink(event,packet.entry,meta);
  const broken=structuredClone(event);broken.before.reverse();await assert.rejects(validateSceneEventLink(broken,packet.entry,{...meta,digest:await sceneHash(broken)}),/前序/);
  const tasks=f.open(await f.source('C',true)),state=(await tasks.store.review(namespace,'chat')).rows[0];f.reset();
  await assert.rejects(tasks.store.resolveSource(scope,choice(state)),/原任务票据/);assert.equal(f.uploads,0);assert.equal((await tasks.store.exportJournal(namespace)).pending,null);
  const tampered=structuredClone(event);tampered.action.acknowledged=false;assert.throws(()=>validateSceneEvent(tampered,namespace),/明确选择/);
});

test('stale and foreign-account confirmations do not change the native scene catalogue',async t=>{
  const f=await fixture(t),row=(await f.b.store.review(namespace,'chat')).rows[0];await f.b.store.resolveSource(scope,choice(row));f.reset();
  await assert.rejects(f.b.store.resolveSource(scope,choice(row)),/确认期间变化/);assert.equal(f.uploads,0);
  f.account('st-user:other');await assert.rejects(f.b.store.resolveSource(scope,choice(row)));assert.equal(f.uploads,0);
});

test('a lost resolution acknowledgement is recovered as the same metadata merge, without choosing again or dropping history',async t=>{
  const f=await fixture(t),row=(await f.b.store.review(namespace,'chat')).rows[0];let lost=false;
  f.hook(call=>{if(call.path==='/api/files/upload'){const {name,data}=JSON.parse(call.request.body),body=Buffer.from(data,'base64').toString('utf8'),value=JSON.parse(body);if(!lost&&value.schema==='qianmu.st-account-head.v1'&&value.slot===slot){lost=true;f.files.set(name,body);throw Error('lost acknowledgement');}}});
  await assert.rejects(f.b.store.resolveSource(scope,choice(row)));f.hook(null);const before=await f.b.store.exportJournal(namespace);assert.equal(before.pending.proposal.kind,'resolve');
  f.reset();await f.b.store.synchronize(namespace);assert.equal(f.uploads,0);assert.equal((await f.b.store.exportScene(scope)).versions.length,3);assert.equal((await f.b.store.exportJournal(namespace)).pending,null);
});

test('account guard loss between confirmation and publication cannot create a resolution original',async t=>{
  const f=await fixture(t),row=(await f.b.store.review(namespace,'chat')).rows[0];f.reset();
  await assert.rejects(f.b.store.resolveSource(scope,choice(row),{guard:async()=>{throw Error('changed');}}),/changed/);assert.equal(f.uploads,0);
});

test('a cleared account can explicitly accept a newly found completed source but does not revive it merely by opening management',async t=>{
  const f=await fixture(t);await f.a.store.clearAccount(namespace,{expectedGeneration:0});const state=await f.b.store.review(namespace,'chat');
  assert.ok(state.rows[0].branches.some(branch=>branch.record===null));await assert.rejects(f.b.store.inspect(scope),/分叉/);
  const row=state.rows[0],empty=row.branches.find(branch=>branch.record===null);await f.b.store.resolveSource(scope,{...choice(row),selected:empty.digest});
  assert.equal((await f.b.store.inspect(scope)).lock,null);assert.equal((await f.b.store.inspect(scope)).generation,1);
});

test('management can inspect and export a pending journal without replay; explicit synchronize retries only the metadata operation',async t=>{
  const f=await characterNativeFixture(t),legacy=comfySceneIdbFixture(),journal=comfySceneJournalFixture(),store=createNativeComfySceneStore({legacy:legacy.open(),journal:journal.open(),createStorage:f.createStorage,now:()=>100});t.after(()=>store.close());
  f.hook(call=>{if(call.path==='/api/files/upload')throw Error('offline');});await assert.rejects(store.reserve(scope,request('A')));f.hook(null);f.reset();
  const review=await store.review(namespace,'chat'),saved=await store.exportJournal(namespace);assert.equal(review.local.pending.id,saved.pending.id);assert.equal(saved.pending.proposal.kind,'reserve');assert.equal(f.uploads,0);
  await store.synchronize(namespace);assert.equal((await store.review(namespace,'chat')).local.pending,null);assert.equal((await store.inspect(scope)).pending,1);assert.ok(f.calls.every(call=>call.path==='/api/files/upload'||call.path.startsWith('/user/files/')));
});

function host(){return {innerHTML:'',onclick:null,contains:()=>true};}
function event(action,row=0,branch=0){const control={disabled:false,dataset:{sceneAction:action,sceneBranch:String(branch)},closest:()=>({dataset:{sceneRow:String(row)}})};return {target:{closest:()=>control},preventDefault(){},stopPropagation(){}};}

test('actual mounted view resolves a completed fork through the guarded coordinator and refreshes the shared state',async t=>{
  const f=await fixture(t),manager=createComfySceneCoordinator({store:f.b.store,resolveNamespace:async()=>namespace,ownerId:'review',locks:fakeWebLocks()}),element=host(),exports=[];
  t.after(()=>manager.close());await mountComfySceneReview({host:element,manager,namespace,chatKey:'chat',current:()=>true,guard:async()=>{},confirm:async()=>true,save:(name,value)=>exports.push({name,value})});
  assert.match(element.innerHTML,/发现不同续场来源/);await element.onclick(event('choose'));assert.doesNotMatch(element.innerHTML,/发现不同续场来源/);assert.match(element.innerHTML,/风格已保存/);
  await element.onclick(event('export'));assert.equal(exports[0].value.versions.at(-1).action.type,'resolve');assert.equal(exports[0].value.scope.chatKey,'chat');
});

test('view escapes source labels, never displays receipt tokens, and disables every branch choice while original tickets remain',async t=>{
  const f=await fixture(t),unsettled=f.open(await f.source('C',true)),snapshot=await unsettled.store.review(namespace,'chat');snapshot.rows[0].branches[0].record.label.workflowName='<img src=x onerror=alert(1)>';
  const html=renderComfySceneReview(snapshot);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img|private-ticket-/);assert.match(html,/查看原任务/);assert.equal([...html.matchAll(/data-scene-action="choose"/g)].length,[...html.matchAll(/data-scene-branch="\d+" disabled/g)].length);
});

test('account change during confirmation blocks selection and download without leaving stale controls busy',async()=>{
  const element=host(),scopeRow={scope,branches:[{digest:'a'.repeat(64),record:null},{digest:'b'.repeat(64),record:null}],heads:['a'.repeat(64),'b'.repeat(64)],blocked:true,generation:0,error:''};let active=true,changes=0,downloads=0;
  const manager={review:async()=>({native:true,rows:[scopeRow]}),resolveSource:async()=>changes++,exportScene:async()=>{active=false;return {};}};
  await mountComfySceneReview({host:element,manager,namespace,chatKey:'chat',current:()=>true,guard:async()=>{if(!active)throw Error('account changed');},confirm:async()=>{active=false;return true;},save:()=>downloads++});
  await element.onclick(event('choose'));assert.equal(changes,0);assert.match(element.innerHTML,/account changed/);assert.match(element.innerHTML,/aria-busy="false"/);
  active=true;await element.onclick(event('export'));assert.equal(downloads,0);
});

test('cancelled source confirmation leaves the complete fork unchanged and rapid second clicks do not duplicate an operation',async()=>{
  const element=host(),row={scope,branches:[{digest:'a'.repeat(64),record:null}],heads:['a'.repeat(64)],blocked:true,generation:0,error:''};let mutations=0,release,confirmations=0;
  const manager={review:async()=>({native:true,rows:[row]}),resolveSource:async()=>mutations++};
  await mountComfySceneReview({host:element,manager,namespace,chatKey:'chat',current:()=>true,guard:async()=>{},confirm:async()=>{confirmations++;return new Promise(resolve=>{release=resolve;});}});
  const first=element.onclick(event('choose'));await new Promise(resolve=>setImmediate(resolve));await element.onclick(event('choose'));assert.equal(confirmations,1);release(false);await first;assert.equal(mutations,0);assert.match(element.innerHTML,/清理后发现旧来源/);
});

test('a failed scene source remains visible beside healthy scenes instead of hiding the whole chat',async t=>{
  const f=await fixture(t),row=(await f.b.store.review(namespace,'chat')).rows[0];await f.b.store.resolveSource(scope,choice(row));
  const target={...scope,continuityId:'healthy'},req=request('healthy');req.lock={...req.lock,scope:target};await f.b.store.reserve(target,req);
  const index=(await f.storage.read(slot)).value,broken=index.entries.find(entry=>entry.scope.continuityId==='scene').versions.at(-1).reference;
  let removed=0;for(const [name]of f.files)if(name.includes('-'+broken.slot+'-')&&name.endsWith('-'+broken.fingerprint+'.json')){f.files.delete(name);removed++;}assert.equal(removed,1);
  const reader=f.open(),review=await reader.store.review(namespace,'chat');assert.equal(review.rows.length,2);assert.ok(review.rows.find(row=>row.scope.continuityId==='scene').error);assert.equal(review.rows.find(row=>row.scope.continuityId==='healthy').error,'');
});

test('actual index entry passes account and page guards into the lazy management module',async()=>{
  const element={hidden:true,isConnected:true,replaceChildren(){}},state={view:'create',source:'comfy'},root={isConnected:true,querySelector:()=>element};let mounted;
  const manager={},runtime={mountComfySceneReview:async options=>{mounted=options;await options.guard();}},context=vm.createContext({root,storyboardState:()=>state,getChatKey:()=> 'chat',storyboardAdmissionEpoch:1,storyboardComfySceneRuntime:async()=>manager,featureRuntime:{load:async key=>key==='imageAdmission'?{resolveImageAccountNamespace:async()=>namespace}:runtime},confirmDialog(){},toast(){},applyQianmuIcons(){}});
  vm.runInContext(section('storyboardShowComfySceneLocks'),context);await context.storyboardShowComfySceneLocks(root);assert.equal(mounted.manager,manager);assert.equal(mounted.namespace,namespace);assert.equal(mounted.chatKey,'chat');
  await context.storyboardShowComfySceneLocks(root);await assert.rejects(mounted.guard(),/页面已切换/);assert.equal(element.hidden,true);
});
