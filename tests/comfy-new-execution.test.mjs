import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {projectNewComfyExecution} from '../qianmu-comfy-new-execution.js';
import {prepareComfyWorkflow} from '../qianmu-comfy-workflow.js';
const graph={
  positive:{class_type:'CLIPTextEncode',inputs:{text:'fixed positive, %qianmu_prompt%'}},
  negative:{class_type:'CLIPTextEncode',inputs:{text:'fixed negative, %qianmu_negative%'}},
  output:{class_type:'SaveImage',inputs:{images:['positive',0]}},
};
const profile={model:'comfy-workflow',comfyWorkflow:JSON.stringify(graph),comfyOutputNodeId:'output',seed:'-1',cfg:'0',
  comfyCharacterEnabled:true,comfyCharacterActivation:{namespace:'account',workflow:{id:'original',version:1}},
  comfyReferences:{namespace:'account',items:[{id:'reference'}]},
  comfyRouteBinding:{id:'original',revision:'original-revision',version:1,namespace:'account',recipeHash:'original-recipe',workflowHash:'original-graph'},
  comfyRoutePromptFormat:'tags',comfyRoutePromptLayer:{positive:'retired addition',negative:'retired exclusion'},
};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}

test('fresh execution stops retired role/addition use without changing the saved recipe or reference source',()=>{
  const original=freeze(structuredClone(profile)),before=digest(original),projected=projectNewComfyExecution(original);
  assert.equal(digest(original),before);assert.equal(original.comfyCharacterEnabled,true);
  const expected=structuredClone(profile);expected.comfyCharacterEnabled=false;delete expected.comfyCharacterActivation;
  expected.comfyRoutePromptLayer={positive:'',negative:''};
  assert.deepEqual(projected.profile,expected);assert.deepEqual(projected.promptLayer,{positive:'',negative:''});
  assert.notEqual(projected.profile.comfyRouteBinding,original.comfyRouteBinding);
  assert.notEqual(projected.profile.comfyReferences,original.comfyReferences);
});

test('projection does not remove workflow fixed words, edit topology or reinterpret zero-valued parameters',()=>{
  const {profile:next}=projectNewComfyExecution(profile);
  const bound=prepareComfyWorkflow(next.comfyWorkflow,{prompt:'current scene',negativePrompt:'scene exclusion'}).bind();
  assert.equal(bound.positive.inputs.text,'fixed positive, current scene');
  assert.equal(bound.negative.inputs.text,'fixed negative, scene exclusion');
  assert.deepEqual(bound.output.inputs.images,['positive',0]);assert.equal(next.cfg,'0');assert.equal(next.seed,'-1');
  assert.equal(next.comfyWorkflow,profile.comfyWorkflow);
});

test('workbench projection retains classification provenance without inventing a fixed route',()=>{
  const source={comfyWorkflow:profile.comfyWorkflow,comfyWorkbenchBinding:{schemaVersion:1,binding:{revision:'original'},classification:{promptFormat:'tags'}}};
  const next=projectNewComfyExecution(source);
  assert.deepEqual(next.profile.comfyWorkbenchBinding,source.comfyWorkbenchBinding);
  assert.equal(Object.hasOwn(next.profile,'comfyRouteBinding'),false);
  assert.equal(Object.hasOwn(next.profile,'comfyRoutePromptLayer'),false);
  assert.deepEqual(next.promptLayer,{positive:'',negative:''});
});

test('invalid provenance survives for mandatory validators instead of becoming a seemingly valid unbound workflow',()=>{
  const next=projectNewComfyExecution({comfyWorkflow:'broken',comfyRouteBinding:{invalid:true},comfyWorkbenchBinding:{invalid:true}});
  assert.equal(next.profile.comfyWorkflow,'broken');assert.deepEqual(next.profile.comfyRouteBinding,{invalid:true});
  assert.deepEqual(next.profile.comfyWorkbenchBinding,{invalid:true});
});

test('per-shot projections and their two empty prompt layers never share mutable state',()=>{
  const a=projectNewComfyExecution(profile),b=projectNewComfyExecution(profile);
  a.profile.comfyReferences.items[0].id='changed';a.profile.comfyRoutePromptLayer.positive='changed';
  assert.equal(b.profile.comfyReferences.items[0].id,'reference');assert.equal(profile.comfyReferences.items[0].id,'reference');
  assert.equal(a.promptLayer.positive,'');assert.equal(b.profile.comfyRoutePromptLayer.positive,'');
});

test('missing or non-profile input is rejected before creating an execution projection',()=>{
  for(const input of [undefined,null,[],true,'profile',1])assert.throws(()=>projectNewComfyExecution(input),{code:'comfy_execution_profile'});
});
