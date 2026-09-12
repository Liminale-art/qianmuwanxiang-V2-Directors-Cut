// Scene claims surround, but never replace, the independent image-admission and provider gates.
import {createComfySceneLockStore} from './qianmu-comfy-lock-store.js';
import {comfySceneScope,comfySceneScopeKey,comfySceneLockError,captureComfySceneStyleLink} from './qianmu-comfy-scene-lock.js';
import {comfyCandidateExecutionKey,COMFY_SELECTION_SCHEMA} from './qianmu-comfy-selection.js';
import {resolveStoryboardPromptRendering} from './qianmu-prompt-formats.js';
import {assertComfyRouteNamespace,normalizeComfySceneOrigin} from './qianmu-comfy-route-contract.js';
import {hasFreshComfyExecution,COMFY_FRESH_EXECUTION_POLICY} from './qianmu-comfy-new-execution.js';
export {createComfyBatchSceneScopes,createComfyDraftSceneScopes} from './qianmu-comfy-scene-lock.js';
const copy=value=>JSON.parse(JSON.stringify(value));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=(code,message)=>{throw comfySceneLockError(code,message);};
// Preserve immutable string references instead of serializing multi-megabyte graphs on every guard.
const capture=value=>Array.isArray(value)?value.map(capture):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,capture(v)])):value;
const equal=(a,b)=>Object.is(a,b)||Boolean(a&&b&&typeof a==='object'&&typeof b==='object'&&Array.isArray(a)===Array.isArray(b)
  &&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(key=>Object.hasOwn(b,key)&&equal(a[key],b[key])));
