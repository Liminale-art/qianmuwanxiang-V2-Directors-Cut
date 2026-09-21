import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as casting from '../qianmu-character-casting.js';
import * as world from '../qianmu-world-shot.js';
import * as core from '../qianmu-storyboard.js';
import {projectNewComfyExecution} from '../qianmu-comfy-new-execution.js';
import * as decisions from '../qianmu-director-decision.js';
import * as orders from '../qianmu-director-work-order.js';
import { adaptProductionPacketToNarrativeLedgerEntry } from '../qianmu-narrative-ledger.js';
import { scoreNarrativeDirectorCandidate } from '../qianmu-director-candidate.js';
import * as comfyRoutes from '../qianmu-comfy-route.js';
import * as formats from '../qianmu-prompt-formats.js';
import {prepareComfyPromptJob} from '../qianmu-comfy-prompt.js';
import { recipesFixture } from './helpers/comfy-route-fixture.mjs';
import {normalizeQianmuProductionPacket} from '../qianmu-production-packet.js';
import {newCharacterArchive,normalizeCharacterArchive} from '../qianmu-character-archive.js';
import {createStoryboardFormFixture,storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
import * as worldAutomatic from '../qianmu-world-automatic.js';
import * as worldAutomaticHost from '../qianmu-world-automatic-host.js';
import * as productionPackets from '../qianmu-production-packet.js';
import * as ledgerRuntime from '../qianmu-narrative-ledger.js';
import * as candidateRuntime from '../qianmu-director-candidate.js';
import {buildWorldSourceIndex} from '../qianmu-world-source.js';
import {streamCheckpointTransport} from './helpers/stream-checkpoint-fixture.mjs';
import {createImageAdmission} from '../qianmu-image-admission.js';
import {imageAttemptScopeKey,claimImageAttempt,importImageAttempts,settleImageAttempt} from '../qianmu-image-attempts.js';
import {createEnsembleStorage} from '../qianmu-ensemble-storage.js';
import {planCharacterReference,assertCharacterReferencePlan,characterReferenceNotice} from '../qianmu-character-reference.js';
import {installWorldComfyAuto} from './helpers/world-comfy-auto-fixture.mjs';

const copy=value=>JSON.parse(JSON.stringify(value));
export function worldEnvironment() {
  const namespace='st-user:world',reads=[];
  const document=(name,category,aliases=[])=>normalizeCharacterArchive({...newCharacterArchive(category),name,aliases,
    imagegen:{appearance:`${name} silver hair`,negative:`${name} incorrect face`,sensitiveAppearance:'PRIVATE-QUALIFICATION',reference:null}});
  const docs=new Map([['alice',document('Alice','char',['阿莉'])],['player',document('Player','user')],
    ['gardener',document('Gardener','other',['园丁'])],['one',document('岚','other')],['absent',document('Absent','other')]]);
  const subjects=[{name:'Alice',category:'char',subjectKey:'char:alice.png'},{name:'Player',category:'user',subjectKey:'user:player.png'}];
  const bindings=subjects.map((row,index)=>({...row,scope:'default',chatKey:'',archiveId:index?'player':'alice'}));
  const head=(id,doc)=>({id,name:doc.name,aliases:doc.aliases,category:doc.category,version:3,revision:'revision-3'});
  const store={list:async()=>[...docs].map(([id,doc])=>head(id,doc)),bindings:async()=>bindings,
    load:async(ns,id)=>{assert.equal(ns,namespace);reads.push(id);const doc=docs.get(id);return doc?{head:head(id,doc),document:doc}:null;}};
  return {namespace,reads,docs,subjects,bindings,store,prepare:options=>casting.prepareCharacterCasting({store,namespace,subjects,chatKey:'chat-a',...options})};
}
const characters=[{id:'alice-source',name:'Alice',temporaryState:['blue dyed hair, no coat, stirs soup']}];
const input=(cast=characters)=>({id:'world-shot',characters:cast,subject:'厨房',narrativePurpose:'只属于导演视角的可能场景',
  promptAtoms:{global:['厨房内人物正在做饭']},productionContext:{packetId:'packet-a',track:'second_camera',canonLevel:'director',autoInsert:false},
  continuityUpdates:{outfit:{'alice-source':'no coat'}}});
const fields=shot=>({characters:shot.characters.map(row=>({id:row.id,identity:row.identity.join('\n'),temporaryState:row.temporaryState.join('\n')})),referenceChoice:'__none__',sensitive:false});

test('world preparation nominates exact visible identities including one-character OTHER, not incidental prose or absent bindings',async()=>{
  const e=worldEnvironment();e.bindings[1].archiveId='missing-but-not-visible';
  const prepared=await e.prepare({text:'Player Absent Gardener',visibleCharacters:[...characters,{id:'x',name:'岚'},{id:'z',name:'Gardener',visible:false}]});
  assert.deepEqual(e.reads,['alice','one']);assert.equal(prepared.entries.length,2);
  assert.doesNotMatch(JSON.stringify(prepared),/PRIVATE-QUALIFICATION/);
  e.reads.length=0;await e.prepare({visibleCharacters:[]});assert.deepEqual(e.reads,[]);
  await assert.rejects(()=>e.prepare({visibleCharacters:null}),/出镜人物/);
});
test('world binding preserves current state, provenance and source ids while adding frozen base appearance only where missing',async()=>{
  const e=worldEnvironment(),prepared=await e.prepare({visibleCharacters:characters});
  const original=input(),{shot}=world.prepareWorldCharacterShot(original,prepared);
  assert.equal(shot.characters[0].id,'archive:alice');assert.equal(shot.characters[0].archiveSnapshot.archiveVersion,3);
  assert.deepEqual(shot.characters[0].identity,['Alice silver hair']);assert.deepEqual(shot.characters[0].temporaryState,characters[0].temporaryState);
  assert.equal(shot.continuityUpdates.outfit['archive:alice'],'no coat');assert.equal(shot.productionContext.autoInsert,false);
  assert.equal(original.characters[0].id,'alice-source');assert.equal(original.characters[0].archiveSnapshot,undefined);
  const explicit=world.prepareWorldCharacterShot(input([{...characters[0],identity:['explicit current blue hair']}]),prepared).shot;
  assert.deepEqual(explicit.characters[0].identity,['explicit current blue hair']);
  e.docs.get('alice').imagegen.appearance='later change';assert.equal(shot.characters[0].identity[0],'Alice silver hair');
});
test('ambiguous aliases cannot lend either archive negative or private engine implementation',async()=>{
  const e=worldEnvironment();e.docs.get('gardener').aliases=['Alice'];
  const prepared=await e.prepare({visibleCharacters:characters,includeReferences:true,includeComfy:true});
  const {shot,warnings}=world.prepareWorldCharacterShot(input(),prepared);
  assert.equal(warnings[0].reason,'ambiguous_name');assert.equal(shot.characters[0].archiveSnapshot,undefined);
  assert.equal(shot.characters[0].identity.length,0);
  assert.match(world.renderWorldShotConfirmation(shot,{warnings}),/匹配冲突/);
});
test('explicit visibility survives packet, decision and work-order boundaries without upgrading truth or authorizing voice/film',()=>{
  const p=normalizeQianmuProductionPacket({packetId:'packet-a',eventId:'event-a',timelineAnchor:{chatKey:'chat-a'},
    characterState:[{id:'a',name:'Alice',visible:false},{id:'b',name:'Gardener',state:'no coat'}],visualIntent:{subject:'kitchen'}});
  const candidate={candidateId:'candidate-a',owner:{chatKey:'chat-a'},entryId:'entry-a',sourceKind:'simulation',recommendation:'manual_review',
    gates:{sourceValid:true,factConsistency:true,spoilerSafe:false,shotDistinct:true}};
  const result=decisions.createDirectorDecision(candidate,p,{chatKey:'chat-a',ledgerEntryId:'entry-a',explicitApproval:true,approvedAt:1,outputs:{storyboard:true}});
  assert.equal(result.ok,true);const dispatch=orders.createDirectorWorkOrder(result.decision,'storyboard','chat-a');
  const shot=orders.directorWorkOrderToStoryboardShot(dispatch.workOrder,'chat-a');assert.deepEqual(shot.characters.map(row=>row.name),['Gardener']);
  assert.equal(shot.narrativeLayer,'imagined');assert.equal(decisions.canConsumeDirectorDecision(result.decision,'voice','chat-a'),false);
  assert.deepEqual(core.adaptProductionPacketToStoryboardShotSpec(p).characters.map(row=>row.name),['Gardener']);
});
test('long declared state and appearance preserve their tail; invalid or oversized edits fail without touching the source',async()=>{
  const e=worldEnvironment();e.docs.get('alice').imagegen.appearance='a'.repeat(1100)+'tail';
  const prepared=await e.prepare({visibleCharacters:characters}),raw=input([{...characters[0],temporaryState:['x'.repeat(800)+'state-tail']}]);
  const {shot}=world.prepareWorldCharacterShot(raw,prepared);assert.ok(shot.characters[0].identity.join('').endsWith('tail'));
  assert.ok(shot.characters[0].temporaryState.join('').endsWith('state-tail'));
  const edit=fields(shot);edit.characters[0].identity='z'.repeat(16000);assert.throws(()=>world.captureWorldShotConfirmation(shot,edit),/过长/);
  assert.throws(()=>world.prepareWorldCharacterShot(input([...characters,...characters]),prepared),/身份重复/);
  assert.ok(shot.characters[0].identity.join('').endsWith('tail'));
});
test('confirmation edits only this image; explicit reference choice stays on a visible id and does not change the library',async()=>{
  const e=worldEnvironment(),prepared=await e.prepare({visibleCharacters:characters,includeReferences:true});
  const {shot}=world.prepareWorldCharacterShot(input(),prepared),edit=fields(shot);edit.characters[0].identity='blue hair';edit.sensitive=true;
  const changed=world.captureWorldShotConfirmation(shot,edit,true);assert.equal(changed.characterReferenceDisabled,true);assert.equal(changed.sensitive,true);
  assert.equal(shot.characters[0].identity[0],'Alice silver hair');assert.equal(changed.characters[0].temporaryState[0],characters[0].temporaryState[0]);
  assert.throws(()=>world.captureWorldShotConfirmation(shot,{...edit,referenceChoice:'archive:someone-else'},true),/主参考人物/);
  const compiled=core.compileStoryboardPrompt({providerId:'novel',remoteModelId:'nai-diffusion-4-5-full',shot:changed});
  assert.match(compiled.providerOptions.v4_prompt.caption.char_captions[0].char_caption,/blue hair/);
  assert.match(compiled.providerOptions.v4_negative_prompt.caption.char_captions[0].char_caption,/incorrect face/);
  assert.doesNotMatch(compiled.providerOptions.v4_prompt.caption.base_caption,/silver hair|blue hair/);
  assert.equal(world.captureWorldShotConfirmation({...shot,sensitive:true},{...edit,sensitive:false}).sensitive,true);
});

function harness({confirm=async options=>options.promptFormats.length ? {...options.shot,promptRenderingPack:await formats.bindStoryboardPromptRenderings(options.shot,
  Object.fromEntries(options.promptFormats.map(format=>[format,{global:'kitchen, soft light',negative:'blurred details',characters:options.shot.characters.map(row=>({character_id:row.id,positive:[...row.identity,...row.temporaryState].join(', ')}))}])),{formats:options.promptFormats})} : options.shot,family='novel'}={}) {
  const e=worldEnvironment(),{state,context}=createStoryboardFormFixture({family});
  state.directorBridge.worldSideShotsEnabled=true;state.prompt='original';state.promptDraft.shots=[{id:'old-shot',prompt:'original'}];
  const packet=normalizeQianmuProductionPacket({packetId:'packet-a',eventId:'event-a',timelineAnchor:{chatKey:'chat-a'},
    characterState:[{id:'alice-source',name:'Alice',state:'blue hair, no coat'}],visualIntent:{subject:'厨房',description:'Alice stirs soup'}});
  const ledger=adaptProductionPacketToNarrativeLedgerEntry(packet);
  const candidate=scoreNarrativeDirectorCandidate(ledger,{chatKey:'chat-a',viewerId:'user'});
  let account=e.namespace,chat='chat-a';const calls=[],notices=[],chatData=[{mes:'unrelated prose'}];
  Object.assign(context,{storyboardCompilerBusy:false,projectNewComfyExecution,storyboardAdmissionEpoch:0,storyboardCredentialRevision:0,storyboardGenerationPreparing:new Set(),directorNarrativeBridgeEpoch:1,
    directorProductionPacketState:{chatKey:chat,packets:[packet]},directorCandidatePoolState:{chatKey:chat,ledger:{entries:[ledger]},pool:{candidates:[candidate]}},
    getChatKey:()=>chat,storyboardTargetFloor:()=>0,storyboardScheduleAutomaticCapture(){},ctx:()=>({chat:chatData,Popup:class{},POPUP_TYPE:{CONFIRM:1}}),
    getCharacterDescription:()=>'',getPersonaDescription:()=>'',storyboardCharacterArchiveContext:async()=>({chatKey:chat,subjects:e.subjects}),
    storyboardCaptureWorkbench:()=>{calls.push('capture');return {state,profile:state.profiles[state.source]};},
    storyboardResolveRoutingProfile:(_,route)=>context.storyboardProviderProfile(state,route.providerId),
    featureRuntime:{load:async key=>{
      calls.push(key);
      return {directorDecision:decisions,directorWorkOrders:orders,imageAdmission:{resolveImageAccountNamespace:async()=>account},
        characterCasting:{...casting,readCharacterCasting:options=>casting.prepareCharacterCasting({...options,store:e.store})},
        worldShot:{...world,prepareWorldStyleSelection:async(...args)=>{const result=await world.prepareWorldStyleSelection(...args);context.worldStyleExcluded=args[1].ensemble?.unavailable;return result;},createWorldGenerationHandoff:(owner,options)=>{
          // Inspect a second pure projection; the production handoff stays unconsumed.
          context.worldDraft=world.consumeWorldGenerationHandoff(world.createWorldGenerationHandoff(owner,options),owner);
          return world.createWorldGenerationHandoff(owner,options);
        },openWorldShotConfirmation:async options=>{await options.guard();calls.push('confirm');return confirm(options);}}}[key];
    }},saveSettings:()=>calls.push('save'),sanitizeStoryboardDiagnosticData:core.sanitizeStoryboardDiagnosticData,toast:(text)=>{notices.push(text);return false;},
    storyboardCallCompiler:async()=>assert.fail('unexpected world expression request'),storyboardPipelineArchiveCache:new Map(),
    storyboardPreflightComfyForCompiler:async()=>assert.fail('configure the fixed-workflow preflight fixture explicitly'),
    storyboardArchivePipelineLog:async log=>{calls.push(['archive',log.pipelineId]);return false;},
    storyboardGenerate:async(root,options)=>{options.productionGuard.assertCurrent();context.lastProductionOptions=options;calls.push('generate');assert.equal(root,null);assert.equal(options.automatic,false);return true;},
  });
  vm.runInContext(['storyboardStoreLog','storyboardPrepareComfyRoutes','storyboardCreatePreparationGuard','storyboardCompilerCharacterCasting','storyboardEnsembleHost','storyboardGenerateProductionPacket'].map(section).join('\n'),context);
  return {...e,state,context,calls,notices,packet,candidate,run:()=>context.storyboardGenerateProductionPacket({isConnected:true},'packet-a'),setAccount:value=>{account=value;},setChat:value=>{chat=value;}};
}
function useActualWorldGeneration(e,functions) {
  vm.runInContext(functions.map(section).join('\n'),e.context);
  const generate=e.context.storyboardGenerate;
  e.context.storyboardGenerate=(root,options)=>{e.context.lastProductionOptions=options;return generate(root,options);};
}

async function automaticWorldHarness({comfy=false}={}){
  const e=comfy?await classifiedWorld():harness();
  const source=(await buildWorldSourceIndex({npc_updates:[{name:'Alice',action:'stirs soup'}]},{chatKey:'chat-a',revisionId:'plan-1'})).entries[0].source;
  e.packet.sourceRef={field:'npc_updates',index:0,worldSource:source};
  const ledger=adaptProductionPacketToNarrativeLedgerEntry(e.packet);Object.assign(e.candidate,scoreNarrativeDirectorCandidate(ledger,{chatKey:'chat-a',viewerId:'user'}));
  e.context.directorCandidatePoolState.ledger.entries=[ledger];e.state.directorBridge.worldAutoGenerate=true;e.state.automation.autoGenerate=false;
  if(comfy)e.state.connections.comfy.draft.baseUrl='https://comfy.fixture.invalid';
  const transport=streamCheckpointTransport(e.namespace),load=e.context.featureRuntime.load,rows=new Map(),checks=[];
  transport.configure();
  e.context.featureRuntime.load=async key=>key==='worldAutomatic'?{...worldAutomatic,
    beginWorldAutomaticAttempt:options=>worldAutomatic.beginWorldAutomaticAttempt({...options,createStorage:transport.createStorage}),
    verifySavedWorldAutomaticApproval:(approval,options)=>{checks.push('saved');return worldAutomatic.verifySavedWorldAutomaticApproval(approval,{...options,createStorage:transport.createStorage});},
  }:load(key);
  e.context.storyboardCallCompiler=async(messages,profile,options)=>{
    e.calls.push('llm');e.lastRequest={messages,profile,options};
    const claims=[...transport.files.values()].map(JSON.parse).filter(row=>row.value?.schema==='qianmu.world-automatic-attempt.v1');
    assert.ok(claims.some(row=>row.value.record.status==='preparing'),'model must not run ahead of durable preparation');
    return JSON.stringify({schema:world.WORLD_RENDERING_SCHEMA,prompt_renderings:renderingsFor(JSON.parse(messages[1].content).shot,options.promptFormats),...(options.jsonSchema.properties.gallery_keywords?{gallery_keywords:[]}:{} )});
  };
  const run=(scope,apply)=>{const key=imageAttemptScopeKey(scope),result=apply(rows.get(key));rows.set(key,structuredClone(result.ledger));return result;};
  const admission=createImageAdmission({account:async()=>e.namespace,ownerId:'world-page',
    resolveWorldApproval:(job,approval)=>e.context.storyboardVerifyWorldAutomaticApproval(job,approval),
    store:{claim:async(scope,input,seeds)=>run(scope,value=>claimImageAttempt(importImageAttempts(value,scope,seeds,1000),scope,input,1000)),
      settle:async(scope,input)=>run(scope,value=>settleImageAttempt(value,scope,input,1000)),close(){}}});
  Object.assign(e.context,{storyboardQueue:[],storyboardActiveJobs:new Map(),STORYBOARD_QUEUE_LIMIT:20,
    storyboardCredentialId:()=> 'test-key',storyboardAnchorForMessage:()=>null,uniqueClean:items=>[...new Set(items.filter(Boolean))],
    storyboardAdaptShotForModel:async shot=>shot,confirmDialog:async()=>assert.fail('automatic world must not open dialogs'),
    STORYBOARD_SHOT_TYPE_LABELS:{portrait:'',environment:'',custom:''},storyboardImageAdmissionRuntime:async()=>admission,
    storyboardConfirmComfyExecution:async()=>true,storyboardPumpQueue(){},renderModal(){},storyboardPlanForJob:()=>null,storyboardSetPlanStatus(){},
    storyboardStartLog:job=>{const log={id:'log-'+job.id,status:'queued',snapshot:structuredClone(job)};e.state.logs.push(log);return log;},
  });
  useActualWorldGeneration(e,['storyboardPromptsForArtist','storyboardJoinPrompt','storyboardProfileSnapshot','storyboardResolveRoutingProfile',
    'storyboardGenerationPayload','storyboardCreateJob','storyboardPlanHasGeneration','storyboardPrepareDraftGroup','storyboardGenerate',
    'storyboardVerifyWorldAutomaticApproval','storyboardSettleImageAdmission','storyboardQueueJob']);
  return {...e,transport,checks,admission,source,runAutomatic:()=>e.context.storyboardGenerateProductionPacket(null,'packet-a',{automatic:true})};
}

async function nativeWorldEnsembleHarness({comfy=false,artist=false}={}){
  const e=await automaticWorldHarness({comfy});e.state.routing.styleLibrary=true;
  if(comfy)e.context.storyboardPreflightComfyForCompiler=async(_state,_profile,_plan,_input,_automatic,_ticket,routes)=>{
    assert.equal(routes.length,1);assert.deepEqual(copy(routes[0].comfyWorkflowBinding),copy(e.recipe.binding));return [{localConfigurationReady:true}];
  };
  else {const providerId=artist?'novel':'banana';e.state.routing.rules=[{id:'world-style',enabled:true,shotTypes:[],target:{providerId,modelId:e.context.storyboardProviderProfile(e.state,providerId).model}}];}
  if(artist)e.state.artistPresets.push({id:'world-artist',name:'World ink',value:'ink style',positivePrompt:'ink world texture',negativePrompt:'flat shading'});
  const store=await createEnsembleStorage({namespace:e.namespace,chatKey:'chat-a',isCurrent:()=>true,resolveNamespace:async()=>e.namespace});
  try{
    const library=await store.readLibrary();await store.saveLibrary({...library.value,schemes:[{id:'alternative',revision:'r1',name:'世界画风',description:'突出幕后世界氛围',tags:['气氛'],archived:false,
      binding:{routeId:comfy?'world-fixed':'world-style',artistPresetId:artist?'world-artist':''}}]},library);
    const selection=await store.readSelection();await store.saveSelection({...selection.value,revision:'s1',enabled:true,schemeIds:['alternative']},selection);
  }finally{store.close();}
  const call=e.context.storyboardCallCompiler;
  e.context.storyboardCallCompiler=async(...args)=>{e.lastRequest={messages:args[0],profile:args[1],options:args[2]};assert.ok(JSON.parse(args[0][1].content).style_catalogue,JSON.stringify(e.context.worldStyleExcluded));const value=JSON.parse(await call(...args));
    value.style_selections=[{shot_id:'S1',scheme_id:'alternative',reason:'突出已确认世界画面的氛围'}];return JSON.stringify(value);};
  return e;
}

const renderingsFor=(shot,requested)=>Object.fromEntries(requested.map(format=>[format,{global:'kitchen, soft light',negative:'blurred details',
  characters:shot.characters.map(row=>({character_id:row.id,positive:'blue hair, no coat, stirs soup'}))}]));

for(const comfy of [false,true])test(`actual ${comfy?'Comfy':'NAI'} world host uses preset keywords once and retains them in job, log, retry and gallery metadata`,async()=>{
  const e=await automaticWorldHarness({comfy});try{
    e.state.galleryKeywords=['未选全局词'];e.state.promptPresets=[{id:'world-keywords',items:[],galleryKeywords:['夜色','相伴']}];e.state.promptCompiler.instructionPresetId='world-keywords';
    const call=e.context.storyboardCallCompiler;e.context.storyboardCallCompiler=async(...args)=>{
      const result=JSON.parse(await call(...args)),payload=JSON.parse(args[0][1].content);
      assert.deepEqual(payload.gallery_keyword_vocabulary,['夜色','相伴']);assert.equal(payload.shot.gallery_keywords,undefined);
      result.gallery_keywords=['夜色','相伴'];return JSON.stringify(result);
    };
    Object.assign(e.context,{STORYBOARD_PIPELINE_LOG_LIMIT:40,storyboardItemCollectionIds:()=>[]});
    vm.runInContext(['storyboardStartLog','storyboardCreateRecord','storyboardJobFromLog'].map(section).join('\n'),e.context);
    assert.equal(await e.runAutomatic(),true,e.notices.join(';'));assert.equal(e.calls.filter(row=>row==='llm').length,1);
    const job=e.context.storyboardQueue[0],log=e.state.logs.find(row=>row.id===job.logId);
    assert.deepEqual(copy(job.tags),['夜色','相伴']);assert.deepEqual(copy(log.snapshot.tags),['夜色','相伴']);
    const restored=core.normalizeStoryboardState(copy(e.state)).logs.find(row=>row.id===log.id),retry=e.context.storyboardJobFromLog(restored);
    assert.deepEqual(copy(retry.tags),['夜色','相伴']);assert.doesNotMatch(JSON.stringify(job.payload),/夜色|相伴/);
    const record=e.context.storyboardCreateRecord(job,log,'https://world.invalid/image',0,{floor:null,message:null},{});
    assert.deepEqual(copy(record.tags),['夜色','相伴']);assert.equal(record.floor,null);assert.equal(record.inline,false);
  }finally{await e.admission.close();}
});

test('world keyword changes during a model reply cancel the result before any image job is created',async()=>{
  const e=await automaticWorldHarness();try{
    const call=e.context.storyboardCallCompiler;e.context.storyboardCallCompiler=async(...args)=>{const result=await call(...args);e.state.galleryKeywords=['changed'];return result;};
    assert.equal(await e.runAutomatic(),false);assert.equal(e.context.storyboardQueue.length,0);assert.equal(e.calls.filter(row=>row==='llm').length,1);
  }finally{await e.admission.close();}
});

async function completedWorldHarness(){
  const e=await automaticWorldHarness(),store={plan:{npc_updates:[{name:'Alice',next_action:'stirs soup'}]},directorPlanRevisionId:'completed-1',lastPlanIdx:0};
  const load=e.context.featureRuntime.load;e.context.settings.enabled=true;
  Object.assign(e.context,{storyboardWorldAutomaticRuntime:null,storyboardWorldAutomaticEpoch:0,storyboardAutomaticCurrent:null,
    storyboardAutomaticPending:new Map(),storyboardAutomaticTimer:null,storyboardStreamRuntime:null,getChatStore:()=>store,
    console:{warn(){}},directorWorldSourceRefreshKey:'',directorWorldEntryLinks:new Map()});
  e.context.featureRuntime.load=async key=>({worldAutomaticHost,productionPacket:productionPackets,narrativeLedger:ledgerRuntime,directorCandidates:candidateRuntime}[key]||load(key));
  vm.runInContext(['directorWorldPlanRevision','directorWorldPlanSignature','storyboardResetWorldAutomatic','resetDirectorNarrativeBridge',
    'refreshDirectorCandidatePool','refreshDirectorProductionPackets','storyboardQueueNewWorldPlan','storyboardScheduleAutomaticCapture'].map(name=>section(name).split(/\r?\n\}/)[0]+'\n}').join('\n'),e.context);
  const schedule=()=>e.context.storyboardQueueNewWorldPlan(store.plan,{store,chatKey:'chat-a',namespace:e.namespace});
  const idle=async()=>{for(let i=0;i<200;i++){
    await new Promise(resolve=>setTimeout(resolve,5));const status=e.context.storyboardWorldAutomaticRuntime?.snapshot();
    if(!status||!status.active&&!status.waiting&&!status.scheduled)return;
  }assert.fail('world batch did not finish');};
  return {...e,store,schedule,idle,close:async()=>{e.context.storyboardResetWorldAutomatic();await e.admission.close();}};
}

