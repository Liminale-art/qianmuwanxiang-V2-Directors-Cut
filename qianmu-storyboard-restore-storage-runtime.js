import { validateRestoreStorageSummary } from './qianmu-storyboard-restore-storage.js';
import { validateCharacterStorageSummary } from './qianmu-character-storage.js';
import { validateComfyStorageSummary } from './qianmu-comfy-storage-accounting.js';
import {validateMappingQuery,validateMappingSelection,validateMappingStorage,validateMappingList,validateMappingDetail,validateMappingExport} from './qianmu-storyboard-mapping-contract.js';
import {aliasHash,validateAliasInput,validateAliasTargets,validateAliasPage,validateAliasResult} from './qianmu-user-alias-contract.js';
import {canonicalUserSubjectKey} from './qianmu-user-identity.js';
import {validateBundleCarrierInventory} from './qianmu-bundle-carrier-storage-contract.js';
const fail=message=>Object.assign(new Error(message),{code:'storyboard_restore_storage_runtime',submissionState:'not_submitted'});

// Each request owns and immediately releases its Worker. No idle worker, background timer, raw configuration or network credential.
export async function runRestoreStorage(action,{namespace,guard,selected,input,chatHash,resolveAliasTargets,confirmed=false,recoveryLossAccepted=false,signal,WorkerClass=globalThis.Worker,timeoutMs=120000}={}){
  if(!['inspect','clear','characters','comfy','mappings','carriers','mapping-list','mapping-detail','mapping-export','user-alias-preview','user-alias-apply'].includes(action)||typeof guard!=='function')throw fail('储存操作或范围无效');
  if(action.startsWith('user-alias-')){validateAliasInput(action,input);if(!aliasHash(chatHash)||typeof resolveAliasTargets!=='function')throw fail('USER地址缺少当前聊天或人设目录');}
  if(action==='mapping-list')validateMappingQuery(input);
  if(action==='mapping-detail'||action==='mapping-export')validateMappingSelection(input,{paged:action==='mapping-detail'});
  if(action==='clear'&&(confirmed!==true||recoveryLossAccepted!==true))throw fail('尚未确认结束所选恢复记录');
  await guard();
  const interrupted=()=>fail(action==='user-alias-apply'?'USER整理结果未确认，原绑定可能已调整，请重新打开核对；不会自动重试。':action==='user-alias-preview'?'USER地址核对已取消，未修改绑定':action==='clear'?'清理结果未确认；部分记录可能已结束，请重新盘点。不会自动重试。':action==='mappings'||action.startsWith('mapping-')?'迁移凭据核对已取消，原映射记录未修改':`${action==='characters'?'角色空间':action==='comfy'?'Comfy 空间':'恢复记录'}盘点已取消，未修改数据`);
  if(signal?.aborted)throw interrupted();
  const id=crypto.randomUUID(),payload={id,action,namespace,...(action.startsWith('mapping-')||action.startsWith('user-alias-')?{input:structuredClone(input)}:{}),...(action.startsWith('user-alias-')?{chatHash}:{}),...(action==='clear'?{selected:structuredClone(selected),confirmed,recoveryLossAccepted}: {})};
  return new Promise((resolve,reject)=>{
    let worker,done=false,lastGuard=0,timer;
    const abort=()=>finish(interrupted());
    const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);worker?.terminate();if(error)reject(error);else Promise.resolve().then(guard).then(()=>resolve(result),reject);};
    try{
      worker=new WorkerClass(new URL('./qianmu-storyboard-restore-storage-worker.js',import.meta.url),{type:'module',name:'qianmu-restore-storage'});
      worker.addEventListener('error',()=>finish(interrupted()));
      worker.addEventListener('message',async event=>{
        if(done||event.data?.id!==id)return;const data=event.data;
        try{
          if(Object.hasOwn(data,'aliasTargets')){
            const request=data.aliasTargets;
            if(!action.startsWith('user-alias-')||!request||Object.keys(request).length!==2||!Number.isSafeInteger(request.request)||request.request!==lastGuard+1||!Array.isArray(request.targets)||request.targets.length>2048||new Set(request.targets).size!==request.targets.length||request.targets.some(key=>canonicalUserSubjectKey(key)!==key))throw fail('USER目录核对请求无效');
            lastGuard=request.request;await guard();const rows=validateAliasTargets(await resolveAliasTargets(request.targets),request.targets);await guard();if(!done)worker.postMessage({id,aliasTargets:{request:request.request,rows}});return;
          }
          if(Object.hasOwn(data,'guard')){
            if(!Number.isSafeInteger(data.guard)||data.guard!==lastGuard+1)throw fail('恢复记录核对序号无效');lastGuard=data.guard;
            await guard();if(!done)worker.postMessage({id,guard:data.guard});return;
          }
          if(data.error){finish(fail(String(data.error.message||'恢复记录操作未确认')));return;}
          let result=data.result;
          if(action==='user-alias-preview')result=validateAliasPage(result,namespace,chatHash,payload.input);
          else if(action==='user-alias-apply')result=validateAliasResult(result,namespace,chatHash,payload.input);
          else if(action==='mappings')result=validateMappingStorage(result,namespace);
          else if(action==='carriers')result=validateBundleCarrierInventory(result,namespace);
          else if(action==='mapping-list')result=validateMappingList(result,namespace,payload.input);
          else if(action==='mapping-detail')result=validateMappingDetail(result,namespace,payload.input);
          else if(action==='mapping-export')result=validateMappingExport(result,namespace,payload.input);
          else if(action==='comfy')result=validateComfyStorageSummary(result,namespace);
          else if(action==='characters')result=validateCharacterStorageSummary(result,namespace);
          else if(action==='inspect')result=validateRestoreStorageSummary(result,namespace);
          else if(result?.version!==1||result.namespace!==namespace||!Array.isArray(result.removed)||typeof result.complete!=='boolean'||!Number.isSafeInteger(result.bytes)||result.bytes<0
            ||result.removed.length>payload.selected.length||new Set(result.removed.map(row=>JSON.stringify(row))).size!==result.removed.length||result.removed.some(row=>!payload.selected.some(item=>JSON.stringify(row)===JSON.stringify(item)))
            ||result.remaining!==payload.selected.length-result.removed.length||result.complete&&result.remaining!==0)throw fail('清理结果不符，请重新盘点；不会自动重试');
          finish(null,result);
        }catch(error){finish(error);}
      });
      timer=setTimeout(abort,Math.max(100,Math.min(300000,Number(timeoutMs)||120000)));signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted){abort();return;}worker.postMessage(payload);
    }catch(_){finish(fail('无法启动后台恢复记录管理，未自动改用主页面大数据处理'));}
  });
}

