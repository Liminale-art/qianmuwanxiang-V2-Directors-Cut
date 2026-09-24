import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import * as board from '../qianmu-storyboard.js';
import * as packageAssets from '../qianmu-storyboard-package-assets.js';
import {createImageAdmission} from '../qianmu-image-admission.js';
import {imageAttemptScopeKey,claimImageAttempt,importImageAttempts,beginImageAttempt,continueImageAttempt,settleImageAttempt,preflightImageAttempts} from '../qianmu-image-attempts.js';
import {applyCharacterCasting} from '../qianmu-character-casting.js';
import {resolveStoryboardCompilerResult} from '../qianmu-storyboard-compiler-result.js';
import {prepareStoryboardPackageDraft} from '../qianmu-storyboard-package-draft.js';
import {compilerEnvironment,casting,response} from './helpers/comfy-compiler-fixture.mjs';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
import {createPackageImportFixture} from './helpers/storyboard-package-fixture.mjs';

const copy=value=>JSON.parse(JSON.stringify(value));
const indexes=count=>Array.from({length:count},(_,index)=>index);

test('explicit v3 counts do not retroactively enlarge defaults or saved v1/v2 spending permissions',()=>{
  assert.deepEqual(board.createStoryboardDefaults().generationPolicy,{version:1,minImages:1,maxImages:3,concurrency:2});
  for(const [version,maxImages] of [[1,4],[2,6]]){
    assert.deepEqual(board.normalizeStoryboardGenerationPolicy({version,minImages:21,maxImages:21,concurrency:99}),{version,minImages:maxImages,maxImages,concurrency:4});
  }
  const policy={version:3,minImages:13,maxImages:21,concurrency:4};
  assert.deepEqual(board.normalizeStoryboardGenerationPolicy(policy),policy);
  assert.deepEqual(board.normalizeStoryboardState({generationPolicy:policy}).generationPolicy,policy);
  for(const maxImages of [257,1000,Number.MAX_SAFE_INTEGER]){
    assert.equal(board.normalizeStoryboardGenerationPolicy({version:3,minImages:1,maxImages,concurrency:2}).maxImages,maxImages,
      'storage and request capacities must not silently rewrite the user-selected range');
  }
});

function examples(count){
  return indexes(count).map(index=>{
    const shot=copy(response().shots[index%3]),description=`Narrative moment ${index+1}: ${shot.subject}.`;
    Object.assign(shot,{source_paragraph_ids:[`P${index+1}`],insert_after:`P${index+1}`,subject:description,narrative_purpose:description});
    shot.scene.location=`Distinct scene ${index+1}`;
    Object.assign(shot.composition,{focus:description,intent:description,continuity_key:`scene-${index+1}`});
    shot.prompt_atoms.global=[description];for(const value of Object.values(shot.prompt_renderings))value.global=description;
    return shot;
  });
}

