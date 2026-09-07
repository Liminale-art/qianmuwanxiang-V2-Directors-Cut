// Read-only per-shot verification, using the same explicitly selected requester as generation.
import {checkComfyReadiness} from './qianmu-comfy-readiness.js';
export async function checkComfyCharacterReadiness(request,{transport,headers,fetchImpl=globalThis.fetch,guard=async()=>{},timeoutMs=30000,signal}={}) {
  if(!['browser','gateway','legacy-auto'].includes(transport))throw Error('请确认 Comfy 请求方式');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.min(30000,Math.max(1000,timeoutMs)));
  const abort=()=>controller.abort();if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
  try {
    let result;await guard();controller.signal.throwIfAborted();
    if(transport!=='gateway'){
      try{result=await checkComfyReadiness(request,{signal:controller.signal,fetchImpl:async(url,options)=>{await guard();return fetchImpl(url,options);}});}
      catch(error){if(transport==='browser'||error.code!=='comfy_readiness_transport'||controller.signal.aborted)throw error;}
    }
    await guard();
    if(!result){
      const response=await fetchImpl('/api/plugins/qianmu-tts/image/comfy/readiness',{method:'POST',headers,credentials:'same-origin',redirect:'error',signal:controller.signal,body:JSON.stringify(request)});
      if(!response.ok) {await response.body?.cancel?.();throw Error(response.status===404?'请更新增强服务后使用 Comfy 节点检查':`Comfy 节点检查失败（${response.status}）`);}
      const limit=256*1024;let raw='';const reader=response.body?.getReader();
      if(!reader)throw Error('Comfy 节点检查没有返回内容');
      let size=0;const decoder=new TextDecoder();
      try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit)throw Error('Comfy 节点检查返回过大');raw+=decoder.decode(value,{stream:true});await guard();}raw+=decoder.decode();}
      catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
      result=JSON.parse(raw);
    }
    await guard();
    if(!result?.ok||result.schemaVersion!==1||result.actualGenerationVerified!==false||!Number.isSafeInteger(result.errors)||result.errors!==0
      ||!Number.isSafeInteger(result.warnings)||result.warnings<0||result.ready!==(result.errors===0&&result.warnings===0))throw Error(String(result?.issues?.[0]?.message||result?.message||'Comfy 节点或模型未通过检查').replace(/[\r\n]/g,' ').slice(0,180));
    const graph=typeof request.workflow==='string'?JSON.parse(request.workflow):request.workflow;
    const deferred=new Set((Array.isArray(result.issues)?result.issues:[]).filter(issue=>issue?.severity==='warning'&&issue.code==='reference_pending_upload'
      &&issue.field==='image'&&graph?.[issue.nodeId]?.class_type==='LoadImage'&&/^%qianmu_reference(?:_([1-9]|1[0-6]))?%$/.test(graph[issue.nodeId].inputs?.image||''))
      .map(issue=>JSON.stringify([issue.nodeId,issue.field])));
    // File contents and uploaded names are checked in the existing asset/upload path. Keep ready=false;
    // exclude only this precise deferred check from unrelated unknown-node warnings, never all warnings.
    return {...result,pendingReferenceUploads:deferred.size,unverifiedWarnings:Math.max(0,result.warnings-deferred.size)};
  }finally{clearTimeout(timer);controller.abort();signal?.removeEventListener('abort',abort);}
}

// Short-lived candidate exploration only. This memo is never attached to real queued jobs.
// Exact input + transport + credential/headers identity; no graph, Key or authorization is retained.
export function createComfyReadinessSession({check=checkComfyCharacterReadiness,maxEntries=64,maxBytes=2*1024*1024}={}){
  if(!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>64||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>2*1024*1024)throw Error('节点检查缓存限额无效');
  let closed=false,bytes=0,hits=0,misses=0;const cache=new Map(),pending=new Map(),controllers=new Set();
  const fail=message=>Object.assign(new Error(message),{code:'comfy_readiness_session',submissionState:'not_submitted'});
  return {
    async checkComfyCharacterReadiness(request,options={}){
      const source=JSON.stringify([request,options.transport,options.headers]);
      const current=async()=>{
        options.signal?.throwIfAborted();
        if(closed)throw fail('本批次节点检查已结束');await options.guard?.();
        if(closed||source!==JSON.stringify([request,options.transport,options.headers]))throw fail('节点检查输入已变化，未复用旧结果');
      };
      await current();
      if(!globalThis.crypto?.subtle)throw fail('当前环境不能安全区分节点检查身份');
      const input=new TextEncoder().encode(source);if(input.byteLength>8*1024*1024)throw fail('本次节点检查输入过大');
      const key=[...new Uint8Array(await crypto.subtle.digest('SHA-256',input))].map(byte=>byte.toString(16).padStart(2,'0')).join('');await current();
      if(cache.has(key)){hits++;const result=JSON.parse(cache.get(key));await current();return result;}
      if(pending.has(key)){hits++;const result=await pending.get(key);await current();return JSON.parse(result);}
      if(pending.size>=8)throw fail('候选节点检查正在处理，请稍后再试');
      misses++;const controller=new AbortController();controllers.add(controller);
      const abort=()=>controller.abort();if(options.signal?.aborted)abort();else options.signal?.addEventListener('abort',abort,{once:true});
      const operation=(async()=>{
        const checked=await check(request,{...options,guard:current,signal:controller.signal});await current();
        if(checked?.ok!==true||checked.schemaVersion!==1||checked.actualGenerationVerified!==false||checked.errors!==0
          ||!Number.isSafeInteger(checked.warnings)||checked.warnings<0||checked.ready!==(checked.warnings===0))throw fail('节点核查没有返回有效静态结果');
        const summary=Object.fromEntries(['ok','schemaVersion','actualGenerationVerified','ready','errors','warnings','issues','issueCount','nodeCount','classCount','message','pendingReferenceUploads','unverifiedWarnings']
          .filter(key=>Object.hasOwn(checked,key)).map(key=>[key,checked[key]]));
        const data=JSON.stringify(summary),size=new TextEncoder().encode(data).byteLength;
        if(size>256*1024)throw fail('节点核查摘要过大');
        if(cache.size<maxEntries&&bytes+size<=maxBytes){cache.set(key,data);bytes+=size;}
        return data;
      })();pending.set(key,operation);
      try{const result=await operation;await current();return JSON.parse(result);}
      finally{if(pending.get(key)===operation)pending.delete(key);controllers.delete(controller);controller.abort();options.signal?.removeEventListener('abort',abort);}
    },
    stats:()=>({entries:cache.size,bytes,hits,misses,pending:pending.size,closed}),
    close(){closed=true;cache.clear();bytes=0;pending.clear();for(const controller of controllers)controller.abort();controllers.clear();},
  };
}
