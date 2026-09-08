// On-demand metadata inventory. Does not load workflow documents, render galleries or submit requests.
import {assertComfyRouteNamespace} from './qianmu-comfy-route-contract.js';
import {validateComfyStorageSummary} from './qianmu-comfy-storage-accounting.js';
const factories={
  workflows:async()=> (await import('./qianmu-comfy-library.js')).createComfyWorkflowStore(),
  pools:async()=> (await import('./qianmu-comfy-pool-store.js')).createComfyPoolStore(),
  scenes:async()=> (await import('./qianmu-comfy-lock-store.js')).createComfySceneLockStore(),
};
const labels={workflows:'Comfy 工作流库',pools:'Comfy 候选方案',scenes:'Comfy 续场记录'};
const fail=message=>{throw new Error(message);};
async function account(resolveNamespace,valid,expected=''){
  if(!valid())fail('储存页面已变化，请重新盘点');
  const namespace=assertComfyRouteNamespace(await resolveNamespace());
  if(!valid()||expected&&expected!==namespace)fail('账户已变化，请重新盘点后选择清理');
  return namespace;
}
export async function inspectComfyStorage({namespace,guard=async()=>{},createStores=factories}={}){
  assertComfyRouteNamespace(namespace);const rows=[];
  // One store at a time bounds memory and keeps Worker guard acknowledgements ordered.
  for(const key of Object.keys(factories)){
    let store;
    try{
      await guard();store=await createStores[key]();await guard();const summary=await store.storageSummary(namespace);await guard();rows.push([key,summary]);
    }catch(error){rows.push([key,{status:'unavailable',bytes:null,count:null,error:(labels[key]+'：'+String(error?.message||'暂不可读取')).slice(0,512)}]);}
    finally{store?.close();}
  }
  await guard();const ready=rows.filter(([,row])=>row.status==='ready').length;
  return validateComfyStorageSummary({version:1,status:ready===3?'ready':ready?'partial':'unavailable',namespace,...Object.fromEntries(rows),
    bytes:rows.reduce((sum,[,row])=>sum+(row.bytes||0),0),count:rows.reduce((sum,[,row])=>sum+(row.count||0),0),errors:rows.flatMap(([,row])=>row.error?[row.error]:[])},namespace);
}
export async function collectComfyStorage({resolveNamespace,valid=()=>true,createStores,call}={}){
  const namespace=await account(resolveNamespace,valid),guard=()=>account(resolveNamespace,valid,namespace);let result,error;
  try{
    if(createStores)result=await inspectComfyStorage({namespace,guard,createStores});
    else{const run=call||(await import('./qianmu-storyboard-restore-storage-runtime.js')).runRestoreStorage;result=await run('comfy',{namespace,guard});}
    result=validateComfyStorageSummary(result,namespace);
  }catch(cause){error=cause;}
  await guard();if(!error)return result;
  const message=String(error?.message||'后台盘点暂不可用').slice(0,400);
  const rows=Object.fromEntries(Object.keys(factories).map(key=>[key,{status:'unavailable',bytes:null,count:null,error:labels[key]+'：'+message}]));
  return validateComfyStorageSummary({version:1,status:'unavailable',namespace,...rows,bytes:0,count:0,errors:Object.values(rows).map(row=>row.error)},namespace);
}
export async function clearComfySceneStorage({resolveNamespace,expectedNamespace,expectedGeneration,valid=()=>true,createStore=factories.scenes}={}){
  assertComfyRouteNamespace(expectedNamespace);
  if(!Number.isSafeInteger(expectedGeneration)||expectedGeneration<0)fail('缺少续场盘点版本，请先刷新');
  const namespace=await account(resolveNamespace,valid,expectedNamespace);let store;
  try{
    store=await createStore();await account(resolveNamespace,valid,namespace);
    // A single bounded account transaction either removes all settled rows or rolls back completely.
    return await store.clearAccount(namespace,{expectedGeneration,valid});
  }finally{store?.close();}
}