// Production compiler, parser, cast application, style handoff, job preparation
// and admission run unchanged. Only model/provider I/O and ST persistence are fixtures.
async function fixture(count,{mixed=false}={}){
  const f=await compilerEnvironment(),host=f.context.ctx(),events=new EventEmitter(),shots=examples(count),calls=[],rows=new Map();
  events.setMaxListeners(100);host.eventSource=events;
  host.chat.splice(0,host.chat.length,{mes:shots.map(shot=>shot.subject).join('\n\n')+'\n\nUnfinished',name:'Alice',is_user:false,send_date:'count-test-floor',gen_started:'count-generation',swipe_id:0});
  host.saveMetadata=async()=>{};
  f.state.generationPolicy={version:3,minImages:1,maxImages:count,concurrency:4};
  f.styleSelection.enabled=mixed;
  f.state.connections.novel.draft.baseUrl='https://image.invalid';
  f.state.connections.comfy.draft.baseUrl='https://comfy.invalid';
  f.state.automation.autoGenerate=true;
  let selected=indexes(count),prepared,requests=0;
  const now=Date.now(),runLedger=(scope,fn)=>{const key=imageAttemptScopeKey(scope),value=fn(rows.get(key));rows.set(key,copy(value.ledger));return value;};
  const store={close(){},preflight:async groups=>{
    for(const group of groups){const result=preflightImageAttempts(structuredClone(rows.get(imageAttemptScopeKey(group.scope))),group.scope,group.inputs,group.history,now);if(!result.ok)return result;}
    return {ok:true};
  },claim:async(scope,input,seeds=[])=>runLedger(scope,value=>claimImageAttempt(importImageAttempts(value,scope,seeds,now),scope,input,now)),
    begin:async(scope,input)=>runLedger(scope,value=>beginImageAttempt(value,scope,input,now)),
    continue:async(scope,input)=>runLedger(scope,value=>continueImageAttempt(value,scope,input,now)),
    settle:async(scope,input)=>runLedger(scope,value=>settleImageAttempt(value,scope,input,now))};
  const resolve=job=>board.resolveStoryboardMessageReference(job.messageRef,host.chat,{chatKey:'chat-a',namespace:'st-user:route-test',metadata:host.chatMetadata});
  const admission=createImageAdmission({store,account:async()=> 'st-user:route-test',ownerId:'count-page',resolveSource:resolve});
  Object.assign(f.context,{
    storyboardStreamRuntime:null,storyboardCleanWithTagRules:value=>value,storyboardCleanMessageText:value=>value.trim(),resolveMacro:async value=>value,
    storyboardMessageParagraphs:value=>value.split(/\n\s*\n/).map(row=>row.trim()).filter(Boolean),
    storyboardCompilerWorldText:async()=>({text:'',rows:[]}),
    storyboardCompilerCharacterCasting:async()=>({prepared:casting,assertCurrent:async()=>{},apply:applyCharacterCasting}),
    document:{addEventListener(){},removeEventListener(){}},STORYBOARD_PIPELINE_LOG_LIMIT:100,
    storyboardPlansForPortableExport:async plans=>copy(plans),storyboardDeletePlanArchives:async()=>{},
    storyboardValidatedAnchor:job=>({valid:resolve(job).state==='active'}),storyboardPumpQueue(){},
    storyboardImageAdmissionRuntime:async()=>admission,storyboardSettleImageAdmission:(job,status)=>admission.settle(job,status),
    storyboardConfirmComfyExecution:async()=>true,storyboardParseWorkflow:value=>typeof value==='string'?JSON.parse(value):value,
    storyboardCallCompiler:async(messages,_id,options)=>{
      requests++;const wire=JSON.parse(messages[1].content),payload=wire.context?.verified_handoff||wire.context||wire;
      calls.push({payload:copy(payload),options:copy(options),errors:wire.errors||wire.validation_errors});
      if(options.repair&&typeof wire.response==='string')return wire.response;
      if(typeof payload.original_response==='string')return payload.original_response;
      if(options.jsonSchemaName==='qianmu.storyboard.narrative.v1')return JSON.stringify({schema:options.jsonSchemaName,should_generate:selected.length>0,
        skip_reason:selected.length?'':'No uncovered narrative moment',decisions:[],
        shots:selected.map(index=>{
          const {prompt_atoms,prompt_renderings,...shot}=shots[index],id=`P${index+1}`;
          const quote=payload.source_catalogue.find(row=>row.floor===0).passages.find(row=>row.paragraph_id===id).text;
          const anchor={floor:0,branch_id:'present',paragraph_id:id,quote};
          return {...shot,...(options.jsonSchema.properties.shots.items.properties.gallery_keywords?{gallery_keywords:[]}:{}),state_point:{branchId:'present',paragraphId:id,evidence:quote},
            ...(payload.constraints.streaming?{stream_support:{scene:anchor,content:anchor,presence:shot.characters.map(character=>({character_id:character.character_id,source:anchor}))}}:{})};
        }),source_states:payload.required_state_floors.map(floor=>({floor,roster:{branches:[{id:'present',layer:'present'}],subjectIds:['A']},events:[]})),continuity_links:[]});
      return JSON.stringify({schema:options.jsonSchemaName,shots:payload.shots.map(item=>{
        const shot=shots.find(row=>row.subject===item.plan.subject);
        return {shot_id:item.shot_id,prompt_atoms:shot.prompt_atoms,prompt_renderings:Object.fromEntries(options.promptFormats.map(format=>[format,shot.prompt_renderings[format]]))};
      }),...(mixed?{style_assignments:payload.shots.map((item,index)=>({shot_id:item.shot_id,scheme_id:index<2?`fixture-style-${index}`:'current',reason:'Rendering style only'}))}:{})});
    },
  });
  vm.runInContext(['storyboardCompilerContext','storyboardSubmitStreamPrepared','storyboardChooseComfyGenerationRoutes','storyboardPreflightImageBatch','storyboardQueueJob','storyboardStartLog','storyboardFinishLog',
    'storyboardRecordPreparedJobFailure','storyboardPlanForJob','storyboardSyncTaskState','storyboardSetPlanStatus'].map(section).join('\n'),f.context);
  return {...f,host,shots,calls,rows,admission,
    select:value=>{selected=value;},get requests(){return requests;},get prepared(){return prepared;},
    run:options=>f.context.storyboardCompilePrompt(null,{quiet:true,stream:{floor:0,signal:new AbortController().signal},
      onPrepared:async value=>{prepared=value;await f.context.storyboardSubmitStreamPrepared(value);},...options}),
    assertReleased(){assert.equal(events.eventNames().reduce((sum,key)=>sum+events.listenerCount(key),0),0);assert.equal(f.context.storyboardCompilerBusy,false);},
  };
}

