import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {compilerEnvironment} from './helpers/comfy-compiler-fixture.mjs';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

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