test('actual completed-plan host builds sources and saved attempts, then uses the actual gallery queue once',async()=>{
  const e=await completedWorldHarness();try{
    assert.equal(await e.schedule(),true);await e.idle();assert.equal(e.context.storyboardQueue.length,1,e.notices.join(';'));
    assert.equal(e.calls.filter(v=>v==='llm').length,1);assert.equal(e.context.storyboardCompilerBusy,false);assert.equal(e.state.prompt,'original');
    assert.equal(await e.schedule(),false);await e.idle();assert.equal(e.context.storyboardQueue.length,1);
  }finally{await e.close();}
});

test('actual completed-plan host is dormant for auto-off, disabled master, unadopted plan or changed account',async()=>{
  for(const kind of ['auto','master','plan','account']){
    const e=await completedWorldHarness();try{
      if(kind==='auto')e.state.directorBridge.worldAutoGenerate=false;
      if(kind==='master')e.state.enabled=false;
      if(kind==='account')e.setAccount('st-user:other');
      if(kind==='plan')await e.context.storyboardQueueNewWorldPlan({}, {store:e.store,chatKey:'chat-a',namespace:e.namespace});else await e.schedule();
      await e.idle();assert.equal(e.calls.includes('llm'),false);assert.equal(e.context.storyboardQueue.length,0);assert.equal(e.transport.calls.length,0);
    }finally{await e.close();}
  }
});

