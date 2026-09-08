import {mappingHead,mappingBytes,validateMappingHead,validateMappingQuery,validateMappingSelection,validateMappingStorage,validateMappingList,validateMappingDetail,validateMappingExport} from './qianmu-storyboard-mapping-contract.js';

const fail=message=>{throw Object.assign(new Error(message),{code:'storyboard_mapping_registry'});};
const equal=(a,b)=>Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(key=>a[key]===b[key]);
function summarize(heads,namespace){
  if(!Array.isArray(heads)||heads.length>512||new Set(heads.map(row=>row.key)).size!==heads.length)fail('迁移凭据目录重复或超限');
  let recordBytes=0,indexBytes=0;for(const head of heads){validateMappingHead(head,namespace);recordBytes+=head.bytes;indexBytes+=mappingBytes(head);}
  return validateMappingStorage({version:1,namespace,status:'ready',count:heads.length,bytes:recordBytes+indexBytes,recordBytes,indexBytes},namespace);
}
// No restore, mutation, credential or image service is reachable from this registry.
export async function runMappingRegistry(action,{journal,namespace,input,guard=async()=>{}}={}){
  if(!['mappings','mapping-list','mapping-detail','mapping-export'].includes(action))fail('迁移凭据操作无效');
  if(action==='mapping-list')validateMappingQuery(input);
  if(action==='mapping-detail'||action==='mapping-export')validateMappingSelection(input,{paged:action==='mapping-detail'});
  await guard();const heads=await journal.listMappingHeads(namespace,{guard}),storage=summarize(heads,namespace);await guard();
  if(action==='mappings')return storage;
  if(action==='mapping-list'){
    const query=input.query.trim().toLowerCase(),rows=heads.filter(row=>(input.kind==='all'||row.kind===input.kind)&&[row.digest,row.sourceDigest,row.chatHash].some(value=>value.includes(query)))
      .sort((a,b)=>b.createdAt-a.createdAt||(a.key<b.key?-1:a.key>b.key?1:0));
    return validateMappingList({version:1,namespace,...input,total:rows.length,rows:rows.slice(input.offset,input.offset+24),storage},namespace,input);
  }
  const head=heads.find(row=>row.kind===input.kind&&row.digest===input.digest);if(!head)fail('未找到所选迁移凭据，请刷新目录');
  // The journal validates the full digest and lineage, not the cached head, on every detail/export request.
  const receipt=await journal.loadMappingReceipt(namespace,input.kind,input.digest);await guard();
  if(!receipt||!equal(mappingHead(input.kind,receipt),head))fail('迁移凭据与目录不符，未导出或改写原记录');
  if(action==='mapping-export'){
    const file=new Blob([JSON.stringify({schema:'qianmu.storyboard.mapping-receipt.v1',kind:input.kind,receipt})],{type:'application/json'});await guard();
    return validateMappingExport({version:1,namespace,head,file,filename:`qianmu-${input.kind}-${input.digest.slice(0,12)}.mapping.json`},namespace,input);
  }
  const review=receipt.review,total=input.kind==='environment'?1:review.lineage.length;
  let rows;
  if(input.kind==='environment')rows=[{sourceInstance:review.source.instanceId,sourceAccount:review.source.accountId,targetInstance:review.target.instanceId,targetAccount:review.target.accountId}];
  else if(review.scope==='local-user-alias-resolution')rows=review.lineage.slice(input.offset,input.offset+24);
  else{
    const bySource=new Map(review.rows.map(row=>[JSON.stringify([row.category,row.sourceKey]),row]));
    rows=review.lineage.slice(input.offset,input.offset+24).map(pair=>{
      const row=bySource.get(JSON.stringify([pair.source.category,pair.source.subjectKey]));
      return {source:pair.source,target:pair.target,sourceState:row.sourceState,sourceHash:row.sourceHash,targetHash:row.targetHash};
    });
  }
  return validateMappingDetail({version:1,namespace,head,offset:input.offset,total,rows},namespace,input);
}
