import vm from 'node:vm';
import * as contract from '../../qianmu-storyboard-contract.js';
import * as prompts from '../../qianmu-comfy-prompt.js';
import {applyCharacterCasting,CHARACTER_CASTING_SCHEMA} from '../../qianmu-character-casting.js';
import {routeEnvironment} from './comfy-route-fixture.mjs';
import {storyboardFunctionSource as section} from './storyboard-form-fixture.mjs';
const plain=value=>JSON.parse(JSON.stringify(value));
export const casting={schema:CHARACTER_CASTING_SCHEMA,entries:[{identity:{subjectId:'archive:alice',archiveId:'alice',archiveVersion:1,category:'char',name:'Alice',appearance:'silver hair',aliases:[]},negative:''}],unboundNames:[]};
const response=()=>({schema:contract.STORYBOARD_PLAN_RESPONSE_SCHEMA_ID,should_generate:true,skip_reason:'',continuity_updates:[],decisions:[],shots:['portrait','environment','object'].map((kind,index)=>{
  const character=index===0?[{character_id:'A',name:'Alice',fixed_identity:['silver hair'],current_state:{outfit:['coat removed'],expression:[],pose:[],action:['reads a letter'],gaze:[],props:['letter']},spatial:{order:1,region:'center',center:{x:0.5,y:0.5},visible_crop:'waist'}}]:[];
  const description=['Alice reads a letter','a wide mountain valley','a broken cup'][index];
  return {source_paragraph_ids:[`P${index+1}`],insert_after:`P${index+1}`,narrative_layer:'present',narrative_purpose:description,shot_role:index===2?'detail':index===1?'establishing':'reaction',shot_scale:index===2?'insert':'medium_shot',subject:description,
    scene:{location:['kitchen','mountains','table'][index],time:'day',lighting:[],environment:[]},characters:character,shared_relations:[],
    composition:{ratio_id:'3:2',orientation:'landscape',camera_side:'axis-neutral',angle:'eye-level',focus:description,negative_space:'',intent:description,continuity_key:`scene-${index}`},
    prompt_atoms:{global:[description],character_ids:character.map(row=>row.character_id),scene_negative:[]},sensitive:false,safety_notes:[],
    prompt_renderings:Object.fromEntries(['tags','natural_language'].map(format=>[format,{global:format==='tags'?`tag-scene-${index}, soft light`:`Natural scene ${index} with gentle light.`,
      characters:character.map(row=>({character_id:row.character_id,positive:format==='tags'?'silver hair, coat removed, reading a letter':'Alice, with silver hair and no coat, reads a letter.'})),negative:format==='tags'?'extra people':'No extra people.'}]))};
})});
export async function compilerEnvironment(){
  const e=await routeEnvironment({formats:['tags','natural_language']}),calls=[],errors=[];
  const load=e.context.featureRuntime.load;
  e.context.featureRuntime.load=async key=>key==='storyboardContract'?contract:key==='comfyPrompt'?prompts:load(key);
  const scene=response(),chat=[{mes:'Alice reads a letter. A mountain valley. A broken cup.',is_user:false}];
  Object.assign(e.context,{MODULE_NAME:'format-qa',storyboardCompilerBusy:false,STORYBOARD_SHOT_GROUP_TEMPLATES:{smart:{label:'test',instruction:''}},storyboardTargetFloor:()=>0,
    ctx:()=>({chat}),
    storyboardCompilerContext:async()=>({floor:0,paragraphs:scene.shots.map(row=>row.subject),messages:[],worldRows:[],currentCharacter:'Alice',persona:'',world:'',
      characterCasting:casting,casting:{apply:applyCharacterCasting,assertCurrent:async()=>{}}}),
    storyboardCallCompiler:async(messages,id,options)=>{calls.push({messages:plain(messages),options:plain(options)});return JSON.stringify(scene);},
    storyboardScheduleInlineRender(){},storyboardScheduleAutomaticCapture(){},storyboardSchedulePlanArchive(){},
    storyboardSetPlanStatus:(plan,status,extra={})=>{if(plan)Object.assign(plan,{status,...extra});},console:{error:(...args)=>errors.push(args.map(value=>value?.message||String(value)).join(' '))},
  });
  vm.runInContext(['storyboardCompilerRequestConfig','storyboardCompilerResult','storyboardCompilePrompt','storyboardPrepareComfyPromptJob','storyboardPrepareGatewayAssets'].map(section).join('\n'),e.context);
  e.context.storyboardQueueJob=async job=>{if(job.source==='comfy') {if(job.profile.comfyRouteBinding)await e.context.storyboardVerifyComfyRouteJob(job);await e.context.storyboardPrepareComfyPromptJob(job,{prepare:true});}else await e.context.verifyStoryboardModelPromptJob(job);e.jobs.push(job);return true;};
  return {...e,llmCalls:calls,errors,response:scene};
}
