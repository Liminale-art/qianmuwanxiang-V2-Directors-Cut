import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as auto from '../../qianmu-comfy-auto-runtime.js';
import * as routes from '../../qianmu-comfy-route.js';
import * as direct from '../../qianmu-image-direct.js';
import * as locks from '../../qianmu-comfy-lock-runtime.js';
import * as preflight from '../../qianmu-comfy-preflight.js';
import * as prompt from '../../qianmu-comfy-prompt.js';
import {changeComfySceneRecord,inspectComfySceneRecord,comfySceneScopeKey} from '../../qianmu-comfy-scene-lock.js';
import {checkComfyCharacterReadiness,createComfyReadinessSession} from '../../qianmu-comfy-character-readiness.js';
import {normalizeComfyAutoPool,COMFY_SELECTION_SCHEMA} from '../../qianmu-comfy-selection.js';
import {fakeWebLocks} from './web-locks-fixture.mjs';
import {hashText} from '../../qianmu-storyboard-utils.js';
import {storyboardFunctionSource as section} from './storyboard-form-fixture.mjs';
const copy=value=>JSON.parse(JSON.stringify(value));
const definitions={CLIPTextEncode:{input:{required:{text:['STRING']}},output:['CONDITIONING']},
  EmptyImage:{input:{required:{width:['INT'],height:['INT'],batch_size:['INT']}},output:['IMAGE']},
  SaveImage:{input:{required:{images:['IMAGE']}},output:[],output_node:true}};

// Real route selection, node readiness, scene coordination and queue code.
// Only persistence and read-only node HTTP are synthetic; no /prompt exists.
export async function installWorldComfyAuto(e,{styleLock=true,missing='',afterRead=()=>{}}={}){
  const namespace=e.namespace,network=[],records=new Map(),writes=[];
  const pool=normalizeComfyAutoPool({schema:COMFY_SELECTION_SCHEMA,namespace,id:'world-pool',revision:'v1',enabled:false,styleLock,
    candidates:[{id:'world-candidate',enabled:true,priority:0,target:{providerId:'comfy',modelId:'comfy-workflow',comfyWorkflowBinding:e.recipe.binding},classification:e.recipe.document.classification}]});
  const row={namespace,id:pool.id,revision:pool.revision,version:1,name:'World pool',archived:false,pool};
  const createStore=()=>({list:async()=>[copy(row)],versions:async()=>[copy(row)],load:async()=>copy(row),close(){}});
  e.state.comfyPoolSelection=(await auto.pinComfyAutoPool({namespace,selection:row,createStore})).binding;
  e.state.comfyAutoEnabled=true;e.state.source='comfy';
  e.state.connections.comfy.draft.baseUrl='https://comfy.fixture.invalid/api';
  e.state.connections.comfy.draft.options.comfyTransport='browser';
  const inspect=async scope=>({...inspectComfySceneRecord(records.get(comfySceneScopeKey(scope)),scope),generation:0});
  const write=async(scope,action)=>{const result=changeComfySceneRecord(records.get(comfySceneScopeKey(scope)),scope,action);records.set(comfySceneScopeKey(scope),result.row);writes.push(action.type);return {view:await inspect(scope),receipt:result.receipt};};
  const store={inspect,reserve:(scope,request)=>write(scope,{...request,type:'reserve'}),begin:receipt=>write(receipt.scope,{type:'begin',receipt}),
    settle:(receipt,outcome)=>write(receipt.scope,{type:'settle',receipt,outcome}),unlock:(scope,request)=>write(scope,{...request,type:'unlock'}),close(){}};
  const load=e.context.featureRuntime.load;
  const manager=locks.createComfySceneCoordinator({store,resolveNamespace:async()=>(await load('imageAdmission')).resolveImageAccountNamespace(),ownerId:'world-fixture',locks:fakeWebLocks()});
  e.context.featureRuntime.load=async key=>{
    if(key==='comfyAuto')return {...auto,prepareComfyAutoSession:options=>auto.prepareComfyAutoSession({...options,createStore,readRecipe:request=>routes.readPinnedComfyRouteWorkflow({...request,createStore:e.f.createStore})})};
    if(key==='comfyRoutes')return {...await load(key),assertComfyRouteProfile:(profile,options)=>routes.assertComfyRouteProfile(profile,{...options,createStore:e.f.createStore})};
    if(key==='comfyScene')return locks;
    if(key==='comfyPreflight')return preflight;
    if(key==='comfyPrompt')return prompt;
    if(key==='comfyCharacterReadiness')return {createComfyReadinessSession(){return createComfyReadinessSession({check:this.checkComfyCharacterReadiness});},
      checkComfyCharacterReadiness:(request,options)=>checkComfyCharacterReadiness(request,{...options,fetchImpl:async(url,init)=>{
        network.push({url,method:init.method});assert.equal(init.method,'GET');assert.match(url,/\/object_info\//);
        await afterRead();
        const name=decodeURIComponent(new URL(url).pathname.split('/').at(-1));return new Response(JSON.stringify(name===missing?{}:{[name]:definitions[name]}));
      }})};
    return load(key);
  };
  Object.assign(e.context,{hashText,storyboardComfySceneRuntime:async()=>manager,directImageRuntime:async()=>direct,storyboardResolveApiKey:async()=>'',storyboardRequestHeaders:()=>({})});
  vm.runInContext(['storyboardPreflightComfyForCompiler','storyboardComfyReferenceMetadata','storyboardWorkflowIssue','storyboardComfyPlanScopes',
    'storyboardComfySelectionMessage','storyboardComfyPreparationDraft','storyboardRecordComfyPreparationFailure','storyboardChooseComfyGenerationRoutes',
    'storyboardGatewayRequest','storyboardVerifyComfyRouteJob','storyboardPrepareComfyPromptJob','storyboardCheckComfyJobReadiness',
    'storyboardConfirmComfyExecution','storyboardProbeComfyCandidate'].map(section).join('\n'),e.context);
  return {network,records,writes,manager,close:()=>manager.close()};
}
