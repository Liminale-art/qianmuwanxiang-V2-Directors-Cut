import {createConfiguredStAccountStorage} from './qianmu-st-account-storage.js';
import {createComfyScenePreservation} from './qianmu-comfy-scene-preservation.js';
import {comfySceneScope,comfySceneScopeKey} from './qianmu-comfy-scene-lock.js';
import {assertComfyRouteNamespace} from './qianmu-comfy-route-contract.js';
import {COMFY_SCENE_NATIVE_SLOT as slot,COMFY_SCENE_EVENT_SLOT,COMFY_SCENE_EVENT_SCHEMA,sceneNativeFail as fail,scenePredecessorFail,sceneSame,sceneHash,sceneBytes,sceneReference,sceneLeaves,emptySceneIndex,validateSceneIndex,validateSceneEvent,validateSceneEventLink,validateSceneProposal} from './qianmu-comfy-scene-native-contract.js';

// Per-scene immutable transition originals, not a whole 4MiB account upload for
// each shot. Current reads verify their own complete operation/before/after;
// full export verifies every retained original. The shared head is NOT CAS.
export function createComfySceneCatalogue({legacy,createStorage=createConfiguredStAccountStorage}={}){
  const preservation=createComfyScenePreservation({local:legacy,createStorage});let client,opening,closed=false,known=false,queue=Promise.resolve();
  const operation=(namespace,options,work)=>{
    assertComfyRouteNamespace(namespace);
    const captured={...options},valid=()=>!closed&&!captured.signal?.aborted&&(!captured.isCurrent||captured.isCurrent()===true);
    const check=async()=>{if(!valid()||await captured.guard?.()===false||!valid())fail('续场运行账户或页面已变化');return true;};
    const task=queue.then(async()=>{
      await check();opening??=Promise.resolve().then(()=>createStorage({maxBytes:8*1024*1024,isCurrent:()=>!closed})).then(value=>{if(closed||value.namespace!==namespace){value.close();fail('续场运行账户不符');}client=value;return value;}).catch(e=>{opening=null;throw e;});
      await opening;await check();if(client.namespace!==namespace)fail('续场运行会话不能切换账户');const transport={guard:check,signal:captured.signal};
      const read=async()=>{const result=await client.read(slot,transport);await check();if(!result.exists&&(known||captured.requireExisting))fail('已确认的ST续场目录缺失，未建立空库');if(result.exists){validateSceneIndex(result.value,namespace,client.scope);known=true;}return result;};
      let found=await read(),index=found.exists?structuredClone(found.value):emptySceneIndex(namespace);
      const baseline=await legacy.snapshot(namespace,{isCurrent:valid}),sourceDigest=await sceneHash(baseline);await check();
      const stable=async()=>{await legacy.assertSnapshot(baseline,{isCurrent:valid});await check();};
      const save=async next=>{next.revision=index.revision+1;validateSceneIndex(next,namespace,client.scope);await stable();known=true;found=await client.write(slot,next,{...transport,expectedFingerprint:found.fingerprint});if(!sceneSame(found.value,next))fail('续场目录尚未读回');index=structuredClone(found.value);await stable();};
      const validateLoaded=async(saved,entry,meta)=>{const value=validateSceneEvent(saved.value,namespace);if(value.generation>index.generation)fail('续场原件来自未确认的清理代数');await validateSceneEventLink(value,entry,meta);await check();return value;};
      const load=async(entry,meta)=>validateLoaded(await client.readImmutable(sceneReference(meta.reference,client.scope),transport),entry,meta);
      const preserve=async event=>{validateSceneEvent(event,namespace);const saved=await client.preserveImmutable(COMFY_SCENE_EVENT_SLOT,event,transport);await check();if(!sceneSame(saved.value,event))fail('续场操作原件尚未读回');return {digest:await sceneHash(event),stateHash:await sceneHash(event.record),stateBytes:event.record===null?0:sceneBytes(event.record),reference:sceneReference(saved.reference,client.scope),parents:event.parents};};
      const find=(value,scope)=>value.entries.find(row=>comfySceneScopeKey(row.scope)===comfySceneScopeKey(scope));
      const review=async scope=>{
        const entry=find(index,scope),heads=sceneLeaves(entry),branches=[];for(const head of heads){const event=await load(entry,head);branches.push({digest:head.digest,record:event.record});}
        return {scope,blocked:entry?.blocked===true,branches,heads:heads.map(row=>row.digest),generation:index.generation};
      };
      const reviewMany=async entries=>{
        const rows=entries.map(entry=>({scope:entry.scope,blocked:entry.blocked,branches:[],heads:sceneLeaves(entry).map(meta=>meta.digest),generation:index.generation,error:'',failure:null}));
        function* pending(){for(let i=0;i<entries.length;i++)for(const meta of sceneLeaves(entries[i]))if(!rows[i].failure)yield {entry:entries[i],meta,row:rows[i]};}
        const iterator=pending();let batch=[];
        do{
          batch=[];for(let next=iterator.next();!next.done;next=iterator.next()){batch.push(next.value);if(batch.length===4)break;}
          if(!batch.length)break;await check();
          const references=batch.map(({meta})=>sceneReference(meta.reference,client.scope));
          const loaded=client.readImmutableBatch?await client.readImmutableBatch(references,transport):await Promise.allSettled(references.map(reference=>client.readImmutable(reference,transport)));
          if(!Array.isArray(loaded)||loaded.length!==batch.length)fail('续场批次原件未完整返回');
          for(let i=0;i<batch.length;i++){
            const {entry,meta,row}=batch[i];try{if(loaded[i].status!=='fulfilled')throw loaded[i].reason||Error('原件不可读取');
              const event=await validateLoaded(loaded[i].value,entry,meta);if(!row.failure)row.branches.push({digest:meta.digest,record:event.record});
            }catch(error){await check();row.failure||=error;row.error=String(row.failure?.message||'原件不可读取').slice(0,300);row.branches=[];}
          }await check();
        }while(batch.length);
        return rows;
      };
      const resolve=async scope=>{
        const entry=find(index,scope);if(entry?.blocked)fail('清理后发现另一端旧续场来源，原件已保全，请核对来源');
        const heads=sceneLeaves(entry),events=[];for(const head of heads)events.push(await load(entry,head));
        if(events.some(value=>!sceneSame(value.record,events[0].record)))fail('两端续场状态分叉，原件均保留，未自动选择或提交');
        return {scope,record:events[0]?.record??null,heads:heads.map(row=>row.digest),generation:index.generation};
      };
      if(!index.sources.includes(sourceDigest)&&(baseline.usage!==null||baseline.rows.length)){
        if(captured.inventoryOnly)fail('旧续场来源尚未接入，请先打开续场管理核对；未在只读盘点时上传');
        const kept=await preservation.preserve(namespace,{...transport,isCurrent:valid});if(!sceneSame(kept.snapshot,baseline))fail('旧续场来源在接入期间变化');await stable();
        const next=structuredClone(index),initial=!found.exists;if(initial)next.generation=baseline.usage?.generation??0;
        if(initial&&!baseline.rows.length&&next.generation>0)next.cleared=true;
        for(const row of baseline.rows){const record=row.value.record,scope=record.scope,old=find(next,scope),stateHash=await sceneHash(record);if(old?.versions.some(v=>v.stateHash===stateHash))continue;
          const event={schema:COMFY_SCENE_EVENT_SCHEMA,namespace,scope,record,before:null,action:null,source:null,at:record.updatedAt,generation:next.generation,parents:[]};
          const meta=await preserve(event),entry=old||{scope,blocked:!initial&&next.cleared,versions:[]};entry.versions.push(meta);if(!old)next.entries.push(entry);
        }
        next.sources.push(sourceDigest);await save(next);
      }
      const ctx={get index(){return index;},get exists(){return found.exists;},resolve,review,reviewMany,find,load,preserve,save,check,stable};
      const result=await work(ctx);await stable();if((await read()).fingerprint!==found.fingerprint)fail('续场目录在核对期间变化');return structuredClone(result);
    });queue=task.then(()=>{},()=>{});return task;
  };
  return Object.freeze({
    get confirmed(){return known;},
    checkout(scope,options={}){scope=comfySceneScope(scope);return operation(scope.namespace,options,ctx=>ctx.resolve(scope));},
    reviewScope(scope,options={}){scope=comfySceneScope(scope);return operation(scope.namespace,options,ctx=>ctx.review(scope));},
    review(namespace,chatKey,options={}){return operation(namespace,options,async ctx=>{
      const rows=await ctx.reviewMany(ctx.index.entries.filter(row=>row.scope.chatKey===chatKey));
      return {rows:rows.map(({failure,...row})=>row),generation:ctx.index.generation};
    });},
    all(namespace,options={}){return operation(namespace,options,async ctx=>{
      const reviewed=await ctx.reviewMany(ctx.index.entries.filter(entry=>options.chatKey===undefined||entry.scope.chatKey===options.chatKey)),rows=[];
      for(const row of reviewed){if(row.blocked)fail('清理后发现另一端旧续场来源，原件已保全，请核对来源');if(row.failure)throw row.failure;
        if(row.branches.some(branch=>!sceneSame(branch.record,row.branches[0].record)))fail('两端续场状态分叉，原件均保留，未自动选择或提交');
        const record=row.branches[0]?.record??null;if(record!==null)rows.push({scope:row.scope,record,heads:row.heads,generation:row.generation});
      }return {rows,generation:ctx.index.generation,indexBytes:ctx.exists?sceneBytes(ctx.index):0};
    });},
    publish(proposal,options={}){const input=structuredClone(proposal);validateSceneProposal(input);return operation(input.namespace,options,async ctx=>{
      const digests=await Promise.all(input.events.map(sceneHash)),already=input.events.every((event,i)=>ctx.find(ctx.index,event.scope)?.versions.some(v=>v.digest===digests[i]));
      if(already){for(const [i,event]of input.events.entries()){const entry=ctx.find(ctx.index,event.scope);await ctx.load(entry,entry.versions.find(v=>v.digest===digests[i]));}return true;}
      if(ctx.index.generation!==input.generation)scenePredecessorFail('续场清理代数已变化，未重放旧操作');const next=structuredClone(ctx.index);
      const states=new Map();
      for(const event of input.events){const key=comfySceneScopeKey(event.scope);if(!states.has(key))states.set(key,await ctx.review(event.scope));const state=states.get(key),branch=event.action.type==='branch_result';
        if(branch){const original=state.branches.find(row=>row.digest===event.parents[0]);if(!sceneSame(state.heads,event.action.heads)||!original||!sceneSame(original.record,event.before))scenePredecessorFail('原任务分支前序已变化，未覆盖其他来源');}
        else{const reviewing=event.action.type==='resolve';
          if(!sceneSame(state.heads,event.parents)||!sceneSame(reviewing?state.branches:state.branches[0]?.record??null,event.before)||!reviewing&&(state.blocked||state.branches.some(row=>!sceneSame(row.record,event.before))))scenePredecessorFail('续场原前序已变化，未覆盖另一端操作');
        }
        if(event.action.type==='link'&&!sceneSame((await ctx.resolve(event.action.request.sourceScope)).record,event.source))scenePredecessorFail('续场关联来源已变化');
      }
      for(const event of input.events){const previous=ctx.find(next,event.scope),entry=previous||{scope:event.scope,blocked:false,versions:[]};const meta=await ctx.preserve(event);entry.versions.push(meta);await validateSceneEventLink(event,entry,meta);if(event.action.type==='resolve')entry.blocked=false;if(!previous)next.entries.push(entry);}
      if(input.cleared){next.generation++;next.cleared=true;}await ctx.save(next);return true;
    });},
    exportAll(namespace,options={}){return operation(namespace,options,async ctx=>{const entries=[];for(const entry of ctx.index.entries){const versions=[];for(const meta of entry.versions)versions.push(await ctx.load(entry,meta));entries.push({scope:entry.scope,blocked:entry.blocked,versions});}return {namespace,generation:ctx.index.generation,entries,sources:ctx.index.sources};});},
    exportScene(scope,options={}){scope=comfySceneScope(scope);return operation(scope.namespace,options,async ctx=>{
      const entry=ctx.find(ctx.index,scope);if(!entry)fail('此场景没有保留的操作原件');const versions=[];let bytes=0;
      for(const meta of entry.versions){const value=await ctx.load(entry,meta);bytes+=sceneBytes(value);if(bytes>32*1024*1024)fail('本场景原件超过32MiB，未截断或下载不完整文件');versions.push(value);}
      return {schema:'qianmu.comfy.scene-export.v1',namespace:scope.namespace,scope,generation:ctx.index.generation,entry,versions};
    });},
    close(){closed=true;client?.close();preservation.close();},
  });
}
