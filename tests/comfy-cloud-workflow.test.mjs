import test from 'node:test';
import assert from 'node:assert/strict';
import {bindComfyCloudWorkflow} from '../qianmu-comfy-cloud-workflow.js';
import {planComfyCloudUpload,readComfyCloudUpload} from '../qianmu-comfy-cloud-upload-contract.js';
import {bindComfyCloudProtocol} from '../qianmu-comfy-cloud-protocol.js';
import {prepareComfyWorkflow} from '../qianmu-comfy-workflow.js';
const graph=()=>({model:{class_type:'CheckpointLoaderSimple',inputs:{ckpt_name:'fixed.safetensors'}},
  text:{class_type:'CLIPTextEncode',inputs:{text:'fixed style, %qianmu_prompt%',clip:['model',1]},_meta:{title:'%qianmu_reference%'}},
  negative:{class_type:'CLIPTextEncode',inputs:{text:'fixed negative'}},
  first:{class_type:'LoadImage',inputs:{image:'%qianmu_reference%'}},second:{class_type:'LoadImage',inputs:{image:'%qianmu_reference_2%'}},
  multi:{class_type:'CustomList',inputs:{images:'%qianmu_references%',conditioning:['text',0]}},
  save:{class_type:'SaveImage',inputs:{images:['first',0]}}});
function fixture(provider='comfy-cloud'){
  const connection=bindComfyCloudProtocol(provider==='comfy-cloud'?'https://cloud.comfy.org':'https://www.runninghub.cn',provider==='comfy-cloud'?'comfy-cloud-v2':'runninghub-workflow-v1');
  const references=[1,2].map(index=>({url:`/user/images/Qianmu-References/${index}.png`,name:String(index),mime:'image/png',bytes:123,sha256:String(index).repeat(64)}));
  const uploads=references.map((source,index)=>{
    const plan=planComfyCloudUpload(connection,source);
    return readComfyCloudUpload(plan,provider==='comfy-cloud'?{id:`00112233-4455-6677-8899-aabbccddee${index}f`,hash:null,size_bytes:123,content_type:'image/png',file_path:plan.filename}
      :{code:0,data:{type:'image',size:'123',fileName:`openapi/reference-${index}.png`}});
  });
  return {input:{connection,references,prompt:'literal %qianmu_reference% and qianmu-bound-reference-0',negativePrompt:'ignored without a slot'},uploads};
}
test('Cloud objects and RH filenames replace only declared slots, preserving fixed words, model and connections',()=>{
  for(const provider of ['comfy-cloud','runninghub']){
    const {input,uploads}=fixture(provider),source=JSON.stringify(graph()),result=bindComfyCloudWorkflow(source,input,uploads),bound=result.workflow;
    assert.deepEqual(bound.first.inputs.image,uploads[0].reference);assert.deepEqual(bound.second.inputs.image,uploads[1].reference);
    assert.deepEqual(bound.multi.inputs.images,uploads.map(row=>row.reference));assert.deepEqual(result.referenceLoadNodeIds,['first','second']);
    assert.equal(bound.text.inputs.text,`fixed style, ${input.prompt}`);assert.equal(bound.text._meta.title,'%qianmu_reference%');
    for(const id of ['negative','model','save'])assert.deepEqual(bound[id],graph()[id]);assert.deepEqual(bound.multi.inputs.conditioning,['text',0]);
    assert.equal(source,JSON.stringify(graph()));assert.ok(!JSON.stringify(bound).includes('[object Object]'));
  }
});
test('missing, foreign or changed reference receipts and embedded asset slots cannot produce a runnable graph',()=>{
  const {input,uploads}=fixture(),source=JSON.stringify(graph());
  assert.throws(()=>bindComfyCloudWorkflow(source,input,uploads.slice(1)));
  assert.throws(()=>bindComfyCloudWorkflow(source,input,fixture('runninghub').uploads));
  assert.throws(()=>bindComfyCloudWorkflow(source,{...input,references:[{...input.references[0],sha256:'c'.repeat(64)},input.references[1]]},uploads));
  const embedded=graph();embedded.first.inputs.image='prefix/%qianmu_reference%';assert.throws(()=>bindComfyCloudWorkflow(JSON.stringify(embedded),input,uploads),{code:'comfy_cloud_reference_binding'});
  assert.throws(()=>bindComfyCloudWorkflow(source,input,[{...uploads[0],reference:{__type:'core/ASSET',info:{id:'https://not-an-asset'}}},uploads[1]]));
  assert.throws(()=>bindComfyCloudWorkflow('{"constructor":{}}',input,uploads));
});
test('the original native compiler still requires strings and does not gain Cloud object handling',()=>{
  const {input,uploads}=fixture(),template=prepareComfyWorkflow(graph(),{...input,referenceCount:2});
  assert.throws(()=>template.bind(uploads.map(value=>value.reference)),{code:'comfy_reference_missing'});
  const bound=template.bind(['native/one.png','native/two.png']);assert.equal(bound.first.inputs.image,'native/one.png');
  assert.deepEqual(bound.multi.inputs.images,['native/one.png','native/two.png']);
});
