import test from 'node:test';
import assert from 'node:assert/strict';
import {beginWorldAutomaticAttempt as begin,verifySavedWorldAutomaticApproval as verify,prepareAutomaticWorldShot as prepare} from '../qianmu-world-automatic.js';
import {streamCheckpointTransport} from './helpers/stream-checkpoint-fixture.mjs';
import {normalizeStoryboardShotSpec,createStoryboardDefaults,normalizeStoryboardState,storyboardAutomaticJobEnabled as enabled} from '../qianmu-storyboard.js';
const namespace='st-user:world-runtime',source={schema:'qianmu.world-source.v1',chatKey:'chat',revisionId:'wrev-'+'a'.repeat(64),field:'world_updates',itemId:'witem-'+'b'.repeat(64)};
const shot=()=>normalizeStoryboardShotSpec({subject:'garden',promptAtoms:{global:['garden, soft light']},characters:[{id:'a',name:'Alice',identity:['silver hair'],temporaryState:['no coat']}]});
const values=s=>({tags:{global:'garden, soft light',negative:'blur',characters:s.characters.map(row=>({character_id:row.id,positive:'silver hair, no coat'}))}});
const options=transport=>({namespace,source,guard:()=>true,createStorage:transport.createStorage});

test('automatic attempt wrapper creates an actual saved receipt and finishing is single-shot',async()=>{
  const f=streamCheckpointTransport(namespace),a=await begin(options(f));assert.match(a.approval.requestId,/^wa-[a-f0-9]{32}$/);
  assert.equal(await verify(a.approval,options(f)),true);const pending=a.finish('queued');assert.equal(a.finish('failed'),pending);await pending;
  assert.equal(await verify(a.approval,options(f)),true);a.close();await assert.rejects(begin(options(f)),/已有自动尝试/);
});
for(const status of ['failed','cancelled'])test(`world ${status} settlement invalidates stored automatic permission`,async()=>{
  const f=streamCheckpointTransport(namespace),a=await begin(options(f));await a.finish(status);a.close();assert.equal(await verify(a.approval,options(f)),false);
});
test('a lost settlement acknowledgement is never retried by repeated finish calls',async()=>{
  const f=streamCheckpointTransport(namespace),a=await begin(options(f));let posts=0;
  f.hook=({path})=>{if(path==='/api/files/upload'){posts++;throw Error('lost');}};
  const first=a.finish('queued');await assert.rejects(first);assert.equal(a.finish('failed'),first);await assert.rejects(a.finish('cancelled'));assert.equal(posts,1);a.close();
});
test('world wrapper guards reject before storage and a foreign request cannot use the stored proof',async()=>{
  const f=streamCheckpointTransport(namespace);await assert.rejects(begin({...options(f),guard:()=>false}));assert.equal(f.calls.length,0);
  const a=await begin(options(f));assert.equal(await verify({...a.approval,requestId:'wa-'+'d'.repeat(32)},options(f)),false);a.close();
});
test('automatic expression uses exact current character facts and at most three format repairs',async()=>{
  const original=shot(),before=structuredClone(original),requests=[];
  const result=await prepare({shot:original,promptFormats:['tags'],guard:async()=>{},prepareRenderings:async(s,meta)=>{
    requests.push(meta);assert.deepEqual(s,before);if(meta.repairAttempt<3)throw Object.assign(Error('bad shape'),{code:'world_shot_preparation'});return values(s);
  }});
  assert.equal(result.repairs,3);assert.equal(requests.length,4);assert.equal(requests[1].previousError,'bad shape');assert.ok(result.shot.promptRenderingPack);assert.deepEqual(original,before);
});
test('format exhaustion stops after the initial request plus three repairs, while transport errors are not retried',async()=>{
  let calls=0;await assert.rejects(prepare({shot:shot(),promptFormats:['tags'],guard:async()=>{},prepareRenderings:async()=>{calls++;return {};}}),/已修复3次/);assert.equal(calls,4);
  calls=0;await assert.rejects(prepare({shot:shot(),promptFormats:['tags'],guard:async()=>{},prepareRenderings:async()=>{calls++;throw Error('network denied');}}),/network denied/);assert.equal(calls,1);
});
test('a cancelled source after model return cannot bind expressions or retry',async()=>{
  let current=true,calls=0;await assert.rejects(prepare({shot:shot(),promptFormats:['tags'],guard:async()=>{if(!current)throw Error('changed');},prepareRenderings:async s=>{calls++;current=false;return values(s);}}),/changed/);assert.equal(calls,1);
});
test('automatic NAI reference never guesses one of several people; explicit and single-person choices remain',async()=>{
  const single=shot();for(const value of [single,{...single,characters:[...single.characters,{...single.characters[0],id:'b',name:'Bob'}],primarySubjectId:'b'}]){
    const result=await prepare({shot:value,promptFormats:['tags'],useReference:true,guard:async()=>{},prepareRenderings:async s=>values(s)});assert.notEqual(result.shot.characterReferenceDisabled,true);assert.equal(result.warnings.length,0);
  }
  const multi={...single,characters:[...single.characters,{...single.characters[0],id:'b',name:'Bob'}]};
  const result=await prepare({shot:multi,promptFormats:['tags'],useReference:true,guard:async()=>{},prepareRenderings:async s=>values(s)});
  assert.equal(result.shot.characterReferenceDisabled,true);assert.equal(result.warnings.length,1);assert.equal(result.shot.characters.length,2);assert.notEqual(multi.characterReferenceDisabled,true);
});
test('world automatic opt-in is strictly false for old state and independent from prose generation',()=>{
  assert.equal(createStoryboardDefaults().directorBridge.worldAutoGenerate,false);
  for(const value of [undefined,false,'true',1])assert.equal(normalizeStoryboardState({directorBridge:{worldSideShotsEnabled:true,worldAutoGenerate:value}}).directorBridge.worldAutoGenerate,false);
  const state=createStoryboardDefaults(),world={automatic:true,shotSpec:{directorDecision:{approval:{mode:'world_setting'}}}},prose={automatic:true};
  state.automation.autoGenerate=true;state.directorBridge.worldSideShotsEnabled=true;assert.equal(enabled(world,state),false);assert.equal(enabled(prose,state),true);
  state.directorBridge.worldAutoGenerate=true;state.automation.autoGenerate=false;assert.equal(enabled(world,state),true);assert.equal(enabled(prose,state),false);
  state.directorBridge.worldSideShotsEnabled=false;assert.equal(enabled(world,state),false);assert.equal(enabled({...world,automatic:false},state),true);
});