export async function collectStoryboardMappingStorage({resolveNamespace,valid=()=>true,call=runRestoreStorage}={}){
  let namespace;
  const guard=async()=>{if(!valid())throw fail('储存页面已变化');const current=await resolveNamespace();if(!valid()||namespace&&namespace!==current)throw fail('储存账户已变化');namespace=current;};
  await guard();let result,error;
  try{result=validateMappingStorage(await call('mappings',{namespace,guard}),namespace);}catch(cause){error=cause;}
  await guard();return error?{version:1,status:'unavailable',namespace,bytes:null,error:String(error?.message||'迁移凭据暂不可读取')}:result;
}
export async function collectStoryboardCarrierStorage({resolveNamespace,valid=()=>true,call=runRestoreStorage}={}){
  let namespace;const guard=async()=>{if(!valid())throw fail('储存页面已变化');const current=await resolveNamespace();if(!valid()||namespace&&namespace!==current)throw fail('储存账户已变化');namespace=current;};
  await guard();let result,error;try{result=validateBundleCarrierInventory(await call('carriers',{namespace,guard}),namespace);}catch(cause){error=cause;}
  await guard();return error?{version:1,status:'unavailable',namespace,bytes:null,error:String(error?.message||'来源记录暂不可读取')}:result;
}

export async function collectStoryboardRestoreStorage({resolveNamespace,valid=()=>true,call=runRestoreStorage}={}){
  let namespace;
  const guard=async()=>{if(!valid())throw fail('储存页面已变化');const current=await resolveNamespace();if(!valid()||namespace&&namespace!==current)throw fail('储存账户已变化');namespace=current;};
  await guard();let result,error;
  try{result=validateRestoreStorageSummary(await call('inspect',{namespace,guard}),namespace);}catch(cause){error=cause;}
  await guard();return error?{version:1,status:'unavailable',namespace,bytes:null,error:String(error?.message||'恢复记录暂不可读取')}:result;
}