test('actual world completion waits for the ordinary compiler and only resumes through its shared wake',async()=>{
  const e=await completedWorldHarness();try{
    e.context.storyboardCompilerBusy=true;await e.schedule();await new Promise(setImmediate);assert.equal(e.calls.includes('llm'),false);assert.equal(e.transport.calls.length,0);
    e.context.storyboardCompilerBusy=false;e.context.storyboardScheduleAutomaticCapture();await e.idle();assert.equal(e.context.storyboardQueue.length,1,e.notices.join(';'));
  }finally{await e.close();}
});

test('world expression holds the actual compiler exclusively and releases only its own lease',async()=>{
  const e=await completedWorldHarness(),call=e.context.storyboardCallCompiler;let checked=false;try{
    vm.runInContext(section('storyboardCompilePrompt'),e.context);
    e.context.storyboardCallCompiler=async(...args)=>{
      assert.equal(typeof e.context.storyboardCompilerBusy,'object');checked=true;
      assert.equal(await e.context.storyboardCompilePrompt(null),false);assert.equal(await e.runAutomatic(),false);
      return call(...args);
    };
    await e.schedule();await e.idle();assert.equal(checked,true);assert.equal(e.context.storyboardCompilerBusy,false);assert.equal(e.context.storyboardQueue.length,1,e.notices.join(';'));
  }finally{await e.close();}
});

