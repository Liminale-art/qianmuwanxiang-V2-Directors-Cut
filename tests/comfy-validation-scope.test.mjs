import test from 'node:test';
import assert from 'node:assert/strict';
import { comfyWorkflowValidationScope as scope } from '../qianmu-comfy-validation-scope.js';
import { normalizeComfyCloudIntent, normalizeComfyCloudReceipt, assertComfyCloudReceiptForIntent } from '../qianmu-comfy-cloud-receipt.js';
import { prepareComfyCloudSubmission } from '../qianmu-comfy-cloud-prepare.js';
import { bindComfyCloudTask, hasComfyCloudReadinessBasis } from '../qianmu-comfy-cloud-protocol.js';
import { stillInput } from './helpers/runninghub-validation-fixture.mjs';

const node=(class_type,inputs)=>({class_type,inputs});

test('validation scope is stable across prompts, slot seed and manual/automatic intent, without mutating the source',()=>{
  const input=stillInput(),before=structuredClone(input),first=scope(input,['save']);
  assert.deepEqual(input,before);
  input.prompt='another scene';input.negativePrompt='another exclusion';input.parameters.seed=-1;input.execution.automatic=true;
  assert.equal(scope(input,['save']),first);assert.equal(scope({...input,workflow:JSON.stringify(input.workflow)},['save']),first);
  assert.deepEqual(stillInput(),before);assert.equal(prepareComfyCloudSubmission(input).intent.workflow.validationScope,first);
});

test('graph, effective dimensions/model, output and runtime tier each invalidate prior evidence',()=>{
  const first=scope(stillInput(),['save']);
  for(const edit of [v=>v.parameters.width=768,v=>v.model='other.safetensors',v=>v.workflow.pos.inputs.text='other fixed style, %qianmu_prompt%',
    v=>v.workflow.sampler.inputs.seed=321,v=>v.runninghub={instanceType:'plus'},v=>v.workflow.sampler.inputs.steps=30]){
    const input=stillInput();edit(input);assert.notEqual(scope(input,['save']),first);
  }
  assert.notEqual(scope(stillInput(),['other']),first);
});

test('free text, seed and references in dependency fields never acquire reusable automatic evidence',()=>{
  for(const edit of [v=>v.workflow.model.inputs.ckpt_name='%qianmu_prompt%',v=>v.workflow.model.inputs.ckpt_name='%qianmu_negative%',
    v=>v.workflow.model.inputs.ckpt_name='%qianmu_seed%',v=>v.workflow.model.inputs.ckpt_name='%qianmu_reference%',
    v=>v.workflow.pos.inputs.clip='%qianmu_prompt%',v=>v.workflow.pos.inputs.text={nested:'%qianmu_prompt%'}]){
    const input=stillInput();edit(input);assert.equal(scope(input,['save']),null);
  }
  const input=stillInput();input.workflow.model.inputs.ckpt_name='%qianmu_prompt%';
  assert.equal(Object.hasOwn(prepareComfyCloudSubmission(input).intent.workflow,'validationScope'),false,'manual submission stays available without promoting the graph');
});

test('reference-mode scope includes count and exact slot wiring but never source URLs or image identities',()=>{
  const input=stillInput(),first=scope(input,['save']);input.workflow.ref=node('LoadImage',{image:'%qianmu_reference%'});
  input.references=[{url:'/private/a.png',sha256:'a'.repeat(64)}];const reference=scope(input,['save']);assert.notEqual(reference,first);
  input.references=[{url:'/private/b.png',sha256:'b'.repeat(64)}];assert.equal(scope(input,['save']),reference);
  assert.equal(scope({...input,referenceCount:1,references:undefined},['save']),reference);
  input.workflow.ref2=node('LoadImage',{image:'%qianmu_reference_2%'});input.references.push({url:'/private/c.png'});
  assert.notEqual(scope(input,['save']),reference);
});

test('optional scope survives accepted receipts and legacy receipts stay canonical without it',()=>{
  const prepared=prepareComfyCloudSubmission(stillInput()),intent=prepared.intent;
  const receipt={...intent,schema:'qianmu.comfy-cloud-receipt.v1',task:bindComfyCloudTask(intent.connection,'123')};delete receipt.connection;
  assert.deepEqual(assertComfyCloudReceiptForIntent(receipt,intent,'123'),normalizeComfyCloudReceipt(receipt));
  const original=structuredClone(intent);delete original.workflow.validationScope;
  assert.deepEqual(normalizeComfyCloudIntent(original),original);
  const oldReceipt=structuredClone(receipt);delete oldReceipt.workflow.validationScope;
  assert.deepEqual(normalizeComfyCloudReceipt(oldReceipt),oldReceipt);
  assert.throws(()=>assertComfyCloudReceiptForIntent(oldReceipt,intent,'123'));
  for(const invalid of [true,'a'.repeat(63),{verified:true},null]){
    const bad=structuredClone(intent);bad.workflow.validationScope=invalid;assert.throws(()=>normalizeComfyCloudIntent(bad));
  }
});

test('RH prior evidence cannot masquerade as a node catalog or authorize another provider',()=>{
  const report={definitionsChecked:false,verificationBasis:'prior_still_delivery',priorGenerationVerified:true};
  assert.equal(hasComfyCloudReadinessBasis(report,'runninghub'),true);
  assert.equal(hasComfyCloudReadinessBasis(report,'comfy-cloud'),false);
  for(const change of [{definitionsChecked:true},{priorGenerationVerified:false},{verificationBasis:'client_claim'}])assert.equal(hasComfyCloudReadinessBasis({...report,...change},'runninghub'),false);
});