for(const count of [3,7,13,17,21])test(`explicit ${count}-shot v3 range survives real streaming compiler, plan, admission and persisted order`,async()=>{
  const f=await fixture(count);assert.equal(await f.run(),true,JSON.stringify({errors:f.errors,notices:f.notices,repair:f.calls.filter(call=>call.payload.validation_errors)}));
  const queue=f.context.storyboardQueue;
  assert.equal(queue.length,count);assert.equal(f.requests,2);assert.equal(f.state.shotPlans[0].shots.length,count);
  assert.ok(queue.every(job=>job.inlineOrder),`all ${count} jobs must retain an inline-order identity`);
  assert.deepEqual(queue.map(job=>job.inlineOrder.shotIndex),indexes(count));
  assert.deepEqual(queue.map(job=>job.messageRef.stream.moment.paragraphId),indexes(count).map(index=>`P${index+1}`));
  assert.ok(queue.every(job=>job.profile.count==='1'&&job.imageAdmission.automaticSlot));
  const saved=board.normalizeStoryboardState(copy(f.state));
  assert.equal(saved.generationPolicy.maxImages,count);assert.equal(saved.generationPolicy.version,3);
  assert.equal(saved.shotPlans[0].shots.length,count);assert.equal(saved.taskStates.length,count);
  assert.deepEqual(saved.taskStates.map(job=>job.inlineOrder?.shotIndex).sort((left,right)=>left-right),indexes(count));
  assert.equal(f.rows.size,1);assert.equal([...f.rows.values()][0].entries.length,count);
  const extra={...copy(queue.at(-1)),id:`beyond-${count}`,paragraphAnchor:{paragraphIndex:count+1},shotSpec:{...copy(queue.at(-1).shotSpec),subject:'another independent proposed image'}};
  delete extra.imageAdmission;
  await assert.rejects(f.admission.admit(extra,{maxAutomatic:count}),{code:'image_attempt_budget_exhausted'});
  assert.equal([...f.rows.values()][0].entries.length,count);f.assertReleased();
});

for(const count of [7,13])test(`${count} ordinary mixed Comfy/NAI shots keep director count and narrative order after style matching`,async()=>{
  const f=await fixture(count,{mixed:true});Object.assign(f.state,{target:'floor',floor:'0'});
  f.host.chat[0].mes=f.shots.map(shot=>shot.subject).join('\n\n');
  const messageRef=board.createStoryboardMessageReference({message:f.host.chat[0],chatKey:'chat-a',floor:0});
  const plan=f.context.createStoryboardWorkflowTicket({id:`ordinary-${count}`,chatKey:'chat-a',floor:0,messageRef,origin:'automatic',autoGenerate:true});
  f.state.shotPlans=[plan];
  assert.equal(await f.run({stream:null,onPrepared:null,plan,automatic:true}),true,JSON.stringify(f.errors));
  assert.equal(await f.context.storyboardGenerate(null,{plan,automatic:true}),true,JSON.stringify(f.notices));
  const queue=f.context.storyboardQueue;assert.equal(queue.length,count);
  assert.deepEqual(queue.map(job=>job.source),['comfy','comfy',...Array(count-2).fill('novel')]);
  assert.deepEqual(queue.map(job=>job.inlineOrder.shotIndex),indexes(count));
  assert.ok(queue.every(job=>job.profile.count==='1'&&job.imageAdmission.automaticSlot));
  assert.equal(f.requests,2);assert.equal(f.rows.size,1);f.assertReleased();
});