test('actual batch-wide expression budget is three repairs across two independent world sources',async()=>{
  const e=await completedWorldHarness();let calls=0;try{
    e.state.directorBridge.worldAutoMaxImages=2;e.store.plan.world_updates=[{title:'Weather',content:'rain in garden'}];
    e.context.storyboardCallCompiler=async()=>{calls++;return 'invalid';};await e.schedule();await e.idle();
    assert.equal(calls,5,e.notices.join(';'));assert.equal(e.context.storyboardQueue.length,0);assert.equal(e.context.storyboardCompilerBusy,false);
    assert.equal(await e.schedule(),false);assert.equal(calls,5);
  }finally{await e.close();}
});

test('resetting the actual automatic world host during expression never queues late results or strands its compiler lease',async()=>{
  const e=await completedWorldHarness(),call=e.context.storyboardCallCompiler;let mark;const reached=new Promise(resolve=>{mark=resolve;});try{
    e.context.storyboardCallCompiler=async(...args)=>{const result=await call(...args);e.context.storyboardResetWorldAutomatic();mark();return result;};
    await e.schedule();await reached;for(let i=0;i<100&&e.context.storyboardCompilerBusy!==false;i++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(e.context.storyboardQueue.length,0);assert.equal(e.context.storyboardCompilerBusy,false);assert.equal(e.state.prompt,'original');
  }finally{await e.close();}
});

for(const comfy of [false,true])test(`automatic world ${comfy?'fixed Comfy':'NAI'} reaches the real gallery queue without dialogs, public draft mutation or prose opt-in`,async()=>{
  const e=await automaticWorldHarness({comfy});try{
    const before=copy(e.state.promptDraft);assert.equal(await e.runAutomatic(),true,e.notices.join(';')+' '+JSON.stringify(e.state.pipelineLogs.map(row=>row.stages.map(stage=>stage.error))));
    assert.equal(e.calls.includes('confirm'),false);assert.equal(e.calls.filter(value=>value==='llm').length,1);
    assert.equal(e.context.storyboardQueue.length,1);const job=e.context.storyboardQueue[0];
    assert.equal(job.automatic,true);assert.equal(job.profile.count,'1');assert.equal(job.target,'gallery');assert.equal(job.floor,null);
    assert.equal(job.shotSpec.directorDecision.approval.mode,'world_setting');assert.match(job.imageAdmission.messageKey,/^world-item:/);
    assert.deepEqual(e.state.promptDraft,before);assert.equal(e.state.prompt,'original');assert.equal(e.checks.length,2);
    const rows=[...e.transport.files.values()].map(JSON.parse);assert.ok(rows.some(row=>row.value?.record?.status==='queued'));
    assert.equal(await e.runAutomatic(),false);assert.equal(e.context.storyboardQueue.length,1);assert.equal(e.calls.filter(value=>value==='llm').length,1);
  }finally{await e.admission.close();}
});

test('automatic world off or absent source produces no model request, confirmation or image',async()=>{
  const e=await automaticWorldHarness();try{
    e.state.directorBridge.worldAutoGenerate=false;assert.equal(await e.runAutomatic(),false);assert.equal(e.transport.calls.length,0);
    e.state.directorBridge.worldAutoGenerate=true;delete e.packet.sourceRef.worldSource;
    assert.equal(await e.runAutomatic(),false);assert.equal(e.calls.includes('llm'),false);assert.equal(e.calls.includes('confirm'),false);assert.equal(e.context.storyboardQueue.length,0);
  }finally{await e.admission.close();}
});

for(const kind of ['prose-draft','unused-route','both'])test(`native world generation isolates ${kind} and still reaches its independent gallery queue`,async()=>{
  const e=await automaticWorldHarness();try{
    e.state.routing.styleLibrary=true;e.state.routing.enabled=true;
    if(kind!=='unused-route')Object.assign(e.state.promptDraft,{ensembleRequired:true,ensembleSelection:{scheme:'prose-style'},futureProseReceipt:'private-prose-receipt'});
    if(kind!=='prose-draft')e.state.routing.rules=[{id:'unused',name:'unused old route',enabled:true,shotTypes:[],target:{providerId:'novel',modelId:e.state.profiles.novel.model,connectionPresetId:'missing-connection'}}];
    const before=copy(e.state.promptDraft);assert.equal(await e.runAutomatic(),true,e.notices.join(';'));
    assert.equal(e.context.storyboardQueue.length,1);const job=e.context.storyboardQueue[0];
    assert.equal(job.source,'novel');assert.equal(job.target,'gallery');assert.match(job.imageAdmission.messageKey,/^world-item:/);
    assert.equal(Object.hasOwn(e.context.worldDraft.promptDraft,'ensembleRequired'),false);assert.equal(job.ensembleStyleOrigin,undefined);
    assert.deepEqual(e.state.promptDraft,before);assert.equal(e.calls.filter(value=>value==='llm').length,1);
    assert.equal(await e.runAutomatic(),false);assert.equal(e.context.storyboardQueue.length,1);
  }finally{await e.admission.close();}
});

test('the unchanged legacy world mode still refuses a broken configured route',async()=>{
  const e=await automaticWorldHarness();try{
    e.state.routing.enabled=true;e.state.routing.rules=[{id:'bad',enabled:true,shotTypes:[],target:{providerId:'novel',modelId:e.state.profiles.novel.model,connectionPresetId:'missing-connection'}}];
    assert.equal(await e.runAutomatic(),false);assert.equal(e.context.storyboardQueue.length,0);assert.equal(e.calls.includes('llm'),false);
  }finally{await e.admission.close();}
});

for(const mode of ['closed','artist','comfy'])test(`native world ${mode} style is selected in one expression call and reaches the existing independent gallery queue`,async()=>{
  const e=await nativeWorldEnsembleHarness({comfy:mode==='comfy',artist:mode==='artist'});try{
    const before=copy(e.state.promptDraft);assert.equal(await e.runAutomatic(),true,e.notices.join(';')+' '+JSON.stringify(e.state.pipelineLogs.map(row=>row.stages.map(stage=>stage.error))));
    assert.equal(e.calls.filter(value=>value==='llm').length,1);assert.equal(e.context.storyboardQueue.length,1);
    const job=e.context.storyboardQueue[0];assert.equal(job.source,mode==='comfy'?'comfy':mode==='artist'?'novel':'banana');
    assert.equal(job.ensembleStyleOrigin.schemeId,'alternative');assert.equal(job.target,'gallery');assert.match(job.imageAdmission.messageKey,/^world-item:/);
    assert.deepEqual(copy(job.compilerStages.find(row=>row.type==='ensemble_style').output),{schemeId:'alternative',name:'世界画风',reason:'突出已确认世界画面的氛围'});
    if(mode==='artist')assert.equal(job.artistPresetId,'world-artist');
    if(mode==='comfy')assert.deepEqual(copy(job.profile.comfyRouteBinding),copy(e.recipe.binding));
    const sent=JSON.parse(e.lastRequest.messages[1].content);assert.deepEqual(sent.style_catalogue.map(row=>row.id),['current','alternative']);
    assert.doesNotMatch(JSON.stringify(sent),/apiKey|baseUrl|comfyWorkflow|PRIVATE-QUALIFICATION|original/);
    assert.deepEqual(e.state.promptDraft,before);assert.equal(await e.runAutomatic(),false);assert.equal(e.context.storyboardQueue.length,1);
  }finally{await e.admission.close();}
});

for(const styleLock of [false,true])test(`native world current style resolves its actual automatic Comfy pool before queueing, style lock ${styleLock}`,async()=>{
  const e=await nativeWorldEnsembleHarness({comfy:true}),auto=await installWorldComfyAuto(e,{styleLock});
  try{
    const call=e.context.storyboardCallCompiler;e.context.storyboardCallCompiler=async(...args)=>{
      const value=JSON.parse(await call(...args));value.style_selections=[{shot_id:'S1',scheme_id:'current',reason:'沿用当前世界画风'}];return JSON.stringify(value);
    };
    const original=copy(e.state.promptDraft);assert.equal(e.state.profiles.comfy.comfyWorkflow,'');
    assert.equal(await e.runAutomatic(),true,e.notices.join(';')+' '+JSON.stringify(e.state.pipelineLogs));
    assert.equal(e.calls.filter(row=>row==='llm').length,1);assert.equal(e.context.storyboardQueue.length,1);
    const job=e.context.storyboardQueue[0];assert.equal(job.ensembleStyleOrigin.schemeId,'current');assert.equal(job.source,'comfy');
    assert.equal(job.profile.comfyRouteBinding.id,e.recipe.binding.id);assert.equal(job.target,'gallery');assert.equal(job.inlineByDefault,false);
    assert.ok(job.comfyAutoSelected);assert.ok(auto.network.length>0);assert.ok(auto.network.every(row=>row.method==='GET'));
    assert.equal(job.compilerStages.filter(row=>row.type==='comfy_selection').length,1);assert.equal(job.compilerStages.filter(row=>row.type==='ensemble_style').length,1);
    assert.deepEqual(e.state.promptDraft,original);assert.equal(await e.runAutomatic(),false);assert.equal(e.context.storyboardQueue.length,1);
  }finally{await auto.close();await e.admission.close();}
});

test('native world fixed style bypasses current auto-pool selection but still checks its real Comfy graph',async()=>{
  const e=await nativeWorldEnsembleHarness({comfy:true}),auto=await installWorldComfyAuto(e);
  try{
    assert.equal(await e.runAutomatic(),true,e.notices.join(';'));const job=e.context.storyboardQueue[0];
    assert.equal(job.ensembleStyleOrigin.schemeId,'alternative');assert.equal(job.comfyAutoSelected,undefined);assert.ok(auto.network.length>0);
    assert.equal(job.compilerStages.filter(row=>row.type==='comfy_selection').length,0);assert.equal(job.profile.comfyRouteBinding.id,e.recipe.binding.id);
  }finally{await auto.close();await e.admission.close();}
});

for(const emptyChat of [false,true])test(`native world missing Comfy node stops without a prose retry, empty chat ${emptyChat}`,async()=>{
  const e=await nativeWorldEnsembleHarness({comfy:true}),auto=await installWorldComfyAuto(e,{missing:'EmptyImage'});
  try{
    if(emptyChat)e.context.ctx().chat.splice(0);
    const call=e.context.storyboardCallCompiler;e.context.storyboardCallCompiler=async(...args)=>{
      const value=JSON.parse(await call(...args));value.style_selections=[{shot_id:'S1',scheme_id:'current',reason:'沿用当前世界画风'}];return JSON.stringify(value);
    };
    assert.equal(await e.runAutomatic(),false);assert.equal(e.context.storyboardQueue.length,0);assert.ok(auto.network.length>0);
    assert.match(e.notices.join(';'),/工作流|Comfy|节点/);assert.equal(e.calls.filter(row=>row==='llm').length,1);
    assert.equal(e.state.logs.some(row=>row.kind==='comfy_preparation'),false,'world failures must not borrow an unrelated prose floor retry');
    const log=e.state.logs.find(row=>row.promptOrigin==='world');assert.ok(log);assert.equal(log.snapshot,null);assert.equal(log.floor,null);
    const last=e.state.pipelineLogs.find(row=>row.id===log.pipelineId).stages.at(-1);assert.equal(last.type,'world_workflow_preparation');
    assert.equal(last.output.code,'world_workflow_preparation');assert.match(JSON.stringify(last.output.diagnostics),/EmptyImage/);
    assert.equal(await e.runAutomatic(),false);assert.equal(e.calls.filter(row=>row==='llm').length,1);assert.equal(e.state.prompt,'original');
  }finally{await auto.close();await e.admission.close();}
});

test('native world account departure during actual node checks rejects the late result and never queues',async()=>{
  const e=await nativeWorldEnsembleHarness({comfy:true}),auto=await installWorldComfyAuto(e,{afterRead:()=>e.setAccount('st-user:departed')});
  try{
    const call=e.context.storyboardCallCompiler;e.context.storyboardCallCompiler=async(...args)=>{
      const value=JSON.parse(await call(...args));value.style_selections=[{shot_id:'S1',scheme_id:'current',reason:'沿用当前世界画风'}];return JSON.stringify(value);
    };
    assert.equal(await e.runAutomatic(),false);assert.ok(auto.network.length);assert.equal(e.context.storyboardQueue.length,0);assert.equal(e.state.prompt,'original');
    assert.equal(e.calls.filter(row=>row==='llm').length,1);assert.equal(e.state.logs.some(row=>row.kind==='comfy_preparation'),false);
  }finally{await auto.close();await e.admission.close();}
});

for(const unavailable of ['disabled','archived','connection'])test(`native world ${unavailable} alternative is excluded without reviving legacy routing`,async()=>{
  const e=await nativeWorldEnsembleHarness();try{
    e.state.routing.enabled=true;
    e.state.routing.rules[0].shotTypes=['portrait','custom','environment'];
    if(unavailable==='disabled')e.state.routing.rules[0].enabled=false;
    if(unavailable==='connection')e.state.routing.rules[0].target.connectionPresetId='missing';
    if(unavailable==='archived'){
      const store=await createEnsembleStorage({namespace:e.namespace,chatKey:'chat-a',isCurrent:()=>true,resolveNamespace:async()=>e.namespace});
      try{const library=await store.readLibrary(),value=copy(library.value);Object.assign(value.schemes[0],{archived:true,revision:'r2'});await store.saveLibrary(value,library);}finally{store.close();}
    }
    e.context.storyboardCallCompiler=async(messages,_profile,options)=>{e.calls.push('llm');const payload=JSON.parse(messages[1].content);
      assert.equal(payload.style_catalogue,undefined);
      return JSON.stringify({schema:world.WORLD_RENDERING_SCHEMA,prompt_renderings:renderingsFor(payload.shot,options.promptFormats),...(options.jsonSchema.properties.gallery_keywords?{gallery_keywords:[]}:{} )});
    };
    assert.equal(await e.runAutomatic(),true,e.notices.join(';'));assert.equal(e.context.storyboardQueue[0].source,'novel');
    assert.equal(e.context.storyboardQueue[0].ensembleStyleOrigin,undefined);assert.equal(e.notices.filter(row=>row.includes('1 个风格方案暂不可用，本次已排除')).length,1);
  }finally{await e.admission.close();}
});

for(const change of ['unknown','missing','extra-shot'])test(`native world ${change} style is repaired at most three times without fallback or image submission`,async()=>{
  const e=await nativeWorldEnsembleHarness();try{
    const call=e.context.storyboardCallCompiler;e.context.storyboardCallCompiler=async(...args)=>{
      const value=JSON.parse(await call(...args));
      if(change==='unknown')value.style_selections[0].scheme_id='invented';
      if(change==='missing')delete value.style_selections;
      if(change==='extra-shot')value.style_selections.push({...value.style_selections[0],shot_id:'S2'});
      return JSON.stringify(value);
    };
    assert.equal(await e.runAutomatic(),false);assert.equal(e.calls.filter(row=>row==='llm').length,4);
    assert.equal(e.context.storyboardQueue.length,0);assert.match(e.notices.join(';'),/已修复3次/);
    assert.equal(await e.runAutomatic(),false);assert.equal(e.calls.filter(row=>row==='llm').length,4);
  }finally{await e.admission.close();}
});

for(const change of ['account','route','artist','source'])test(`native world ${change} changes after selection cannot reach image admission`,async()=>{
  const e=await nativeWorldEnsembleHarness({artist:true});try{
    const call=e.context.storyboardCallCompiler;e.context.storyboardCallCompiler=async(...args)=>{
      const raw=await call(...args);
      if(change==='account')e.setAccount('st-user:changed');
      if(change==='route')e.state.routing.rules[0].target.modelId='nai-diffusion-3';
      if(change==='artist')e.state.artistPresets[0].positivePrompt='changed';
      if(change==='source')e.candidate.recommendation='reject';
      return raw;
    };
    assert.equal(await e.runAutomatic(),false);assert.equal(e.context.storyboardQueue.length,0);
    assert.equal(e.calls.filter(row=>row==='llm').length,1);assert.equal(e.state.prompt,'original');
  }finally{await e.admission.close();}
});

test('native world explicit manual expression uses current style with no LLM or workbench mutation',async()=>{
  const e=await nativeWorldEnsembleHarness({artist:true});try{
    const load=e.context.featureRuntime.load;e.context.featureRuntime.load=async key=>{
      const runtime=await load(key);return key==='worldShot'?{...runtime,openWorldShotConfirmation:async options=>{
        await options.guard();assert.equal(typeof options.useManualStyle,'function');options.useManualStyle(options.shot);
        return {...options.shot,promptRenderingPack:await formats.bindStoryboardPromptRenderings(options.shot,renderingsFor(options.shot,options.promptFormats),{formats:options.promptFormats})};
      }}:runtime;
    };
    assert.equal(await e.run(),true,e.notices.join(';'));assert.equal(e.calls.includes('llm'),false);
    const job=e.context.storyboardQueue[0];assert.equal(job.source,'novel');assert.equal(job.ensembleStyleOrigin.schemeId,'current');
    assert.notEqual(job.artistPresetId,'world-artist');assert.equal(e.state.prompt,'original');
  }finally{await e.admission.close();}
});

test('native world fresh Comfy generation does not revive retired character injection from a style binding',async()=>{
  for(const enabled of [false,true]){
    const e=await nativeWorldEnsembleHarness({comfy:true});try{
      e.state.routing.rules[0].target.comfyCharacterEnabled=enabled;
      assert.equal(await e.runAutomatic(),true,e.notices.join(';'));
      const job=e.context.storyboardQueue[0],snapshot=job.shotSpec.characters[0].archiveSnapshot;
      assert.equal(snapshot.comfyImplementation,undefined);assert.equal(job.profile.comfyCharacterEnabled,false);
      assert.doesNotMatch(JSON.stringify(e.lastRequest.messages),/comfyImplementation|archiveRevision|workflowHash/);
    }finally{await e.admission.close();}
  }
});

test('native world retains an enabled NAI reference mode even when its workbench is a different engine',async()=>{
  const e=await nativeWorldEnsembleHarness({artist:true});try{
    e.state.source='banana';e.state.profiles.novel.characterReferenceEnabled=true;
    e.state.profiles.novel.model=e.state.routing.rules[0].target.modelId='nai-diffusion-4-5-full';e.state.profiles.novel.capabilityModelId='nai-diffusion-4-5-full';
    Object.assign(e.context,{planCharacterReference,assertCharacterReferencePlan,characterReferenceNotice});
    vm.runInContext(section('storyboardCharacterReferencePlan'),e.context);
    assert.equal(await e.runAutomatic(),true,e.notices.join(';'));
    const job=e.context.storyboardQueue[0];assert.equal(job.source,'novel');assert.equal(job.profile.characterReferenceEnabled,true);
    assert.ok(job.shotSpec.characters[0].archiveSnapshot.imageReference);
    assert.doesNotMatch(JSON.stringify(e.lastRequest.messages),/imageReference/);
  }finally{await e.admission.close();}
});

test('native world can repair a failed style choice without replaying earlier narration or creating a second image',async()=>{
  const e=await nativeWorldEnsembleHarness();try{
    const call=e.context.storyboardCallCompiler;let requests=0;e.context.storyboardCallCompiler=async(...args)=>{
      const value=JSON.parse(await call(...args));if(++requests===1)value.style_selections[0].scheme_id='invented';return JSON.stringify(value);
    };
    assert.equal(await e.runAutomatic(),true,e.notices.join(';'));assert.equal(requests,2);assert.equal(e.context.storyboardQueue.length,1);
    assert.equal(e.context.storyboardQueue[0].ensembleStyleOrigin.schemeId,'alternative');
    assert.deepEqual(e.lastRequest.messages.map(row=>JSON.parse(row.content).operation).filter(Boolean),['render_confirmed_visual_facts']);
  }finally{await e.admission.close();}
});

test('automatic world exhausts three format repairs once and never replays the failed source',async()=>{
  const e=await automaticWorldHarness();let calls=0;try{
    e.context.storyboardCallCompiler=async()=>{calls++;return 'not JSON';};assert.equal(await e.runAutomatic(),false);assert.equal(calls,4);assert.match(e.notices.join(';'),/已修复3次/);
    assert.equal(e.context.storyboardQueue.length,0);assert.equal(e.state.prompt,'original');assert.equal(await e.runAutomatic(),false);assert.equal(calls,4);
  }finally{await e.admission.close();}
});

test('turning world automation off during expression preparation prevents queueing without changing the workbench',async()=>{
  const e=await automaticWorldHarness(),call=e.context.storyboardCallCompiler;try{
    e.context.storyboardCallCompiler=async(...args)=>{const value=await call(...args);e.state.directorBridge.worldAutoGenerate=false;return value;};
    assert.equal(await e.runAutomatic(),false);assert.equal(e.context.storyboardQueue.length,0);assert.equal(e.state.prompt,'original');assert.equal(e.context.storyboardGenerationPreparing.size,0);
  }finally{await e.admission.close();}
});

test('actual world format exhaustion saves one non-image diagnostic with all four requests and archives by pipeline identity',async()=>{
  const e=await automaticWorldHarness();let calls=0;try{
    e.context.storyboardCallCompiler=async(_m,_p,o)=>{calls++;o.onResponse({text:'bad world JSON',finishReason:'stop',complete:true,usage:{total_tokens:11}});return 'bad world JSON';};
    assert.equal(await e.runAutomatic(),false);assert.equal(calls,4);assert.equal(e.state.logs.length,1);
    const log=e.state.logs[0],pipeline=e.state.pipelineLogs[0];assert.equal(log.promptOrigin,'world');assert.equal(log.snapshot,null);assert.equal(log.pipelineId,pipeline.id);
    assert.equal(pipeline.stages.length,5);assert.equal(pipeline.stages.slice(0,4).reduce((n,row)=>n+row.output.response.usage.total_tokens,0),44);
    assert.ok(e.calls.some(row=>Array.isArray(row)&&row[0]==='archive'&&row[1]===log.pipelineId));
    assert.equal(await e.runAutomatic(),false);assert.equal(e.state.logs.length,1);assert.equal(calls,4);assert.equal(e.context.storyboardQueue.length,0);
  }finally{await e.admission.close();}
});
test('actual world transport error makes one request, keeps partial output and masks credentials in both log and toast',async()=>{
  const e=await automaticWorldHarness();let calls=0;try{
    e.context.storyboardCallCompiler=async(_m,_p,o)=>{calls++;o.onResponse({text:'partial world',finishReason:'length',complete:false});throw Object.assign(Error('HTTP 429 Authorization: Bearer hidden-world-key'),{code:'MODEL_OUTPUT_INCOMPLETE'});};
    assert.equal(await e.runAutomatic(),false);assert.equal(calls,1);assert.equal(e.state.logs.length,1);
    assert.equal(e.state.pipelineLogs[0].stages[0].output.response.text,'partial world');assert.equal(e.state.logs[0].promptOrigin,'world');
    assert.doesNotMatch(JSON.stringify([e.state.logs,e.state.pipelineLogs,e.notices]),/hidden-world-key/);assert.equal(e.context.storyboardQueue.length,0);
  }finally{await e.admission.close();}
});
test('actual world late account change drops failure diagnostics and does not overwrite the new account',async()=>{
  const e=await automaticWorldHarness();try{
    e.context.storyboardCallCompiler=async()=>{e.setAccount('st-user:new');throw Error('late failure');};
    assert.equal(await e.runAutomatic(),false);assert.equal(e.state.logs.length,0);assert.equal(e.state.pipelineLogs.length,0);assert.equal(e.context.storyboardQueue.length,0);
  }finally{await e.admission.close();}
});
test('actual world diagnostic settings failure rolls logs back without masking the model error or enqueueing',async()=>{
  const e=await automaticWorldHarness();try{
    e.context.storyboardCallCompiler=async()=>{throw Error('HTTP 401 unauthorized');};e.context.saveSettings=()=>{throw Error('quota exceeded');};
    assert.equal(await e.runAutomatic(),false);assert.equal(e.state.logs.length,0);assert.equal(e.state.pipelineLogs.length,0);assert.match(e.notices.join(';'),/401/);
    assert.equal(e.context.storyboardQueue.length,0);assert.equal(e.state.prompt,'original');assert.equal(e.context.storyboardCompilerBusy,false);
  }finally{await e.admission.close();}
});

test('a world image accepted by the real queue remains accepted if final ST settlement loses its acknowledgement',async()=>{
  const e=await automaticWorldHarness(),queue=e.context.storyboardQueueJob;let lost=0;try{
    e.context.storyboardQueueJob=async(...args)=>{const result=await queue(...args);if(result)e.transport.hook=({path})=>{if(path==='/api/files/upload'){lost++;throw Error('lost settlement');}};return result;};
    assert.equal(await e.runAutomatic(),true,e.notices.join(';'));assert.equal(e.context.storyboardQueue.length,1);assert.equal(lost,1,JSON.stringify({notices:e.notices,methods:e.transport.calls.slice(-8).map(row=>row.options.method)}));assert.match(e.notices.join(';'),/已入队.*请勿重复/);
    e.transport.hook=null;assert.equal(await e.runAutomatic(),false);assert.equal(e.calls.filter(value=>value==='llm').length,1);assert.equal(e.context.storyboardQueue.length,1);
  }finally{await e.admission.close();}
});

test('real world entry refuses a stale plan before preparing characters or contacting a model',async()=>{
  const e=harness();
  e.context.directorProductionPacketState.sourceSignature='old-plan';
  e.context.directorWorldPlanSignature=()=> 'current-plan';
  assert.equal(await e.run(),false);
  assert.equal(e.calls.includes('confirm'),false);assert.equal(e.calls.includes('generate'),false);
  assert.equal(e.reads.length,0);assert.equal(e.state.prompt,'original');
});

test('real world entry checks the actual ledger before accepting mismatched material in the same chat',async()=>{
  for(const mutate of [
    e=>{e.packet.visualIntent.description='Alice burns a letter';},
    e=>{e.packet.timelineAnchor.revisionId='different-swipe';},
    e=>{e.candidate.candidateId='unrelated-candidate';},
    e=>{e.context.directorCandidatePoolState.ledger.entries[0].continuity={state:'invalidated',invalidatedBy:['source_deleted:packet-a']};},
  ]){
    const e=harness();mutate(e);
    assert.equal(await e.run(),false,e.notices.join(';'));
    assert.equal(e.calls.includes('confirm'),false);assert.equal(e.calls.includes('generate'),false);
    assert.equal(e.calls.includes('llm'),false);assert.equal(e.reads.length,0);
    assert.equal(e.state.prompt,'original');assert.equal(e.context.storyboardGenerationPreparing.size,0);
  }
});

async function classifiedWorld({confirm,format='tags'}={}){
  const e=harness({confirm:confirm || (async options=>({...options.shot,promptRenderingPack:await formats.bindStoryboardPromptRenderings(options.shot,await options.prepareRenderings(options.shot),{formats:options.promptFormats,guard:options.guard})}))});
  const f=await recipesFixture({formats:[format]});f.rows.forEach(row=>row.namespace=e.namespace);
  const recipe=await comfyRoutes.pinComfyRouteWorkflow({namespace:e.namespace,selection:f.rows[0],createStore:f.createStore});
  e.state.routing.enabled=true;e.state.routing.rules=[{id:'world-fixed',enabled:true,shotTypes:[],target:{providerId:'comfy',modelId:'comfy-workflow',comfyWorkflowBinding:recipe.binding,comfyCharacterEnabled:false}}];
  const load=e.context.featureRuntime.load;e.context.featureRuntime.load=async key=>key==='comfyRoutes'?{...comfyRoutes,prepareComfyRouteRecipes:options=>comfyRoutes.prepareComfyRouteRecipes({...options,createStore:f.createStore})}:load(key);
  e.context.storyboardCallCompiler=async(messages,profile,options)=>{
    e.calls.push('llm');e.lastRequest={messages,profile,options};
    return JSON.stringify({schema:world.WORLD_RENDERING_SCHEMA,prompt_renderings:renderingsFor(JSON.parse(messages[1].content).shot,options.promptFormats),...(options.jsonSchema.properties.gallery_keywords?{gallery_keywords:[]}:{} )});
  };
  vm.runInContext(['storyboardProfileSnapshot','storyboardResolveRoutingProfile'].map(section).join('\n'),e.context);
  return {...e,f,recipe};
}

test('classified world confirmation prepares exact expressions and the real shared Comfy job consumes them without rewriting visual facts',async()=>{
  const e=await classifiedWorld();
  const jobs=[];Object.assign(e.context,{storyboardQueue:[],storyboardActiveJobs:new Map(),STORYBOARD_QUEUE_LIMIT:20,
    storyboardQueueJob:async job=>{assert.deepEqual(formats.storyboardPromptRenderingSource(core.normalizeStoryboardShotSpec(job.payload.shotSpec)),formats.storyboardPromptRenderingSource(e.context.worldDraft.promptDraft.shots[0].shotSpec));await prepareComfyPromptJob(job,{prepare:true,namespace:e.namespace});await prepareComfyPromptJob(job,{namespace:e.namespace});jobs.push(job);return true;},
    storyboardCredentialId:()=> 'test-key',storyboardAnchorForMessage:()=>null,uniqueClean:items=>[...new Set(items.filter(Boolean))],storyboardAdaptShotForModel:async shot=>shot,
    confirmDialog:async()=>true,STORYBOARD_SHOT_TYPE_LABELS:{portrait:'',environment:'',custom:''}});
  useActualWorldGeneration(e,['storyboardPromptsForArtist','storyboardJoinPrompt','storyboardCompilerRoutes','storyboardGenerationPayload','storyboardCreateJob','storyboardPlanHasGeneration','storyboardPrepareDraftGroup','storyboardGenerate']);
  assert.equal(await e.run(),true,e.notices.join(';'));assert.equal(e.calls.filter(row=>row==='llm').length,1);
  const stages=e.context.worldDraft.pendingCompilerStages;assert.equal(stages[1].type,'world_prompt_rendering');assert.equal(stages[1].status,'success');
  assert.doesNotMatch(JSON.stringify(stages),/PRIVATE-QUALIFICATION/);
  const shot=e.context.worldDraft.promptDraft.shots[0].shotSpec;await world.verifyWorldPromptRenderings(shot,['tags']);
  assert.equal(shot.subject,'厨房');assert.equal(shot.characters[0].identity[0],'Alice silver hair');
  assert.equal(jobs.length,1);const job=jobs[0];assert.equal(job.target,'gallery');assert.equal(job.payload.promptRendering.format,'tags');
  assert.match(job.payload.prompt,/^kitchen, soft light/);assert.match(job.payload.prompt,/"Alice":/);
  assert.doesNotMatch(job.payload.prompt,/厨房|silver hair/);assert.match(job.payload.prompt,/blue hair, no coat, stirs soup/);
  assert.equal(job.shotSpec.subject,'厨房');assert.equal(job.shotSpec.productionContext.truthMode,'speculative');
});

test('world manual expression works without LLM and cancellation or stale confirmation preserves previous draft',async()=>{
  const e=await classifiedWorld({confirm:async options=>({...options.shot,promptRenderingPack:await formats.bindStoryboardPromptRenderings(options.shot,renderingsFor(options.shot,options.promptFormats),{formats:options.promptFormats})})});
  assert.equal(await e.run(),true,e.notices.join(';'));assert.equal(e.calls.includes('llm'),false);
  for(const reason of ['cancel','account','facts']){
    let e;e=await classifiedWorld({confirm:async options=>{
      const values=await options.prepareRenderings(options.shot);
      const shot={...options.shot,promptRenderingPack:await formats.bindStoryboardPromptRenderings(options.shot,values,{formats:options.promptFormats})};
      if(reason==='cancel')return null;if(reason==='account')e.setAccount('other');else shot.subject='different place';return shot;
    }});
    assert.equal(await e.run(),false);assert.equal(e.state.prompt,'original');assert.equal(e.calls.includes('generate'),false);
  }
});

test('invalid world rendering can be manually repaired after explicit retry; trace stays bounded and final pack is independently checked',async()=>{
  const e=await classifiedWorld({confirm:async options=>{
    for(let i=0;i<6;i++)await assert.rejects(()=>options.prepareRenderings(options.shot),/JSON/);
    return {...options.shot,promptRenderingPack:await formats.bindStoryboardPromptRenderings(options.shot,renderingsFor(options.shot,options.promptFormats),{formats:options.promptFormats})};
  }});
  e.context.storyboardCallCompiler=async()=>{e.calls.push('llm');return 'not json';};
  assert.equal(await e.run(),true,e.notices.join(';'));assert.equal(e.calls.filter(row=>row==='llm').length,6);
  assert.equal(e.context.worldDraft.pendingCompilerStages.length,5);assert.ok(e.context.worldDraft.pendingCompilerStages.slice(1).every(row=>row.status==='failed'&&row.output.response.text==='not json'));
  const logs=core.pruneStoryboardPipelineLogs([{id:'world-log',status:'success',stages:e.context.worldDraft.pendingCompilerStages}]);
  assert.equal(logs[0].stages[1].type,'world_prompt_rendering');assert.equal(logs[0].stages[1].status,'failed');
  const missing=await classifiedWorld({confirm:async options=>options.shot});assert.equal(await missing.run(),false);assert.equal(missing.calls.includes('generate'),false);
});

test('world auto candidates determine both prompt format union and casting, independently of the closed workbench and its inactive workflow',async()=>{
  const e=await classifiedWorld({confirm:async options=>{
    assert.deepEqual([...options.promptFormats],['tags','natural_language']);
    assert.equal(options.shot.characters[0].archiveSnapshot.comfyImplementation,undefined);
    assert.ok(options.shot.characters[0].identity.length,'general character appearance remains available');
    const renderings=await options.prepareRenderings(options.shot);
    return {...options.shot,promptRenderingPack:await formats.bindStoryboardPromptRenderings(options.shot,renderings,{formats:options.promptFormats})};
  }});
  e.state.comfyAutoEnabled=true;e.state.routing.rules[0].target={providerId:'comfy',modelId:'comfy-workflow'};
  e.state.profiles.comfy.comfyCharacterEnabled=false;let closed=0;
  const load=e.context.featureRuntime.load;e.context.featureRuntime.load=async key=>key==='comfyAuto'?{prepareComfyAutoSession:async()=>({
    candidates:[{id:'a',target:{comfyCharacterEnabled:false}},{id:'b',target:{comfyCharacterEnabled:true}}],promptFormats:['tags','natural_language'],close:()=>{closed++;},
  })}:load(key);
  assert.equal(await e.run(),true,e.notices.join(';'));assert.equal(e.state.source,'novel');assert.equal(closed,1);
  assert.deepEqual(Object.keys(e.context.worldDraft.promptDraft.shots[0].shotSpec.promptRenderingPack.renderings),['tags','natural_language']);
});

test('each closed world entry uses its exact expression format through the real compiler callback and explicit confirmation',async()=>{
  for(const family of ['novel','banana','openai','seedream']){
    let calls=0;const expected=family==='novel'?'tags':'natural_language';
    const e=harness({family,confirm:async options=>{
      assert.deepEqual([...options.promptFormats],[expected]);
      return {...options.shot,promptRenderingPack:await formats.bindStoryboardPromptRenderings(options.shot,await options.prepareRenderings(options.shot),{formats:options.promptFormats,guard:options.guard})};
    }});
    e.context.storyboardCallCompiler=async(messages,profile,options)=>{
      calls++;assert.deepEqual([...options.promptFormats],[expected]);assert.equal(options.jsonSchemaStrict,true);
      return JSON.stringify({schema:world.WORLD_RENDERING_SCHEMA,prompt_renderings:renderingsFor(JSON.parse(messages[1].content).shot,options.promptFormats),...(options.jsonSchema.properties.gallery_keywords?{gallery_keywords:[]}:{} )});
    };
    assert.equal(await e.run(),true,e.notices.join(';'));assert.equal(calls,1);assert.equal(e.state.source,family);
    assert.match(e.context.worldDraft.prompt,/kitchen, soft light/);assert.doesNotMatch(e.context.worldDraft.prompt,/厨房/);
    assert.equal(e.context.worldDraft.pendingCompilerStages[1].status,'success');assert.equal(e.state.prompt,'original');
  }
});
test('real entry awaits explicit confirmation, uses shared visible casting and hands one approved draft to the normal pipeline',async()=>{
  const e=harness();e.state.pendingCompilerStages=[{type:'prompt_compiler',input:'previous prose'}];assert.equal(await e.run(),true);assert.deepEqual(e.reads,['alice']);
  assert.ok(e.calls.indexOf('confirm')<e.calls.indexOf('generate'));assert.equal(e.calls.filter(x=>x==='generate').length,1);
  assert.equal(e.context.worldDraft.promptDraft.shots[0].shotSpec.characters[0].id,'archive:alice');
  assert.equal(e.context.worldDraft.promptDraft.shots[0].shotSpec.directorDecision.outputs.film,false);assert.equal(e.context.storyboardGenerationPreparing.size,0);
  assert.equal(e.context.worldDraft.pendingCompilerStages[0].type,'world_confirmation');assert.doesNotMatch(JSON.stringify(e.context.worldDraft.pendingCompilerStages),/previous prose|PRIVATE-QUALIFICATION/);
  assert.equal(e.state.prompt,'original');assert.equal(e.state.promptDraft.shots[0].id,'old-shot');assert.equal(e.state.pendingCompilerStages[0].input,'previous prose');assert.ok(!e.calls.includes('save'));
});
test('cancel preserves the prior prose draft and never compiles, saves it, or generates',async()=>{
  const e=harness({confirm:async()=>null}),before=copy(e.state.promptDraft);assert.equal(await e.run(),false);
  assert.deepEqual(copy(e.state.promptDraft),before);assert.equal(e.state.prompt,'original');assert.ok(!e.calls.includes('save'));assert.ok(!e.calls.includes('generate'));
});
test('chat, account, candidate rejection, epoch, draft and engine changes during confirmation cannot consume stale approval',async()=>{
  for (const change of [e=>e.setChat('chat-b'),e=>e.setAccount('st-user:other'),e=>e.candidate.recommendation='reject',
    e=>e.context.directorNarrativeBridgeEpoch++,e=>e.state.prompt='new prose',e=>e.state.source='banana']) {
    let e;e=harness({confirm:async options=>{change(e);return options.shot;}});assert.equal(await e.run(),false);
    assert.ok(!e.calls.includes('generate'));assert.equal(e.state.promptDraft.shots[0].id,'old-shot');assert.equal(e.context.storyboardGenerationPreparing.size,0);
  }
});
test('duplicate clicks open one confirmation and release the lock after cancellation',async()=>{
  let release,opened;const ready=new Promise(resolve=>{opened=resolve;});const e=harness({confirm:async()=>{opened();return new Promise(resolve=>{release=resolve;});}});
  const running=e.run();await ready;assert.equal(await e.run(),false);release(null);await running;
  assert.equal(e.calls.filter(x=>x==='confirm').length,1);assert.equal(e.context.storyboardGenerationPreparing.size,0);
});
test('the final routed engine determines private casting fields, not the visible workbench mode',async()=>{
  const e=harness();e.state.routing.enabled=true;e.state.profiles.comfy.comfyCharacterEnabled=true;
  e.context.routeStoryboardShot=()=>({providerId:'comfy',modelId:'comfy-workflow'});
  assert.equal(await e.run(),true);const snapshot=e.context.worldDraft.promptDraft.shots[0].shotSpec.characters[0].archiveSnapshot;
  assert.equal(snapshot.comfyImplementation,undefined);assert.equal(snapshot.imageReference,undefined);
  assert.equal(snapshot.archiveId,'alice');
});
test('upstream source revocation remains part of actual preparation guards through the normal queue handoff',()=>{
  const e=harness();let valid=true;const guard=e.context.storyboardCreatePreparationGuard(e.state,{upstreamGuard:{isCurrent:()=>valid}});
  assert.equal(guard.isCurrent(),true);valid=false;assert.equal(guard.isCurrent(),false);assert.throws(()=>guard.assertCurrent(),/变化/);guard.dispose();
  assert.match(section('storyboardGenerate'),/upstreamGuard:productionGuard/g);
});

test('disabled and rejected candidates do no archive preparation or model work',async()=>{
  const e=harness();e.state.directorBridge.worldSideShotsEnabled=false;assert.equal(await e.run(),false);assert.equal(e.calls.length,0);
  e.state.directorBridge.worldSideShotsEnabled=true;e.candidate.recommendation='reject';assert.equal(await e.run(),false);assert.equal(e.calls.length,0);
});

test('world confirmation escapes imported names and all editable text, without rendering private references',async()=>{
  const e=worldEnvironment(),prepared=await e.prepare({visibleCharacters:characters});const {shot}=world.prepareWorldCharacterShot(input(),prepared);
  shot.characters[0].name='<img src=x onerror=alert(1)>';shot.characters[0].identity=['</textarea><script>alert(1)</script>'];
  const html=world.renderWorldShotConfirmation(shot,{title:'<script>bad</script>',model:'<svg/onload=alert(1)>'});
  assert.doesNotMatch(html,/<script|<img|<svg/);assert.match(html,/&lt;script/);assert.doesNotMatch(html,/PRIVATE-QUALIFICATION|sha256/);
});

for(const invalid of [false,true])test(`world fixed workflow ${invalid?'fails before confirmation if missing':'prepares an exact recipe and reaches shared gallery-only generation'}`,async()=>{
  const e=harness(),f=await recipesFixture();f.rows.forEach(row=>row.namespace=e.namespace);
  const recipe=await comfyRoutes.pinComfyRouteWorkflow({namespace:e.namespace,selection:f.rows[0],createStore:f.createStore});
  e.state.routing.enabled=true;e.state.routing.rules=[{id:'fixed',enabled:true,shotTypes:[],target:{providerId:'comfy',modelId:'comfy-workflow',comfyWorkflowBinding:recipe.binding,comfyCharacterEnabled:false}}];
  if(invalid)f.rows[0].archived=true;
  const load=e.context.featureRuntime.load;e.context.featureRuntime.load=async key=>key==='comfyRoutes'?{...comfyRoutes,prepareComfyRouteRecipes:options=>comfyRoutes.prepareComfyRouteRecipes({...options,createStore:f.createStore})}:load(key);
  vm.runInContext(['storyboardProfileSnapshot','storyboardResolveRoutingProfile'].map(section).join('\n'),e.context);
  if(invalid){assert.equal(await e.run(),false,e.notices.join(';'));assert.equal(e.calls.includes('confirm'),false);assert.equal(e.calls.includes('generate'),false);return;}
  const queued=[];Object.assign(e.context,{storyboardQueue:[],storyboardActiveJobs:new Map(),STORYBOARD_QUEUE_LIMIT:20,storyboardQueueJob:async job=>{queued.push(job);return true;},
    storyboardCredentialId:()=> 'test-key',storyboardAnchorForMessage:()=>null,uniqueClean:items=>[...new Set(items.filter(Boolean))],storyboardAdaptShotForModel:async shot=>shot,
    confirmDialog:async()=>true,STORYBOARD_SHOT_TYPE_LABELS:{portrait:'',environment:'',custom:''}});
  useActualWorldGeneration(e,['storyboardPromptsForArtist','storyboardJoinPrompt','storyboardCompilerRoutes','storyboardGenerationPayload','storyboardCreateJob','storyboardPlanHasGeneration','storyboardPrepareDraftGroup','storyboardGenerate']);
  assert.equal(await e.run(),true,e.notices.join(';'));assert.equal(queued.length,1);
  const job=queued[0];assert.equal(job.source,'comfy');assert.equal(job.target,'gallery');assert.equal(job.inlineByDefault,false);
  assert.deepEqual(job.profile.comfyRouteBinding,recipe.binding);assert.equal(job.profile.comfyWorkflow,recipe.document.workflow);
  assert.equal(job.profile.comfyCharacterEnabled,false);assert.equal(job.shotSpec.directorDecision.outputs.film,false);
});

for(const revoke of [false,'source','account'])test(`real normal pipeline ${revoke?`stops changed ${revoke}`:'freezes world casting in a gallery-only NAI job'}`,async()=>{
  const e=harness();const queued=[];
  Object.assign(e.context,{storyboardQueue:[],storyboardActiveJobs:new Map(),STORYBOARD_QUEUE_LIMIT:100,
    storyboardQueueJob:async(job,isCurrent)=>{assert.equal(isCurrent(),true);queued.push(job);return true;},confirmDialog:async()=>true,
    storyboardCredentialId:()=> 'test-key-reference',storyboardAnchorForMessage:()=>null,
    sanitizeStoryboardDiagnosticData:value=>value,uniqueClean:items=>[...new Set(items.filter(Boolean))],
    storyboardAdaptShotForModel:async shot=>{if(revoke==='source')e.candidate.recommendation='reject';if(revoke==='account')e.setAccount('st-user:new');return shot;}});
  useActualWorldGeneration(e,['storyboardPromptsForArtist','storyboardJoinPrompt','storyboardProfileSnapshot',
    'storyboardResolveRoutingProfile','storyboardGenerationPayload','storyboardCreateJob','storyboardPlanHasGeneration','storyboardPrepareDraftGroup','storyboardGenerate']);
  assert.equal(await e.run(),!revoke,e.notices.join(';'));
  assert.equal(queued.length,revoke?0:1);
  if(!revoke){const job=queued[0];assert.equal(job.target,'gallery');assert.equal(job.floor,null);assert.equal(job.inlineByDefault,false);
    assert.equal(job.automatic,false);assert.equal(job.payload.shotSpec.characters[0].archiveSnapshot.archiveId,'alice');
    assert.match(job.payload.parameters.providerOptions.v4_prompt.caption.char_captions[0].char_caption,/silver hair.*blue hair, no coat/);
    assert.equal(job.shotSpec.productionContext.truthMode,'speculative');assert.equal(job.shotSpec.directorDecision.outputs.film,false);
    assert.equal(e.state.prompt,'original');assert.equal(e.state.promptDraft.shots[0].id,'old-shot');
    const approved=e.context.lastProductionOptions;
    assert.equal(await e.context.storyboardGenerate(null,{...approved,automatic:true}),false);assert.equal(queued.length,1);
    await assert.rejects(()=>e.context.storyboardGenerate(null,approved),/已交接|已变化/);assert.equal(queued.length,1);
    // An older saved world draft in the workbench still cannot mix with prose.
    e.state.promptDraft.shots=copy(e.context.worldDraft.promptDraft.shots);
    e.state.promptDraft.shots.push({id:'prose',prompt:'ordinary prose'});
    assert.equal(await e.context.storyboardGenerate(null,{automatic:false}),false);assert.equal(queued.length,1);
  }
});

for(const mode of ['loading-edit','rejected','accepted-error'])test(`isolated world handoff preserves the workbench and exact ownership on ${mode}`,async()=>{
  const e=harness(),jobs=[];e.state.pendingCompilerStages=[{type:'prompt_compiler',input:'original prose'}];
  const before=copy({prompt:e.state.prompt,draft:e.state.promptDraft,stages:e.state.pendingCompilerStages,routing:e.state.routing});
  let loads=0;const load=e.context.featureRuntime.load;e.context.featureRuntime.load=async key=>{
    const result=await load(key);if(key==='worldShot'&&++loads===2&&mode==='loading-edit')e.state.prompt='new intentional edit';return result;
  };
  Object.assign(e.context,{storyboardQueue:[],storyboardActiveJobs:new Map(),STORYBOARD_QUEUE_LIMIT:20,
    storyboardQueueJob:async(job,isCurrent)=>{
      assert.equal(isCurrent(),true);if(mode==='rejected')return false;
      job.queueAccepted=true;jobs.push(job);throw Error('acknowledgement lost');
    },confirmDialog:async()=>true,storyboardCredentialId:()=> 'test-key',storyboardAnchorForMessage:()=>null,
    uniqueClean:items=>[...new Set(items.filter(Boolean))],storyboardAdaptShotForModel:async shot=>shot});
  useActualWorldGeneration(e,['storyboardPromptsForArtist','storyboardJoinPrompt','storyboardProfileSnapshot','storyboardResolveRoutingProfile',
    'storyboardGenerationPayload','storyboardCreateJob','storyboardPlanHasGeneration','storyboardPrepareDraftGroup','storyboardGenerate']);
  assert.equal(await e.run(),mode==='accepted-error',e.notices.join(';'));assert.equal(jobs.length,mode==='accepted-error'?1:0);
  assert.equal(e.state.prompt,mode==='loading-edit'?'new intentional edit':before.prompt);
  assert.deepEqual(copy(e.state.promptDraft),before.draft);assert.deepEqual(copy(e.state.pendingCompilerStages),before.stages);assert.deepEqual(copy(e.state.routing),before.routing);
  assert.equal(e.context.storyboardGenerationPreparing.size,0);assert.ok(!e.calls.includes('save'));
  if(mode==='accepted-error')assert.ok(e.notices.some(text=>text.includes('请勿整批重复生成')));
});
