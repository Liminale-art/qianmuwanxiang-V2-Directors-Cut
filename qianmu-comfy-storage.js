// On-demand metadata inventory. Does not load workflow documents, render galleries or submit requests.
import {assertComfyRouteNamespace} from './qianmu-comfy-route-contract.js';
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
export async function collectComfyStorage({resolveNamespace,valid=()=>true,createStores=factories}={}){
  const namespace=await account(resolveNamespace,valid),rows=await Promise.all(Object.keys(factories).map(async key=>{
    let store;
    try{
      store=await createStores[key]();await account(resolveNamespace,valid,namespace);
      const usage=await store.usage(namespace);
      if(!Number.isSafeInteger(usage.bytes)||usage.bytes<0||!Number.isSafeInteger(usage.count)||usage.count<0)fail('占用计值无效');
      return [key,{...usage}];
    }catch(error){return [key,{bytes:0,count:0,error:labels[key]+'：'+String(error?.message||'暂不可读取')}];}
    finally{store?.close();}
  }));
  await account(resolveNamespace,valid,namespace);
  return {namespace,...Object.fromEntries(rows),bytes:rows.reduce((sum,[,row])=>sum+row.bytes,0),count:rows.reduce((sum,[,row])=>sum+row.count,0),errors:rows.flatMap(([,row])=>row.error?[row.error]:[])};
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
