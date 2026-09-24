import test from 'node:test';
import assert from 'node:assert/strict';
import {openEnsembleTargetPicker,renderEnsembleTargetPicker} from '../qianmu-ensemble-target-picker.js';
const providers={novel:{id:'novel',label:'NovelAI'},comfy:{id:'comfy',label:'ComfyUI'}};
const target={providerId:'novel',modelId:'my/channel/model',capabilityModelId:'nai-diffusion-5-full',connectionPresetId:'',parameterPresetId:''};
function environment({show=async()=>true,validateTarget=async value=>({target:value,artistCapable:true}),pickWorkflow}={}){
  const previous=globalThis.document,events=new Map(),calls=[];const root={innerHTML:'',addEventListener:(type,fn)=>events.set(type,fn),removeEventListener:type=>events.delete(type)};
  globalThis.document={createElement:()=>root};const dlg={isConnected:true,classList:{add:name=>calls.push(name)}};
  return {root,events,calls,options:{target,providers,defaultTarget:(providerId='novel')=>({...target,providerId}),validateTarget,pickWorkflow,guard:async()=>calls.push('guard'),
    context:{POPUP_TYPE:{CONFIRM:1},Popup:class{constructor(){this.dlg=dlg;}show(){calls.push('show');return show({root,events});}}},
    mountAppearance:value=>{assert.equal(value,dlg);calls.push('mount');return()=>calls.push('release');}},
    close(){if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}};
}
test('simple generation form has only relevant inputs and escapes imported data',()=>{
  let html=renderEnsembleTargetPicker({target,providers});assert.match(html,/生图渠道|模型|API 预设/);assert.doesNotMatch(html,/版本|分工|归档|兼容|并发|Key|工作流方案/);
  html=renderEnsembleTargetPicker({target:{providerId:'comfy',comfyWorkflowBinding:{name:'<script>x</script>'}},providers});
  assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/data-ensemble-target="modelId"|<script>/);
});
test('third-party model edits preserve the known capability family and stay draft-only',async()=>{
  const before=structuredClone(target),f=environment({show:async({events})=>{events.get('change')({target:{dataset:{ensembleTarget:'modelId'},value:'other/prefix/model'}});return true;}});
  try{const result=await openEnsembleTargetPicker(f.options);assert.equal(result.target.modelId,'other/prefix/model');assert.equal(result.target.capabilityModelId,target.capabilityModelId);assert.deepEqual(target,before);assert.equal(result.artistCapable,true);assert.equal(f.events.size,0);assert.ok(f.calls.indexOf('show')<f.calls.indexOf('mount'));assert.ok(f.calls.includes('release'));}finally{f.close();}
});

test('known model changes repaint matching parameter presets immediately and update capability',async()=>{
  const next='nai-diffusion-4-5-full',f=environment({show:async({root,events})=>{
    assert.match(root.innerHTML,/V5 parameters/);events.get('change')({target:{dataset:{ensembleTarget:'modelId'},value:next}});
    assert.match(root.innerHTML,/V4.5 parameters/);assert.doesNotMatch(root.innerHTML,/V5 parameters/);return true;
  }});
  try{
    const result=await openEnsembleTargetPicker({...f.options,models:()=>[{id:target.capabilityModelId},{id:next}],
      parameterPresets:value=>[{id:value.capabilityModelId,name:value.capabilityModelId===next?'V4.5 parameters':'V5 parameters'}]});
    assert.equal(result.target.modelId,next);assert.equal(result.target.capabilityModelId,next);assert.equal(result.target.parameterPresetId,'');
  }finally{f.close();}
});
test('cancel does not validate or retain edited provider settings',async()=>{
  const f=environment({show:async({events})=>{events.get('change')({target:{dataset:{ensembleTarget:'providerId'},value:'comfy'}});return false;},validateTarget:()=>assert.fail('cancel is not a save')});
  try{assert.equal(await openEnsembleTargetPicker(f.options),null);assert.equal(target.providerId,'novel');assert.equal(f.events.size,0);}finally{f.close();}
});
test('workflow selection changes only the draft, not the original or live workbench',async()=>{
  const current={providerId:'comfy',modelId:'comfy-workflow'},selected={...current,comfyWorkflowBinding:{id:'one',revision:'first',name:'水墨'}};
  const f=environment({pickWorkflow:async value=>{assert.deepEqual(value,current);return selected;},show:async({events})=>{await events.get('click')({target:{closest:()=>true}});return true;}});
  try{const result=await openEnsembleTargetPicker({...f.options,target:current});assert.deepEqual(result.target,selected);assert.equal(current.comfyWorkflowBinding,undefined);}finally{f.close();}
});
