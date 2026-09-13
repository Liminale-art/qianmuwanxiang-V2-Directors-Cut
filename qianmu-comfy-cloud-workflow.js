// Bind host-issued uploads only at reference slots in the ORIGINAL template.
// Native string binding stays untouched. No network or workflow topology edits.
import { prepareComfyWorkflow } from './qianmu-comfy-workflow.js';
import { parseBoundedJson } from './qianmu-json-input.js';
import { matchComfyCloudUpload } from './qianmu-comfy-cloud-upload-contract.js';
import { COMFY_REFERENCE_LIMIT } from './qianmu-comfy-reference-contract.js';

export function bindComfyCloudWorkflow(workflowJson, input, uploads) {
  const fail=()=>{throw Object.assign(new Error('云工作流参考槽与已选图片不一致，未提交生图'),{code:'comfy_cloud_reference_binding',submissionState:'not_submitted',retryable:false});};
  // The caller serializes its already validated, frozen source document.
  const original=parseBoundedJson(workflowJson,{maxBytes:2*1024*1024,maxDepth:40,maxNodes:50000,label:'云工作流'});
  if(!Array.isArray(input?.references)||!Array.isArray(uploads)||!uploads.length||uploads.length>COMFY_REFERENCE_LIMIT||input.references.length!==uploads.length)fail();
  const references=uploads.map((receipt,index)=>matchComfyCloudUpload(receipt,input.connection,input.references[index]));
  const template=prepareComfyWorkflow(original,{...input,referenceCount:references.length});
  const bound=template.bind(references.map(value=>typeof value==='string'?value:value.info.id));
  function replace(declared,filled){
    if(typeof declared==='string'){
      const slot=declared.match(/^%qianmu_(references|reference(?:_(?:[1-9]|1[0-6]))?)%$/)?.[1];
      if(slot==='references')return [...references];
      if(slot)return references[slot==='reference'?0:Number(slot.slice(10))-1];
      // Objects cannot be concatenated with filename prefixes or prompt text.
      if(/%qianmu_reference/.test(declared))fail();
      return filled;
    }
    if(Array.isArray(declared))return declared.map((value,index)=>replace(value,filled[index]));
    if(declared&&typeof declared==='object')return Object.fromEntries(Object.entries(declared).map(([key,value])=>[key,replace(value,filled[key])]));
    return filled;
  }
  for(const [id,node] of Object.entries(original))if(node?.inputs&&typeof node.inputs==='object')bound[id].inputs=replace(node.inputs,bound[id].inputs);
  return {workflow:bound,referenceLoadNodeIds:template.referenceLoadNodeIds};
}
