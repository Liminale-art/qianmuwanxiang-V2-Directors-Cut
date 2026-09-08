import { characterBindingTarget, characterArchiveError } from './qianmu-character-archive.js';
const fail=message=>{throw characterArchiveError('storage_summary',message);};
const bytes=value=>new TextEncoder().encode(JSON.stringify(value)).byteLength;
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const account=value=>typeof value==='string'&&/^st-user:.+/.test(value)&&value.length<=512&&!/[\u0000-\u001f\u007f]/.test(value);

// The store supplies one atomic metadata snapshot, including document keys but never document bodies or images.
export function summarizeCharacterStorage(namespace,{heads,bindings,usage,documentKeys}){
  if(!account(namespace)||!Array.isArray(heads)||heads.length>512||!Array.isArray(bindings)||bindings.length>2048||!Array.isArray(documentKeys))fail('角色库计值清单无效');
  if(!usage&&(heads.length||bindings.length||documentKeys.length))fail('角色库计值缺失，请先保全资料');
  const count=usage?.count||0,documentBytes=usage?.bytes||0,bindingCount=usage?.bindings||0;
  if(usage&&(usage.key!==namespace||![usage.count,usage.bytes,usage.bindings].every(integer))||count!==heads.length||bindingCount!==bindings.length||documentBytes>16*1048576)fail('角色库计值与索引不一致');
  const byId=new Map();let headBytes=0,wrapperBytes=0;
  for(const row of heads){
    if(row.namespace!==namespace||row.key!==JSON.stringify([namespace,row.id])||byId.has(row.id)||!integer(row.bytes)||!row.bytes)fail('角色档案索引归属或大小无效');
    byId.set(row.id,row);headBytes+=bytes(row);
    wrapperBytes+=bytes({key:row.key,namespace,revision:row.revision,document:null})-4;
  }
  if(heads.reduce((sum,row)=>sum+row.bytes,0)!==documentBytes||JSON.stringify([...documentKeys].sort())!==JSON.stringify(heads.map(row=>row.key).sort()))fail('角色原件键或档案计值缺失，请先保全核对');
  const seen=new Set();let bindingBytes=0;
  for(const row of bindings){
    const target=characterBindingTarget(row),key=JSON.stringify([namespace,target.category,target.subjectKey,target.scope,target.chatKey]);
    if(row.namespace!==namespace||row.key!==key||seen.has(key)||typeof row.revision!=='string'||!row.revision||typeof row.archiveId!=='string'
      ||row.archiveId&&byId.get(row.archiveId)?.category!==target.category)fail('角色绑定归属或目标档案不一致');
    seen.add(key);bindingBytes+=bytes(row);
  }
  const indexBytes=headBytes+wrapperBytes+(usage?bytes(usage):0);
  return {version:1,status:'ready',namespace,bytes:documentBytes+bindingBytes+indexBytes,filesIncluded:false,
    documents:{count,bytes:documentBytes},bindings:{count:bindingCount,bytes:bindingBytes},indexes:{count:heads.length+(usage?1:0),bytes:indexBytes}};
}
export function validateCharacterStorageSummary(value,namespace){
  if(!account(namespace)||!value||Object.keys(value).some(key=>!['version','status','namespace','bytes','filesIncluded','documents','bindings','indexes'].includes(key))||value.version!==1||value.status!=='ready'||value.namespace!==namespace||value.filesIncluded!==false||!integer(value.bytes))fail('角色空间摘要无效');
  for(const name of ['documents','bindings','indexes']){const row=value[name];if(!row||Object.keys(row).some(key=>!['count','bytes'].includes(key))||!integer(row.count)||!integer(row.bytes))fail('角色空间计值无效');}
  if(value.documents.count>512||value.documents.bytes>16*1048576||value.bindings.count>2048||value.indexes.count>513||value.bytes!==value.documents.bytes+value.bindings.bytes+value.indexes.bytes)fail('角色空间合计不符');
  return structuredClone(value);
}
export async function collectCharacterStorage({resolveNamespace,valid=()=>true,call}={}){
  let namespace;
  const guard=async()=>{if(!valid())fail('储存页面已变化');const current=await resolveNamespace();if(!valid()||!account(current)||namespace&&namespace!==current)fail('储存账户已变化');namespace=current;};
  await guard();let result,error;
  try{const run=call||(await import('./qianmu-storyboard-restore-storage-runtime.js')).runRestoreStorage;await guard();result=validateCharacterStorageSummary(await run('characters',{namespace,guard}),namespace);}catch(cause){error=cause;}
  await guard();return error?{version:1,status:'unavailable',namespace,bytes:null,error:String(error?.message||'角色库暂不可读取')}:result;
}
