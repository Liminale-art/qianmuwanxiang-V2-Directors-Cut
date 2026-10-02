import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {compilerEnvironment} from './helpers/comfy-compiler-fixture.mjs';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
import {installWorldbookFixture} from './helpers/storyboard-worldbooks-fixture.mjs';

// Synthetic graph with the reported topology, not a production workflow or a
// copy of the user's prompt/models. All account, storage and LLM seams are local.
const workflow = {
  1:{class_type:'CLIPTextEncode',inputs:{text:'%qianmu_prompt%',clip:['22',0]}},
  2:{class_type:'CLIPTextEncode',inputs:{text:'synthetic negative',clip:['22',0]}},
  3:{class_type:'VAEDecode',inputs:{samples:['8',0],vae:['23',0]}},
  8:{class_type:'KSampler',inputs:{seed:1,steps:45,cfg:4.5,sampler_name:'euler',scheduler:'simple',denoise:1,model:['11',0],positive:['1',0],negative:['2',0],latent_image:['12',0]}},
  9:{class_type:'SaveImage',inputs:{images:['3',0],filename_prefix:'synthetic'}},
  11:{class_type:'ModelSamplingAuraFlow',inputs:{shift:1.12,sampling:'flow',model:['21',0]}},
  12:{class_type:'EmptyLatentImage',inputs:{width:['16',0],height:['16',1],batch_size:1}},
  16:{class_type:'ResolutionSelector',inputs:{aspect_ratio:'2:3 (Portrait Photo)',megapixels:0.7,multiple:8}},
  21:{class_type:'UNETLoader',inputs:{unet_name:'synthetic.safetensors',weight_dtype:'default'}},
  22:{class_type:'CLIPLoader',inputs:{clip_name:'synthetic-clip.safetensors',type:'stable_diffusion',device:'default'}},
  23:{class_type:'VAELoader',inputs:{vae_name:'synthetic-vae.safetensors'}},
};

async function boundCompileEnvironment() {
  const e=await compilerEnvironment();e.styleSelection.enabled=false;
  const host=e.context.ctx(),events=new EventEmitter(),main={user_avatar:'user-a.png'};
  Object.assign(host,{eventSource:events,eventTypes:{PERSONA_CHANGED:'persona_changed'},powerUserSettings:{persona_description:'',persona_description_lorebook:'Shared'}});
  host.characters[0].description='';host.characters[0].data={extensions:{world:'Shared'}};
  Object.assign(e.state,{source:'comfy',target:'floor',floor:'0',paragraphMode:'manual',manualParagraphIndex:0,promptMode:'auto',
    pendingParagraphSelection:{version:1,mode:'manual_supplement',indexes:[0],paragraphIds:['p1'],insertAfterIndex:0,createdAt:1},
    comfyLibrarySelection:{id:'synthetic-workflow',revision:'r1',version:1,name:'Synthetic workflow'}});
  Object.assign(e.state.profiles.comfy,{comfyWorkflow:JSON.stringify(workflow),comfyOutputNodeId:'9',comfyInstanceType:'default',comfyCharacterEnabled:false,count:'1'});
  Object.assign(e.state.connections.comfy.draft,{protocol:'runninghub',baseUrl:'https://www.runninghub.cn'});
  Object.assign(e.state.promptCompiler,{includeRecentFloors:0,worldBookNames:[],worldEntryIds:[],worldBookView:'',personaWorldSelections:[]});
  const plan={id:'bound-test',chatKey:'chat-a',floor:0,origin:'manual_supplement',status:'screening',shots:[]};e.state.shotPlans.push(plan);
  const calls=[];
  Object.assign(e.context,{listWorldBooks:async()=>['Shared'],resolveMacro:async text=>text,getCharacterDescription:()=>'',getPersonaDescription:()=>'',
    storyboardCleanWithTagRules:text=>text,storyboardCleanMessageText:text=>text,storyboardMessageParagraphs:text=>text.split('\n\n'),
    storyboardCompilerCharacterCasting:async()=>({prepared:null,assertCurrent:async()=>{},apply:shot=>({shot,warnings:[]})}),
    storyboardCallCompiler:async messages=>{calls.push(messages);return 'synthetic response';},
    storyboardCompilerResult:async()=>({shouldGenerate:true,prompt:'synthetic image',negative:'',shots:[{prompt:'synthetic image',paragraphIndex:0,sensitive:false}]}),
  });
  const runtime=installWorldbookFixture(e.context,{
    loadModules:async()=>({main,world:{getWorldInfoSettings:()=>({world_info:{}})}}),
    entries:async()=>[{uid:1,content:'APPROVED_APPEARANCE_SENTINEL'},{uid:2,content:'UNSELECTED_PRIVATE_SENTINEL'}],
  });
  vm.runInContext(['storyboardWarmCompilerWorldEntries','storyboardCompilerWorldText','storyboardCompilerContext'].map(section).join('\n'),e.context);
  return {...e,host,events,main,plan,calls,runtime};
}

test('actual compiler entry blocks pending bound material before any model or generation request',async()=>{
  const e=await boundCompileEnvironment();
  assert.equal(await e.context.storyboardCompilePrompt(null,{plan:e.plan}),false);
  assert.equal(e.calls.length,0);assert.equal(e.jobs.length,0);
  assert.equal(e.state.logs.length,1);assert.equal(e.state.logs[0].submissionState,'not_submitted');
  assert.equal(e.events.eventNames().length,0);
});