test('seven early plus six later shots share the explicit thirteen-slot allowance through state reload and final extraction',async()=>{
  const f=await fixture(13);f.select(indexes(7));assert.equal(await f.run(),true,JSON.stringify(f.errors));
  const first=copy(f.context.storyboardQueue),planId=f.state.shotPlans[0].id;
  Object.assign(f.state,board.normalizeStoryboardState(copy(f.state)));
  f.select(indexes(6).map(index=>index+7));assert.equal(await f.run(),true,JSON.stringify(f.errors));
  assert.deepEqual(copy(f.context.storyboardQueue.slice(0,7)),first);
  assert.equal(f.calls[2].payload.constraints.committed_images.occupied,7);assert.equal(f.calls[2].payload.constraints.max_shots,6);
  assert.equal(f.state.shotPlans[0].id,planId);assert.equal(f.state.shotPlans[0].shots.length,13);assert.equal(f.rows.size,1);
  f.host.chat[0].mes=f.shots.map(shot=>shot.subject).join('\n\n');f.select([]);
  Object.assign(f.state,{target:'floor',floor:'0'});
  assert.equal(await f.run({stream:null,onPrepared:null,automatic:true}),false,JSON.stringify(f.errors));
  assert.equal(f.context.storyboardQueue.length,13);assert.equal([...f.rows.values()][0].entries.length,13);f.assertReleased();
});

test('model output above the explicitly chosen seven-shot maximum never queues a truncated paid batch',async()=>{
  const f=await fixture(13);f.state.generationPolicy.maxImages=7;
  assert.equal(await f.run(),false);assert.equal(f.context.storyboardQueue.length,0);assert.equal(f.rows.size,0);
  assert.equal(f.calls[0].payload.constraints.max_shots,7);
  assert.ok(f.calls.some(call=>call.errors?.some(error=>error.code==='max_items')),JSON.stringify(f.calls.map(call=>call.errors)));
  assert.ok(f.errors.length||f.notices.length);f.assertReleased();
});

test('a valid twenty-one-shot plan refuses insufficient queue capacity before publishing any job or reservation',async()=>{
  const f=await fixture(21);f.context.STORYBOARD_QUEUE_LIMIT=8;
  assert.equal(await f.run(),false);assert.equal(f.context.storyboardQueue.length,0);assert.equal(f.rows.size,0);
  assert.ok(f.notices.some(message=>/队列|任务/.test(message)),JSON.stringify(f.notices));f.assertReleased();
});

test('later streaming batch exceeding remaining ledger capacity reserves none of its six new jobs',async()=>{
  const f=await fixture(13);f.select(indexes(7));assert.equal(await f.run(),true,JSON.stringify(f.errors));
  const ledger=[...f.rows.values()][0],sample=copy(ledger.entries[0]);
  for(let index=ledger.entries.length;index<255;index++)ledger.entries.push({...sample,
    attemptId:`old-manual-${index}`,logicalShotId:`old-picture-${index}`,operationKey:`old-action-${index}`,kind:'manual',automaticSlot:false,status:'succeeded'});
  const before=copy(ledger),jobs=copy(f.context.storyboardQueue);
  f.select(indexes(6).map(index=>index+7));assert.equal(await f.run(),false);
  assert.deepEqual([...f.rows.values()][0],before,'capacity probing must not reserve the first new job before refusing the remaining five');
  assert.deepEqual(copy(f.context.storyboardQueue),jobs);assert.equal(f.state.shotPlans[0].shots.length,7);
  assert.ok(f.notices.some(message=>/容量|防重|记录/.test(message)),JSON.stringify(f.notices));f.assertReleased();
});

test('twenty-one requested shots do not expand four-way workers or allow two simultaneous NAI jobs',()=>{
  const state=board.createStoryboardDefaults();state.generationPolicy={version:3,minImages:1,maxImages:21,concurrency:99};
  const queue=indexes(21).map(index=>({id:`job-${index}`,source:index%3?'openai':'novel'})),active=new Map(),started=[];
  const context=vm.createContext({...board,storyboardState:()=>state,storyboardQueue:queue,storyboardActiveJobs:active,storyboardBusy:false,
    storyboardRunQueuedJob:job=>started.push(job.id),renderModal(){}});
  vm.runInContext(section('storyboardPumpQueue'),context);context.storyboardPumpQueue();
  assert.equal(active.size,4);assert.equal([...active.values()].filter(job=>job.source==='novel').length,1);
  assert.equal(started.length,4);assert.equal(queue.length,17);
  active.delete('job-1');context.storyboardPumpQueue();assert.equal(active.size,4);assert.equal([...active.values()].filter(job=>job.source==='novel').length,1);
  active.delete('job-0');context.storyboardPumpQueue();assert.equal(active.size,4);assert.equal([...active.values()].filter(job=>job.source==='novel').length,1);
});

