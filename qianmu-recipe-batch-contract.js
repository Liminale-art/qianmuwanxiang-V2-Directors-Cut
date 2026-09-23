// Selector-only batches. References prove saved recipe copies, not permission to
// remove the source chat/record or a promise that its model can still generate.
import {recipeArchiveRequest,recipeArchiveResponse,recipeArchiveStorageRequest,recipeArchiveError} from './qianmu-recipe-archive-contract.js';
export const RECIPE_BATCH_LIMITS=Object.freeze({records:8,snapshotBytes:2*1024*1024,jsonBytes:64*1024});
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=message=>{throw recipeArchiveError('batch_contract',message,400);};
export function recipeArchiveBatchRequest(value){
  if(!exact(value,['version','expectedAccount','target','gallerySha256','selections'])||!Array.isArray(value.selections)
    ||value.selections.length<1||value.selections.length>RECIPE_BATCH_LIMITS.records)fail('配方批次只接受1至8个准确画面选择');
  const ids=new Set(),selections=[];let target;
  for(const selection of value.selections){
    if(!exact(selection,['recordId','createdAt'])||ids.has(selection.recordId))fail('配方批次存在重复或不完整的画面选择');
    const one=recipeArchiveRequest({version:value.version,expectedAccount:value.expectedAccount,target:value.target,selection:{...selection,gallerySha256:value.gallerySha256}});
    target=one.target;ids.add(selection.recordId);selections.push({recordId:one.selection.recordId,createdAt:one.selection.createdAt});
  }
  return {version:1,expectedAccount:value.expectedAccount,target,gallerySha256:value.gallerySha256,selections};
}
export function recipeArchiveBatchResponse(value){
  if(!exact(value,['ok','version','expectedAccount','target','gallerySha256','selections','records','proof','canPrune'])||value.ok!==true
    ||value.proof!=='durable-recipe-batch'||value.canPrune!==false||!Array.isArray(value.records))fail('配方批次没有完整保存凭据');
  const request=recipeArchiveBatchRequest({version:value.version,expectedAccount:value.expectedAccount,target:value.target,gallerySha256:value.gallerySha256,selections:value.selections});
  if(value.records.length!==request.selections.length)fail('配方批次返回不完整，未当作全部成功');
  const records=value.records.map((raw,index)=>{
    const record=recipeArchiveResponse(raw),selection=request.selections[index];
    if(record.proof!=='durable-recipe'||record.expectedAccount!==request.expectedAccount||!same(record.target,request.target)
      ||!same(record.selection,{...selection,gallerySha256:request.gallerySha256}))fail('配方批次返回不同来源、画面或顺序');
    return record;
  });
  const result={ok:true,...request,records,proof:'durable-recipe-batch',canPrune:false};
  if(new TextEncoder().encode(JSON.stringify(result)).length>RECIPE_BATCH_LIMITS.jsonBytes)fail('配方批次凭据超过返回上限');
  return result;
}
export function recipeArchiveBatchCapabilities(value){
  if(!exact(value,['ok','version','expectedAccount','selectorOnly','maxRecords','maxSnapshotBytes','proof','canPrune'])||value.ok!==true
    ||value.selectorOnly!==true||value.maxRecords!==RECIPE_BATCH_LIMITS.records||value.maxSnapshotBytes!==RECIPE_BATCH_LIMITS.snapshotBytes
    ||value.proof!=='recipe-batch-capabilities'||value.canPrune!==false)fail('配方批次能力或账户声明不兼容');
  recipeArchiveStorageRequest({version:value.version,expectedAccount:value.expectedAccount});return {...value};
}
