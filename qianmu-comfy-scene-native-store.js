import {createComfySceneCatalogue} from './qianmu-comfy-scene-catalogue.js';
import {createComfySceneJournal} from './qianmu-comfy-scene-journal.js';
import {COMFY_SCENE_EVENT_SCHEMA,sceneNativeFail as fail,sceneSame,sceneBytes,sceneMutation} from './qianmu-comfy-scene-native-contract.js';
import {comfySceneScope,comfySceneScopeKey,captureComfySceneAction,captureComfySceneStyleLink,normalizeComfySceneReceipt,inspectComfySceneRecord} from './qianmu-comfy-scene-lock.js';
import {assertComfyRouteNamespace} from './qianmu-comfy-route-contract.js';

// Local atomic intent/receipt first; verified ST publication second. A native
// file readback remains optimistic, never an inter-device atomic reservation.
export function createNativeComfySceneStore({legacy,createStorage,indexedDB=globalThis.indexedDB,journal=createComfySceneJournal({indexedDB}),now=Date.now}={}){
  const catalogue=createComfySceneCatalogue({legacy,createStorage});let closed=false,queue=Promise.resolve();
  const view=state=>({...inspectComfySceneRecord(state.record,state.scope,now()),generation:state.generation});
  const sameReceipt=(a,b)=>sceneSame(normalizeComfySceneReceipt(a),normalizeComfySceneReceipt(b));
  const executableClaim=(local,receipt)=>local.claims.some(row=>sameReceipt(row.receipt,receipt))&&!local.conflicts.some(row=>['reserve','begin'].includes(row.proposal.kind)&&sameReceipt(row.proposal.receipt,receipt));
  const localOwners=async state=>{
    const claims=(await journal.read(state.scope.namespace)).claims,holders=(state.record?.holders||[]).filter(row=>row.status!=='uncertain');
    return [...new Set(holders.map(row=>row.ownerId))].filter(owner=>holders.filter(row=>row.ownerId===owner).every(holder=>claims.some(claim=>sameReceipt({...claim.receipt,scope:state.scope,...holder},claim.receipt))));
  };
  const run=(namespace,options,work)=>{namespace=assertComfyRouteNamespace(namespace);const captured={...options};
    const check=async()=>{if(closed||captured.signal?.aborted||captured.valid&&captured.valid()!==true||captured.isCurrent&&captured.isCurrent()!==true||await captured.guard?.()===false||closed)fail('续场页面或账户核对已变化');return true;};
    const task=queue.then(async()=>{await check();const local=await journal.read(namespace),opts={guard:check,signal:captured.signal,requireExisting:local.nativeKnown,inventoryOnly:captured.inventoryOnly===true};
      // A persisted operation is replayed only as the exact same metadata
      // proposal. No provider job or imported receipt is ever submitted here.
      if(local.pending&&!captured.reviewOnly){if(opts.inventoryOnly)fail('本机续场仍有待核对的保存操作，请先打开续场管理');
        try{await catalogue.publish(local.pending.proposal,opts);await journal.acknowledge(namespace,local.pending.id);}
        catch(error){if(error?.code!=='comfy_scene_predecessor')throw error;await check();await journal.retainConflict(namespace,local.pending.id);}
        await check();}
      const result=await work(opts,check);await check();if(!opts.inventoryOnly&&!local.nativeKnown&&catalogue.confirmed)await journal.observeNative(namespace);await check();return structuredClone(result);
    });queue=task.then(()=>{},()=>{});return task;
  };
  async function apply(state,action,opts,{source=null,receipt=null,outcomeId='',kind=action.type}={}){
    const at=now(),result=sceneMutation(state.record,state.scope,action,at,source);
    if(sceneSame(result.row,state.record)||result.unchanged){
      if(result.receipt&&!executableClaim(await journal.read(state.scope.namespace),result.receipt))fail('此浏览器没有有效原预留，未导入旧票据');
      if(outcomeId)await journal.acknowledgeOutcome(state.scope.namespace,receipt,outcomeId);
      return {view:view(state),...(result.receipt?{receipt:result.receipt}:{})};
    }
    const event={schema:COMFY_SCENE_EVENT_SCHEMA,namespace:state.scope.namespace,scope:state.scope,record:result.row,before:state.record,action,source,at,generation:state.generation,parents:state.heads};
    const proposal={id:crypto.randomUUID(),namespace:state.scope.namespace,kind,generation:state.generation,cleared:false,events:[event],receipt:result.receipt||receipt,outcomeId};
    await journal.stage(proposal.namespace,proposal);await catalogue.publish(proposal,opts);await journal.acknowledge(proposal.namespace,proposal.id);
    return {view:view({...state,record:result.row}),...(result.receipt?{receipt:result.receipt}:{})};
  }
  async function deliver(namespace,opts){
    const local=await journal.read(namespace);
    for(const claim of local.claims)for(const outcome of claim.outcomes){
      const state=await catalogue.checkout(claim.receipt.scope,opts),holder=state.record?.holders.find(row=>sameReceipt({...claim.receipt,...row},claim.receipt));
      if(!holder){
        // A later confirmed result, explicit unlock or clear may already have
        // consumed this receipt. Keep no old holder alive or recreate its lock.
        await journal.acknowledgeOutcome(namespace,claim.receipt,outcome.id);continue;
      }
      await apply(state,captureComfySceneAction({type:'settle',receipt:claim.receipt,outcome:outcome.outcome},state.scope),opts,{receipt:claim.receipt,outcomeId:outcome.id});
    }
  }
  const read=(scope,options,work)=>{scope=comfySceneScope(scope);return run(scope.namespace,options,async opts=>{await deliver(scope.namespace,opts);const state=await catalogue.checkout(scope,opts),local=await journal.read(scope.namespace);
    const retired=local.claims.filter(row=>!row.outcomes.length&&comfySceneScopeKey(row.receipt.scope)===comfySceneScopeKey(scope)&&!state.record?.holders.some(holder=>sameReceipt({...row.receipt,...holder},row.receipt))).map(row=>row.receipt);
    if(retired.length)await journal.retire(scope.namespace,retired);return work(state,opts);});};
  const action=(scope,input,options={})=>{scope=comfySceneScope(scope);const captured=captureComfySceneAction(input,scope),expected=input.expectedGeneration;
    return read(scope,options,async(state,opts)=>{if(['reserve','orphan','unlock','confirm_result'].includes(captured.type)&&expected!==state.generation)fail('续场清理代数已变化，请重新准备');
      if(['begin','settle'].includes(captured.type)&&!(await journal.read(scope.namespace)).claims.some(row=>sameReceipt(row.receipt,captured.receipt)))fail('此浏览器没有原任务预留，未接受导入票据');
      if(captured.type==='begin'&&!executableClaim(await journal.read(scope.namespace),captured.receipt))fail('原预留已因保存冲突取消，未提交生成');
      if(captured.type==='orphan'&&!(await localOwners(state)).includes(captured.ownerId))fail('不能用本机空闲页面锁核定另一设备的任务');
      return apply(state,captured,opts,{receipt:captured.receipt});});};
  const clear=(namespace,chatKey,options={})=>run(namespace,options,async opts=>{
    await deliver(namespace,opts);const current=await catalogue.all(namespace,opts);if(options.expectedGeneration!==current.generation)fail('续场清理代数已变化');
    const rows=current.rows.filter(row=>chatKey===null||row.scope.chatKey===chatKey);if(!rows.length)return {removed:0,bytes:0,generation:current.generation};
    const at=now(),events=rows.map(row=>{sceneMutation(row.record,row.scope,{type:'clear'},at);return {schema:COMFY_SCENE_EVENT_SCHEMA,namespace,scope:row.scope,record:null,before:row.record,action:{type:'clear'},source:null,at,generation:current.generation+1,parents:row.heads};});
    const proposal={id:crypto.randomUUID(),namespace,kind:'clear',generation:current.generation,cleared:true,events,receipt:null,outcomeId:''};await journal.stage(namespace,proposal);await catalogue.publish(proposal,opts);await journal.acknowledge(namespace,proposal.id);
    return {removed:rows.length,bytes:rows.reduce((n,row)=>n+sceneBytes(row.record),0),generation:current.generation+1,retained:true};
  });
  return Object.freeze({
    persistence:'st-account-file',concurrency:'optimistic-non-cas',
    review(namespace,chatKey,options={}){return run(namespace,{...options,reviewOnly:true},async opts=>{
      const state=await catalogue.review(namespace,chatKey,opts),local=await journal.read(namespace);
      return {...state,native:true,local:{pending:local.pending?{kind:local.pending.proposal.kind,id:local.pending.id}:null,outcomes:local.claims.reduce((n,row)=>n+row.outcomes.length,0),conflicts:local.conflicts.length}};
    });},
    synchronize(namespace,options={}){return run(namespace,options,async opts=>{await deliver(namespace,opts);return true;});},
    resolveSource(scope,{heads,generation,selected,acknowledged},options={}){
      scope=comfySceneScope(scope);const expected=structuredClone({heads,generation,selected,acknowledged});
      return run(scope.namespace,options,async opts=>{await deliver(scope.namespace,opts);const state=await catalogue.reviewScope(scope,opts);
        if(state.generation!==expected.generation||!sceneSame(state.heads,expected.heads))fail('续场来源在确认期间变化，请重新核对');
        return apply({...state,record:state.branches},{type:'resolve',selected:expected.selected,acknowledged:expected.acknowledged},opts);
      });
    },
    exportScene:(scope,options={})=>run(scope.namespace,{...options,reviewOnly:true},opts=>catalogue.exportScene(scope,opts)),
    exportJournal:(namespace,options={})=>run(namespace,{...options,reviewOnly:true},()=>journal.read(namespace)),
    inspect:scope=>read(scope,{},state=>view(state)),
    pendingOwners:scope=>read(scope,{},async state=>({...view(state),owners:await localOwners(state)})),
    reserve:(scope,request)=>action(scope,{...structuredClone(request),type:'reserve'}),
    begin(receipt){const captured=normalizeComfySceneReceipt(receipt);return action(captured.scope,{type:'begin',receipt:captured});},
    async settle(receipt,outcome){const captured=normalizeComfySceneReceipt(receipt);await journal.remember(captured,outcome);
      return run(captured.scope.namespace,{},async opts=>{await deliver(captured.scope.namespace,opts);return {view:view(await catalogue.checkout(captured.scope,opts))};});},
    orphan:(scope,request)=>action(scope,{...structuredClone(request),type:'orphan'}),
    unlock:(scope,request)=>action(scope,{...structuredClone(request),type:'unlock'}),
    confirmResult:(scope,request,options={})=>action(scope,{...structuredClone(request),type:'confirm_result'},options),
    linkStyle(sourceScope,targetScope,request){const captured=captureComfySceneStyleLink(sourceScope,targetScope,request);return read(targetScope,{},async(state,opts)=>{
      if(captured.expectedGeneration!==state.generation)fail('续场清理代数已变化');const source=await catalogue.checkout(sourceScope,opts);return apply(state,{type:'link',request:captured},opts,{source:source.record});});},
    list(namespace,chatKey){return run(namespace,{},async opts=>{await deliver(namespace,opts);return (await catalogue.all(namespace,opts)).rows.filter(row=>row.scope.chatKey===chatKey).map(view);});},
    usage(namespace){return run(namespace,{},async opts=>{await deliver(namespace,opts);const value=await catalogue.all(namespace,opts);return {count:value.rows.length,bytes:value.rows.reduce((n,row)=>n+sceneBytes(row.record),0),generation:value.generation,limit:4*1024*1024};});},
    storageSummary(namespace,options={}){return run(namespace,{...options,inventoryOnly:true},async opts=>{const value=await catalogue.all(namespace,opts),documentBytes=value.rows.reduce((n,row)=>n+sceneBytes(row.record),0);return {status:'ready',count:value.rows.length,documentBytes,indexBytes:value.indexBytes,bytes:documentBytes+value.indexBytes,generation:value.generation};});},
    clearChat:(namespace,chatKey,options)=>clear(namespace,chatKey,options),clearAccount:(namespace,options)=>clear(namespace,null,options),
    exportAll:(namespace,options={})=>run(namespace,options,async opts=>({...await catalogue.exportAll(namespace,opts),localJournal:await journal.read(namespace)})),
    close(){closed=true;catalogue.close();legacy.close();journal.close();},
  });
}
