import vm from 'node:vm';
import * as storyboard from '../../qianmu-storyboard.js';
import * as runtime from '../../qianmu-comfy-route.js';
import * as preflight from '../../qianmu-comfy-preflight.js';
import { storyboardFunctionSource as section } from './storyboard-form-fixture.mjs';
export const namespace = 'st-user:route-test';
export const graph = label => ({
  text: { class_type: 'CLIPTextEncode', inputs: { text: `%qianmu_prompt% ${label}` } },
  negative: { class_type: 'CLIPTextEncode', inputs: { text: '%qianmu_negative%' } },
  image: { class_type: 'EmptyImage', inputs: { width: '%qianmu_width%', height: '%qianmu_height%', batch_size: '%qianmu_count%' } },
  save: { class_type: 'SaveImage', inputs: { images: ['image', 0] } },
});
export async function recipesFixture({formats=null}={}) {
  const rows = ['portrait','landscape'].map((name, index) => ({ namespace, id:name, revision:`revision-${name}`, version:1, name, archived:false,
    document:{ workflow:JSON.stringify(graph(name)), outputNodeId:'save', positivePrompt:`${name} quality`, negativePrompt:`${name} exclusions`,
      ...(formats?.[index] ? {classification:{version:1,promptFormat:formats[index],contentClasses:['sfw']}} : {}),
      parameters:{width:index ? 1216 : 832,height:index ? 832 : 1216,count:4,steps:index ? 24 : 16,cfg:5,seed:0,sampler:'euler',scheduler:'normal'} } }));
  const calls=[];
  const createStore=()=>({
    list:async ns=>{calls.push(['list',ns]);return structuredClone(rows.filter(row=>row.namespace===ns).map(({document,...row})=>row));},
    versions:async(ns,id)=>{calls.push(['versions',ns,id]);return structuredClone(rows.filter(row=>row.namespace===ns&&row.id===id).map(({document,...row})=>row));},
    load:async(ns,id,revision)=>{calls.push(['load',ns,id,revision]);return structuredClone(rows.find(row=>row.namespace===ns&&row.id===id&&row.revision===revision)?.document||null);},
    close:()=>calls.push(['close']), save:()=>{throw Error('unexpected storage write');},
  });
  const recipes=await Promise.all(rows.map(selection=>runtime.pinComfyRouteWorkflow({namespace,selection,createStore})));
  const routes=recipes.map(recipe=>({providerId:'comfy',modelId:'comfy-workflow',capabilityModelId:'comfy-workflow',connectionPresetId:'',parameterPresetId:'',comfyWorkflowBinding:recipe.binding,comfyCharacterEnabled:false,comfyReferences:null}));
  return {rows,calls,createStore,recipes,routes};
}
export async function routeEnvironment(options={}) {
  const f=await recipesFixture(options),state=storyboard.createStoryboardDefaults(),jobs=[],notices=[],calls=[]; let account=namespace,sequence=0;
  Object.assign(state,{enabled:true,target:'gallery',source:'novel',prompt:'one scene'});
  Object.assign(state.profiles.comfy,{comfyWorkflow:JSON.stringify(graph('global')),comfyOutputNodeId:'save',count:'3',width:'512',height:'512'});
  state.connections.comfy.draft.options.comfyTransport='browser';
  state.routing.enabled=true;
  state.routing.rules=f.routes.map((target,index)=>({id:`rule-${index}`,name:target.comfyWorkflowBinding.name,enabled:true,shotTypes:[index ? 'environment' : 'portrait'],target}));
  state.generationPolicy={version:1,minImages:1,maxImages:3,concurrency:2};
  state.promptDraft.shots=['portrait','environment','object'].map((shotType,index)=>{
    const scene=['woman reading a letter','wide river and mountains','broken cup on the wooden table'][index];
    return {id:`shot-${index}`,prompt:scene,shotType,shotSpec:{sourceParagraphIds:[`p${index}`],scene,location:scene,evidence:{quote:scene},visualDuty:scene,narrativePurpose:scene}};
  });
  const context=vm.createContext({...storyboard,STORYBOARD_SHOT_TYPE_LABELS:{portrait:'',group:'',environment:'',object:'',action:'',closeup:'',custom:''},clone:structuredClone,settings:{apiProfiles:[]},storyboardState:()=>state,
    getChatKey:()=> 'chat-a',ctx:()=>({chat:[]}),getCharacterDescription:()=>'',getPersonaDescription:()=>'',
    storyboardTargetFloor:()=>-1,storyboardCredentialRevision:0,storyboardAdmissionEpoch:1,storyboardDraftApiKeys:new Map(),
    storyboardSelectedArtistPreset:()=>null,storyboardGalleryRecords:()=>[],STORYBOARD_NAI_QUALITY_DEFAULTS:{},STORYBOARD_NAI_NEGATIVE_DEFAULTS:{},STORYBOARD_GENERIC_PROMPT_DEFAULTS:{positive:'global quality',negative:'global negative'},
    storyboardProductionDeliveryPolicy:(_shot,policy)=>policy,storyboardProductionContext:()=>({}),storyboardAnchorForMessage:()=>null,
    storyboardCredentialId:()=> 'fixture-key',sanitizeStoryboardDiagnosticData:value=>value,uid:()=>`id-${++sequence}`,uniqueClean:items=>[...new Set(items.filter(Boolean))],
    saveSettings(){},renderModal(){},toast:message=>{notices.push(message);return false;},
    storyboardGenerationPreparing:new Set(),storyboardQueue:[],storyboardActiveJobs:new Map(),STORYBOARD_QUEUE_LIMIT:100,
    storyboardQueueJob:async job=>{jobs.push(job);return true;},confirmDialog:async()=>true,
    featureRuntime:{load:async key=>{
      calls.push(key);
      if(key==='comfyRoutes')return {...runtime,
        pinComfyRouteWorkflow:options=>runtime.pinComfyRouteWorkflow({...options,createStore:f.createStore}),
        prepareComfyWorkbenchBinding:(profile,options)=>runtime.prepareComfyWorkbenchBinding(profile,{...options,createStore:f.createStore}),
        prepareComfyRouteRecipes:options=>runtime.prepareComfyRouteRecipes({...options,createStore:f.createStore})};
      if(key==='imageAdmission')return {resolveImageAccountNamespace:async()=>account};
      if(key==='comfyPreflight')return preflight;
      throw Error(`Unexpected external feature: ${key}`);
    }},
    htmlEscape:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),
  });
  const names=['storyboardConnectionState','storyboardProviderProfile','storyboardProfileSnapshot','storyboardParameterPresets',
    'storyboardPromptDefaultsKey','storyboardProviderPromptDefaults','storyboardPromptLayerForArtist','storyboardPromptsForArtist','storyboardJoinPrompt',
    'storyboardCaptureWorkbench','storyboardResolveRoutingProfile','storyboardCreatePreparationGuard','storyboardPrepareComfyRoutes','storyboardCompilerRoutes','storyboardCertainCompilerRoute',
    'storyboardUsesComfyCharacters','storyboardPreflightComfyForCompiler','storyboardComfyReferenceMetadata','storyboardWorkflowIssue',
    'storyboardGenerationPayload','storyboardCreateJob','storyboardShotSpecForSelection','storyboardAdaptShotForModel','storyboardGenerate','storyboardVerifyComfyRouteJob','storyboardRoutingTargetOptions','storyboardBindRouteWorkflow'];
  vm.runInContext(names.map(section).join('\n'),context);
  return {...f,state,context,jobs,notices,calls,setAccount:value=>account=value};
}