const routeFacts=job=>[job.source,job.profile,job.connection,job.chatKey,job.planId,job.planShotId,job.shotSpec,job.comfySceneOrigin];
// A page-owned Web Lock dies with the document; elapsed time is never used as evidence of death.
export function createComfySceneOwnerLease({locks=globalThis.navigator?.locks,ownerId,timeoutMs=6000}={}){
  const leases=new Map();let closed=false;
  const name=(namespace,owner)=>'qianmu:comfy-scene-owner:'+JSON.stringify([namespace,owner]);
  const available=()=>{if(closed||typeof locks?.request!=='function')fail('owner','当前浏览器不能安全保持续场，请使用支持页面锁的浏览器或关闭续场风格锁');};
  return {
    async hold(namespace){
      available();if(leases.has(namespace))return leases.get(namespace).ready;
      let accept,reject,release;const released=new Promise(resolve=>{release=resolve;});
      const lease={ready:new Promise((resolve,fail)=>{accept=resolve;reject=fail;}),release,active:true};leases.set(namespace,lease);
      const cancel=()=>{clearTimeout(timer);lease.active=false;release();reject(comfySceneLockError('owner','续场页面保护未就绪，未提交生成'));};
      lease.cancel=cancel;const timer=setTimeout(cancel,Math.max(100,Math.min(15000,Number(timeoutMs)||6000)));
      try{Promise.resolve(locks.request(name(namespace,ownerId),{mode:'exclusive',ifAvailable:true},async lock=>{
        clearTimeout(timer);if(!lock||closed||!lease.active){cancel();return;}
        accept();await released;
      })).catch(()=>{clearTimeout(timer);cancel();});}catch(_){clearTimeout(timer);cancel();}
      return lease.ready;
    },
    async withVacantOwner(namespace,previousOwner,work){
      available();let active=true,timer;
      try{return await Promise.race([
        locks.request(name(namespace,previousOwner),{mode:'exclusive',ifAvailable:true},async lock=>{
          if(!lock||closed||!active)return false;await work();return true;
        }),
        new Promise((_resolve,reject)=>{timer=setTimeout(()=>{active=false;reject(comfySceneLockError('owner','原页面状态核查超时，续场保持锁定'));},6000);}),
      ]);}finally{active=false;clearTimeout(timer);}
    },
    close(){closed=true;for(const lease of leases.values())lease.cancel();leases.clear();},
  };
}
export function createComfySceneCoordinator({resolveNamespace,store=createComfySceneLockStore(),ownerId=globalThis.crypto?.randomUUID?.(),locks=globalThis.navigator?.locks}={}){
  if(typeof resolveNamespace!=='function'||typeof ownerId!=='string'||!ownerId)fail('identity','缺少续场账户与页面身份');
  let closed=false,claims=new WeakMap();const live=new Set(),owner=createComfySceneOwnerLease({locks,ownerId});
  const guard=async(namespace,valid=()=>true)=>{
    if(closed||!valid())fail('closed','续场准备已结束');
    if(namespace!==await resolveNamespace()||closed||!valid())fail('account','账户或本镜配置已变化，未继续提交');
  };
  const claimFor=job=>{const claim=claims.get(job);if(!claim)fail('receipt','本镜续场预留已失效');return claim;};
  return {
    createBatch({prepared,probe,guard:inputGuard=async()=>{}}){
      const freshComfy=hasFreshComfyExecution(prepared);
      const namespace=assertComfyRouteNamespace(prepared?.binding?.namespace),observations=new Map(),choices=new WeakMap();let ended=false;
      const checkPolicy=()=>{if(hasFreshComfyExecution(prepared)!==freshComfy)fail('scope','执行规则已变化');};
      const current=async()=>{if(ended)fail('closed','本批次续场准备已结束');checkPolicy();await inputGuard();await guard(namespace,()=>!ended);await inputGuard();checkPolicy();};
      return {
        async choose(shot,rawScope,{adultAllowed=false}={}){
          await current();
          const scope=prepared.styleLock?comfySceneScope(rawScope):null;
          if(scope&&scope.namespace!==namespace)fail('scope','场景范围属于另一账户');
          let observed,key;
          if(scope){
            key=comfySceneScopeKey(scope);const view=await store.inspect(scope);await current();
            observed=observations.get(key);
            if(observed&&(view.generation!==observed.generation||view.lockRevision!==observed.lockRevision))fail('conflict','本批次续场状态已变化，请重新准备');
            if(!observed){observed={generation:view.generation,lockRevision:view.lockRevision,proposed:view.lock};observations.set(key,observed);}
          }
          const result=await prepared.select({shotSpec:shot,scope,lock:observed?.proposed || null,adultAllowed,probe});await current();
          if(result.status==='selected'){
            if(result.proposedLock&&observed)observed.proposed=copy(result.proposedLock);
            choices.set(result,{scope,observed,result,sourceHash:shot.promptRenderingPack?.sourceHash});
          }
          return result;
        },
        async attach(job,choice){
          await current();const selected=choices.get(choice);if(!selected)fail('receipt','本镜没有此批次的已检查选择');
          if(!selected.scope||!choice.proposedLock)return false;
          if(job.source!=='comfy'||job.chatKey!==selected.scope.chatKey||!job.id||claims.has(job)||job.comfySceneClaim)fail('scope','本镜任务与续场范围不符');
          const target={...choice.target,modelId:job.profile.model,capabilityModelId:job.profile.capabilityModelId,
            comfyWorkflowBinding:job.profile.comfyRouteBinding,comfyCharacterEnabled:job.profile.comfyCharacterEnabled===true,comfyReferences:job.profile.comfyReferences??null};
          if(choice.target.connectionPresetId&&job.connection?.id!==choice.target.connectionPresetId)fail('scope','本镜连接与选定工作流不符');
          if(await comfyCandidateExecutionKey({target},{freshComfy})!==choice.proposedLock.executionKey)fail('scope','本镜配置与选定工作流不符');await current();
          if(!selected.sourceHash||job.shotSpec?.promptRenderingPack?.sourceHash!==selected.sourceHash)fail('scope','本镜取景事实与选择时不符');
          await resolveStoryboardPromptRendering(job.shotSpec,job.shotSpec.promptRenderingPack,job.profile.comfyRoutePromptFormat,{guard:current});await current();
          job.comfySceneOrigin=normalizeComfySceneOrigin({...choice.proposedLock,version:1,mode:'scene',
            connectionPresetId:choice.target.connectionPresetId||'',sourceHash:selected.sourceHash,...(freshComfy?{executionPolicy:COMFY_FRESH_EXECUTION_POLICY}:{})});
          Object.defineProperty(job,'comfySceneClaim',{value:true,enumerable:false});
          const claim={namespace,observed:selected.observed,proposed:copy(choice.proposedLock),facts:capture(routeFacts(job)),receipt:null,begun:false};
          claims.set(job,claim);return true;
        },
        close(){ended=true;observations.clear();},
      };
    },
    async restore(job,{valid=()=>true,confirmIndependent=async()=>false}={}){
      if(!Object.hasOwn(job,'comfySceneOrigin'))return 'legacy';
      if(job.automatic||claims.has(job)||job.comfySceneClaim)fail('receipt','历史续场只可由本次手动重试重新核对');
      const origin=normalizeComfySceneOrigin(job.comfySceneOrigin),scope=comfySceneScope(origin.scope),namespace=scope.namespace;
      const facts=capture(routeFacts(job)),current=()=>valid()&&equal(facts,routeFacts(job));
      const check=()=>guard(namespace,current);await check();
      if(job.source!=='comfy'||!job.id||job.chatKey!==scope.chatKey||job.shotSpec?.narrativeLayer!==scope.narrativeLayer)fail('scope','原图聊天或叙事层与续场来源不符');
      const target={providerId:'comfy',modelId:job.profile?.model,capabilityModelId:job.profile?.capabilityModelId,
        connectionPresetId:origin.connectionPresetId,parameterPresetId:'',comfyWorkflowBinding:job.profile?.comfyRouteBinding,
        comfyCharacterEnabled:job.profile?.comfyCharacterEnabled===true,comfyReferences:job.profile?.comfyReferences??null};
      if(target.comfyWorkflowBinding?.namespace!==namespace||origin.connectionPresetId&&job.connection?.id!==origin.connectionPresetId)fail('scope','原图工作流与续场来源不符');
      const matchesOrigin=await comfyCandidateExecutionKey({target},{freshComfy:hasFreshComfyExecution(origin)})===origin.executionKey&&job.shotSpec?.promptRenderingPack?.sourceHash===origin.sourceHash;
      await check();await resolveStoryboardPromptRendering(job.shotSpec,job.shotSpec.promptRenderingPack,job.profile.comfyRoutePromptFormat,{guard:check});await check();
      if(origin.mode==='independent')return 'independent';
      const proposed={schema:COMFY_SELECTION_SCHEMA,scope,poolKey:origin.poolKey,candidateId:origin.candidateId,executionKey:origin.executionKey};
      const view=await store.inspect(scope);await check();
      if(!matchesOrigin||!view.lock||!same(view.lock,proposed)){
        if(!await confirmIndependent())return 'cancelled';
        await check();const latest=await store.inspect(scope);await check();
        if(latest.generation!==view.generation||latest.revision!==view.revision)fail('conflict','确认期间续场状态已变化，请重新核对');
        job.comfySceneOrigin={...origin,mode:'independent'};
        return 'independent'; // No write, relock, or historical receipt restoration.
      }
      Object.defineProperty(job,'comfySceneClaim',{value:true,enumerable:false});
      claims.set(job,{namespace,observed:{generation:view.generation,lockRevision:view.lockRevision},proposed,
        facts:capture(routeFacts(job)),receipt:null,begun:false});
      return 'linked';
    },
    async reserve(job,valid=()=>true){
      const claim=claimFor(job),current=()=>valid()&&equal(claim.facts,routeFacts(job));await guard(claim.namespace,current);
      if(claim.receipt)return;
      await owner.hold(claim.namespace);await guard(claim.namespace,current);
      const view=await store.inspect(claim.proposed.scope);await guard(claim.namespace,current);
      if(view.generation!==claim.observed.generation||view.lockRevision!==claim.observed.lockRevision)fail('conflict','续场在入队前已变化，请重新准备');
      if(view.lock&&!same(view.lock,claim.proposed))fail('conflict','当前场景已选择另一工作流');
      const result=await store.reserve(claim.proposed.scope,{expectedRevision:view.revision,expectedGeneration:view.generation,lock:claim.proposed,
        label:{planId:job.planId,floor:job.floor,workflowName:job.profile.comfyRouteBinding?.name,sceneTitle:job.shotSpec?.sceneFingerprint?.location||job.shotSpec?.subject},
        attemptId:job.id,ownerId,token:globalThis.crypto.randomUUID()});
      claim.receipt=result.receipt;live.add(claim);claim.observed.lockRevision=result.view.lockRevision;claim.observed.generation=result.view.generation;
      await guard(claim.namespace,current);
    },
    async beforeSubmit(job,valid=()=>true){
      const claim=claimFor(job),current=()=>valid()&&equal(claim.facts,routeFacts(job));await guard(claim.namespace,current);
      if(!claim.receipt)fail('receipt','本镜尚未取得续场预留');
      await store.begin(claim.receipt);claim.begun=true;await guard(claim.namespace,current);
    },
    async settle(job,outcome){
      const claim=claims.get(job);if(!claim)return;
      // These are this runtime's own non-transferable claims, not a new account operation.
      // Finishing local bookkeeping must also work after an account switch (as close() does).
      if(closed)return;
      if(claim.receipt){const result=await store.settle(claim.receipt,outcome);claim.observed.lockRevision=result.view.lockRevision;claim.observed.generation=result.view.generation;}
      if(outcome!=='accepted')live.delete(claim);
      if(!['accepted','unknown'].includes(outcome))claims.delete(job);
    },
    async inspect(scope){scope=comfySceneScope(scope);await guard(scope.namespace);const view=await store.inspect(scope);await guard(scope.namespace);return view;},
    async linkStyle(sourceScope,targetScope,request,{valid=()=>true}={}){
      const captured=captureComfySceneStyleLink(sourceScope,targetScope,request);await guard(captured.targetScope.namespace,valid);
      const result=await store.linkStyle(captured.sourceScope,captured.targetScope,captured);await guard(captured.targetScope.namespace,valid);return result.view;
    },
    async list(namespace,chatKey){namespace=assertComfyRouteNamespace(namespace);await guard(namespace);const rows=await store.list(namespace,chatKey);await guard(namespace);return rows;},
    async clearChat(namespace,chatKey,{valid=()=>true}={}){
      namespace=assertComfyRouteNamespace(namespace);await guard(namespace,valid);
      const before=await store.usage(namespace);await guard(namespace,valid);
      const result=await store.clearChat(namespace,chatKey,{expectedGeneration:before.generation});await guard(namespace,valid);return result;
    },
    async reconcile(scope,{valid=()=>true}={}){
      scope=comfySceneScope(scope);await guard(scope.namespace,valid);
      const view=await store.pendingOwners(scope);await guard(scope.namespace,valid);
      for(const previousOwner of view.owners){
        await owner.withVacantOwner(scope.namespace,previousOwner,async()=>{
          await guard(scope.namespace,valid);const current=await store.pendingOwners(scope);await guard(scope.namespace,valid);
          if(current.owners.includes(previousOwner))await store.orphan(scope,{ownerId:previousOwner,expectedRevision:current.revision,expectedGeneration:current.generation});
        });await guard(scope.namespace,valid);
      }
      return this.inspect(scope);
    },
    async unlock(scope,expected,{acknowledgeUncertain=false,valid=()=>true}={}){
      scope=comfySceneScope(scope);await guard(scope.namespace,valid);
      const result=await store.unlock(scope,{expectedRevision:expected.revision,expectedGeneration:expected.generation,acknowledgeUncertain});await guard(scope.namespace,valid);return result.view;
    },
    async close(){
      if(closed)return;closed=true;
      try{await Promise.allSettled([...live].filter(claim=>claim.receipt).map(claim=>store.settle(claim.receipt,claim.begun?'unknown':'not_submitted')));}
      finally{live.clear();claims=new WeakMap();store.close();owner.close();}
    },
  };
}