async function exportState(state){
  const store={},notices=[];
  let exported;const noop=()=>{},context=vm.createContext({...board,Blob,clone:structuredClone,storyboardState:()=>state,STORYBOARD_SOURCES:board.STORYBOARD_PROVIDER_REGISTRY,
    storyboardAdmissionEpoch:1,featureRuntime:{load:async name=>name==='storyboardPackageAssets'?packageAssets:{resolveImageAccountNamespace:async()=> 'st-user:fixture'}},
    isPlainObject:value=>Boolean(value&&typeof value==='object'&&!Array.isArray(value)),confirmDialog:async()=>true,getChatKey:()=> 'chat-a',getChatStore:()=>store,
    storyboardHydratePipelineArchive:noop,storyboardPlansForPortableExport:async value=>value,storyboardGalleryRecords:()=>[],storyboardGalleryCollections:()=>[],storyboardUtilsModule:async()=>({}),
    saveSettings:noop,saveMetadata:noop,storyboardSchedulePlanArchive:noop,storyboardArchiveGallerySnapshots:noop,storyboardScheduleInlineRender:noop,renderModal:noop,toast:(...args)=>notices.push(args),fileStamp:()=> 'test',
    URL:{createObjectURL:blob=>{exported=blob;return 'blob:test';},revokeObjectURL:noop},document:{createElement:()=>({click:noop,remove:noop}),body:{appendChild:noop},getElementById:()=>({})},
    MODAL_ID:'fixture',storyboardPipelineArchiveCache:new Map(),createStorageBackupCheck:()=>{const check=()=>{};check.release=()=>{};return check;},setTimeout:noop});
  vm.runInContext(['ttsDownloadBlob','storyboardPackageContext','storyboardPipelineForLog','storyboardExportPackage'].map(section).join('\n'),context);
  await context.storyboardExportPackage({originals:false});assert.ok(exported,`portable export must produce a complete file: ${JSON.stringify(notices)}`);return exported.text();
}

for(const count of [7,13,21])test(`actual portable export/import keeps explicit v3 ${count}-shot policy exactly`,async()=>{
  const state=board.createStoryboardDefaults(),policy={version:3,minImages:7,maxImages:count,concurrency:4};state.generationPolicy=policy;
  const text=await exportState(state);
  assert.deepEqual(JSON.parse(text).settings.generationPolicy,policy);
  const importer=createPackageImportFixture();await importer.import(new Blob([text]));
  assert.deepEqual(copy(importer.e.state.generationPolicy),policy,JSON.stringify(importer.e.notices));
});

for(const count of [1,21])test(`actual portable export/import preserves all ${count} compiled plan shots and their order`,async()=>{
  const f=await fixture(count);f.context.storyboardCredentialId=()=>'';
  assert.equal(await f.run(),true,JSON.stringify(f.errors));
  const persisted=board.normalizeStoryboardState(copy(f.state)),original=copy(persisted.shotPlans[0]),text=await exportState(persisted),pack=JSON.parse(text);
  assert.equal(pack.settings.shotPlans[0].shots.length,count);
  const importer=createPackageImportFixture();await importer.import(new Blob([text]));
  assert.ok(importer.e.pending,JSON.stringify(importer.e.notices));
  const plan=importer.e.state.shotPlans.find(row=>row.id===original.id);assert.ok(plan);
  assert.equal(plan.shots.length,count);assert.deepEqual(plan.shots.map(shot=>shot.id),original.shots.map(shot=>shot.id));
  assert.deepEqual(plan.shots.map(shot=>shot.shotSpec),original.shots.map(shot=>shot.shotSpec));
  assert.equal(plan.autoGenerate,false);assert.ok(plan.shots.every(shot=>shot.requiresManualConfirmation&&shot.status==='cancelled'));
});