test('actual compiler request receives only confirmed enabled persona rows once even when both owners bind the book',async()=>{
  const e=await boundCompileEnvironment();await e.runtime.edit('Shared');e.runtime.toggleEntry('Shared::2',false);e.runtime.confirm();
  assert.equal(await e.context.storyboardCompilePrompt(null,{plan:e.plan}),true,JSON.stringify(e.notices));
  assert.equal(e.calls.length,1);const sent=JSON.stringify(e.calls[0]);
  assert.equal(sent.split('APPROVED_APPEARANCE_SENTINEL').length-1,1);assert.doesNotMatch(sent,/UNSELECTED_PRIVATE_SENTINEL/);
  assert.equal(e.plan.status,'prompt_ready');assert.equal(e.jobs.length,0);assert.equal(e.events.eventNames().length,0);
});

test('actual compiler rejects an empty-persona switch during the earlier diagnostic identity await',async()=>{
  const e=await boundCompileEnvironment();await e.runtime.edit('Shared');e.runtime.confirm();
  e.state.promptCompiler.personaWorldSelections.push({kind:'user',owner:'user-b.png',book:'Shared',entryIds:['Shared::2'],enabled:true});
  let release,entered;const entry=new Promise(resolve=>{entered=resolve;}),wait=new Promise(resolve=>{release=resolve;});
  e.context.resolveImageAccountNamespace=async()=>{entered();await wait;return 'st-user:route-test';};
  const running=e.context.storyboardCompilePrompt(null,{plan:e.plan});await entry;
  e.main.user_avatar='user-b.png';e.events.emit('persona_changed');release();
  assert.equal(await running,false);assert.equal(e.calls.length,0);assert.equal(e.jobs.length,0);
  assert.equal(e.state.logs[0].status,'cancelled');assert.match(e.state.logs[0].error,/角色或参考上下文已变化/);
  assert.equal(e.events.eventNames().length,0);
});

test('manual RunningHub single-slot preparation survives its own worldbook view cleanup before the first LLM seam', async () => {
  const e = await compilerEnvironment();
  e.styleSelection.enabled = false;
  const host = e.context.ctx();
  host.chat.splice(0, host.chat.length, ...Array.from({length:27}, (_, index) => ({mes:`Synthetic floor ${index}.\n\nSelected synthetic paragraph.`,is_user:false,swipe_id:0})));
  Object.assign(e.state,{source:'comfy',target:'floor',floor:'26',paragraphMode:'manual',manualParagraphIndex:1,promptMode:'auto',
    pendingParagraphSelection:{version:1,mode:'manual_supplement',indexes:[1],paragraphIds:['p2'],insertAfterIndex:1,createdAt:1},
    comfyLibrarySelection:{id:'synthetic-workflow',revision:'r1',version:1,name:'Synthetic workflow'}});
  Object.assign(e.state.profiles.comfy,{comfyWorkflow:JSON.stringify(workflow),comfyOutputNodeId:'9',comfyInstanceType:'default',comfyCharacterEnabled:false,count:'1'});
  Object.assign(e.state.connections.comfy.draft,{protocol:'runninghub',baseUrl:'https://www.runninghub.cn'});
  Object.assign(e.state.promptCompiler,{includeRecentFloors:0,worldBookNames:[],worldEntryIds:[],worldBookView:'removed-directory'});
  const plan={id:'manual-test',chatKey:'chat-a',floor:26,origin:'manual_supplement',status:'screening',shots:[]};
  e.state.shotPlans.push(plan);
  let llmCalls = 0;
  Object.assign(e.context,{
    storyboardTargetFloor:() => 26, storyboardWorldEntryCache:{key:'',loading:null},contextScanCache:{boundWorldBookNames:[],worldBooks:{}},
    detectBoundWorldBookNames:() => [],listWorldBooks:async() => [],resolveMacro:async text => text,
    storyboardCleanWithTagRules:text => text,storyboardCleanMessageText:text => text,storyboardMessageParagraphs:text => text.split('\n\n'),
    storyboardCompilerCharacterCasting:async() => ({prepared:null,assertCurrent:async() => {},apply:shot => ({shot,warnings:[]})}),
    storyboardCallCompiler:async() => {llmCalls++;return 'synthetic response';},
    storyboardCompilerResult:async() => ({shouldGenerate:true,prompt:'synthetic image',negative:'',shots:[{prompt:'synthetic image',paragraphIndex:1,sensitive:false}]}),
  });
  installWorldbookFixture(e.context);
  vm.runInContext(['storyboardWarmCompilerWorldEntries','storyboardCompilerWorldText','storyboardCompilerContext'].map(section).join('\n'),e.context);
  assert.equal(await e.context.storyboardCompilePrompt(null,{plan}),true,JSON.stringify(e.notices));
  assert.equal(e.state.promptCompiler.worldBookView,'');
  assert.equal(llmCalls,1,'only the stubbed first LLM boundary is exercised; no provider submission');
  assert.equal(plan.status,'prompt_ready');
  assert.equal(e.jobs.length,0);
  assert.equal(e.state.profiles.comfy.comfyWorkflow,JSON.stringify(workflow));
  assert.equal(e.state.profiles.comfy.comfyOutputNodeId,'9');
  assert.equal(e.state.profiles.comfy.comfyInstanceType,'default');
});