test('canonical shot-history additions do not admit unknown fields or malformed nested source identities',()=>{
  const state=board.createStoryboardDefaults(),spec=board.normalizeStoryboardShotSpec({id:'spec',sourceParagraphIds:['P1'],subject:'scene',
    narrativeMoment:{version:1,paragraphId:'P1',branchId:'present',layer:'present',quote:'scene',start:0,end:5,subject:'scene',insertAfter:'P1',sourceIds:['P1']},
    productionContext:{narrativeContext:{schema:'qianmu.narrative-context.v1',chatKey:'chat-a',branch:{kind:'mainline',id:'mainline',fork:null},claim:'fact',
      time:{layer:'present',label:''},knowledge:{knownBy:[],hiddenFrom:[]}}}});
  const input=()=>({settings:state,chat:{},incoming:{schemaVersion:board.STORYBOARD_SCHEMA_VERSION,shotPlans:[{id:'plan',shots:[{id:'shot',shotSpec:copy(spec)}]}]},
    images:[],collections:[],chatKey:'chat-a',namespace:'st-user:fixture',sourceNamespace:'st-user:fixture'});
  assert.equal(prepareStoryboardPackageDraft(input()).settings.shotPlans[0].shots.length,1);
  const original=copy(state);
  for(const modify of [
    shot=>{shot.future='unsupported';},shot=>{shot.schema='qianmu.storyboard.plan.v99';},shot=>{shot.schema={version:1};},
    shot=>{shot.sceneFingerprint.future='unsupported';},shot=>{shot.sceneFingerprint.castIds=[123];},shot=>{shot.sceneFingerprint.explicit='false';},
    shot=>{shot.sceneFingerprint.narrativeContext.knowledge.future=[];},shot=>{shot.sceneFingerprint.narrativeContext.branch.id=123;},
    shot=>{shot.narrativeMoment.future='unsupported';},shot=>{shot.narrativeMoment.start='0';},shot=>{shot.narrativeMoment.end=6;},shot=>{shot.narrativeMoment.sourceIds=[123];},
  ]){
    const args=input();modify(args.incoming.shotPlans[0].shots[0].shotSpec);
    assert.throws(()=>prepareStoryboardPackageDraft(args),/分镜历史/);assert.deepEqual(state,original);
  }
});

test('uncapped plan imports still reject duplicate or oversized IDs and excessive complete structures before mutation',()=>{
  const state=board.createStoryboardDefaults(),plan=board.normalizeStoryboardState({shotPlans:[{id:'import-plan',chatKey:'chat-a',shots:indexes(21).map(index=>({id:`shot-${index}`,prompt:`scene ${index}`}))}]}).shotPlans[0];
  const input=()=>({settings:state,chat:{},incoming:{schemaVersion:board.STORYBOARD_SCHEMA_VERSION,shotPlans:[copy(plan)]},images:[],collections:[],chatKey:'chat-a',namespace:'st-user:fixture',sourceNamespace:'st-user:fixture'});
  const original=copy(state);
  for(const modify of [shots=>{shots[20].id=shots[0].id;},shots=>{shots[20].id='x'.repeat(161);},shots=>{shots[20].prompt='x'.repeat(2*1024*1024);}]){
    const args=input();modify(args.incoming.shotPlans[0].shots);assert.throws(()=>prepareStoryboardPackageDraft(args),/编号无效或重复|安全容量/);assert.deepEqual(state,original);
  }
});

async function fallbackResult(count,maxImages,{manual=false}={}){
  const state=board.createStoryboardDefaults();state.generationPolicy={version:3,minImages:1,maxImages,concurrency:2};
  if(manual)state.pendingParagraphSelection={mode:'manual_supplement'};
  let sequence=0;return resolveStoryboardCompilerResult(JSON.stringify({shots:indexes(count).map(index=>({id:`spec-${index}`,prompt:`visible scene ${index}`,paragraph_index:index}))}),
    {paragraphs:indexes(count).map(index=>`paragraph ${index}`)}, {supportsNativeNegative:true},state,null,null,
    {...board,extractJson:JSON.parse,storyboardProviderProfile:()=>state.profiles.novel,uid:()=>`draft-${++sequence}`,featureRuntime:{load:()=>assert.fail('fallback must not request another model')}});
}

test('non-focused result adaptation rejects excess shots instead of silently clipping to the selected limit',async()=>{
  await assert.rejects(fallbackResult(13,7),{code:'storyboard_shot_limit',submissionState:'not_submitted'});
  await assert.rejects(fallbackResult(2,21,{manual:true}),{code:'storyboard_shot_limit',submissionState:'not_submitted'});
  const result=await fallbackResult(21,21);assert.equal(result.shots.length,21);
  assert.deepEqual(result.shots.map(shot=>shot.paragraphIndex),indexes(21));
});
