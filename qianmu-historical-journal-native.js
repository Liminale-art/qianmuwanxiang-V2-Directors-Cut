import {createConfiguredStAccountStorage} from './qianmu-st-account-storage.js';
import {inspectHistoricalChatMutation,historicalChatMutationNext,HISTORICAL_CHAT_JOURNAL_BYTES} from './qianmu-historical-chat-journal.js';
import {parseBoundedJson} from './qianmu-json-input.js';
import {vibeDigest} from './qianmu-vibe-file.js';

const slot='historical-chat-journal',schema='qianmu.historical-chat-journal.v1',partSchema='qianmu.historical-chat-journal-part.v1';
const utf8=new TextEncoder(),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const fail=message=>{throw Object.assign(Error(message),{code:'historical_journal_native',submissionState:'not_submitted'});};
const partSlot=sha=>`historical-journal-part-${sha}`,closedSlot=sha=>`historical-journal-closed-${sha}`;

// Native ST files, not a backend-only feature. The head is optimistic, NOT a
// cross-device lock. Retained content-addressed parts protect interrupted writes.
// Legacy proposals keep their existing validation/capacity limits. Discriminated
// paged proposals contain references only; host restoration is a separate stage.
export function createNativeHistoricalJournal({legacy,createStorage=createConfiguredStAccountStorage,now=Date.now}={}){
  if(!legacy||typeof createStorage!=='function')fail('原聊天恢复记录环境不完整');
  let storage,opening,closed=false,busy=false,owner;
  const current=()=>!closed;
  async function check(namespace,options={}){
    if(closed||options.isCurrent&&options.isCurrent()!==true)fail('恢复记录页面已结束');
    if(typeof namespace!=='string'||!/^st-user:.+/.test(namespace)||namespace.length>512||/[\u0000-\u001f\u007f]/.test(namespace))fail('恢复记录账户无效');
    if(owner&&owner!==namespace)fail('恢复记录账户已变化');owner??=namespace;
    if(!storage){
      opening??=createStorage({isCurrent:current,maxBytes:512*1024}).then(value=>{if(closed){value.close();fail('恢复记录页面已结束');}storage=value;return value;});
      await opening;
    }
    if(closed||storage.namespace!==namespace||options.isCurrent&&options.isCurrent()!==true)fail('恢复记录账户或页面已变化');return true;
  }
  function receipt(value){
    if(value?.persistence!=='st-account-file'||value.concurrency!=='optimistic-non-cas'||typeof value.exists!=='boolean'
      ||(value.exists?!hash(value.fingerprint):value.fingerprint!==null||value.value!==null))fail('恢复记录保存回执不完整');return value;
  }
  async function read(key,namespace,options){await check(namespace,options);const value=receipt(await storage.read(key,{guard:()=>check(namespace,options)}));await check(namespace,options);return value;}
  async function write(key,value,fingerprint,namespace,options){await check(namespace,options);const result=receipt(await storage.write(key,value,{expectedFingerprint:fingerprint,guard:()=>check(namespace,options)}));await check(namespace,options);if(!result.exists||!same(result.value,value))fail('恢复记录尚未完整读回');return result;}
  async function put(key,value,namespace,options){const before=await read(key,namespace,options);if(before.exists){if(!same(before.value,value))fail('恢复记录副本冲突，未覆盖');return;}await write(key,value,null,namespace,options);}
  function head(value,namespace){
    if(!exact(value,['schema','namespace','reference','phase','revision','createdAt','updatedAt','closed'])||value.schema!==schema||value.namespace!==namespace||typeof value.closed!=='boolean')fail('恢复记录目录损坏');
    const ref=value.reference;
    if(!exact(ref,['sha256','bytes','parts'])||!hash(ref.sha256)||!Number.isSafeInteger(ref.bytes)||ref.bytes<1||ref.bytes>HISTORICAL_CHAT_JOURNAL_BYTES
      ||!Array.isArray(ref.parts)||!ref.parts.length||ref.parts.length>1024||Object.keys(ref.parts).length!==ref.parts.length
      ||ref.parts.some(part=>!exact(part,['sha256','bytes'])||!hash(part.sha256)||!Number.isSafeInteger(part.bytes)||part.bytes<1||part.bytes>196608)
      ||ref.parts.reduce((sum,part)=>sum+part.bytes,0)!==ref.bytes)fail('恢复记录分页目录不完整');return value;
  }
  async function loadHead(namespace,options){const found=await read(slot,namespace,options);if(found.exists)head(found.value,namespace);return found;}
  async function unpack(found,namespace,options){
    if(!found.exists)return null;const value=found.value,parts=[];
    for(const ref of value.reference.parts){
      const loaded=await read(partSlot(ref.sha256),namespace,options),part=loaded.value;
      if(!loaded.exists||!exact(part,['schema','namespace','text'])||part.schema!==partSchema||part.namespace!==namespace||typeof part.text!=='string'
        ||utf8.encode(part.text).length!==ref.bytes||await vibeDigest(part.text)!==ref.sha256)fail('恢复记录分页缺失或校验失败，未作为空记录');
      parts.push(part.text);
    }
    const text=parts.join('');parts.length=0;if(await vibeDigest(text)!==value.reference.sha256)fail('恢复记录完整摘要不符');
    const proposal=parseBoundedJson(text,{maxBytes:HISTORICAL_CHAT_JOURNAL_BYTES,maxDepth:44,maxNodes:1200000,label:'原聊天保存记录'});
    const row=await inspectHistoricalChatMutation({version:1,namespace,proposal,proposalDigest:value.reference.sha256,phase:value.phase,revision:value.revision,createdAt:value.createdAt,updatedAt:value.updatedAt});
    const after=await loadHead(namespace,options);if(after.fingerprint!==found.fingerprint)fail('另一设备已更新恢复记录，请重新核对');return row;
  }
  async function pack(row,namespace,options){
    const text=JSON.stringify(row.proposal),parts=[];
    for(let at=0;at<text.length;){
      let end=Math.min(text.length,at+49152);if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;
      const piece=text.slice(at,end),sha256=await vibeDigest(piece);await check(namespace,options);
      await put(partSlot(sha256),{schema:partSchema,namespace,text:piece},namespace,options);parts.push({sha256,bytes:utf8.encode(piece).length});at=end;
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    return {sha256:row.proposalDigest,bytes:utf8.encode(text).length,parts};
  }
  const envelope=(row,reference,ended=false)=>({schema,namespace:row.namespace,reference,phase:row.phase,revision:row.revision,createdAt:row.createdAt,updatedAt:row.updatedAt,closed:ended});
  const marker=(namespace,digest,createdAt)=>({schema:'qianmu.historical-chat-journal-closed.v1',namespace,proposalDigest:digest,createdAt});
  const markerKey=async value=>closedSlot(await vibeDigest(JSON.stringify(value)));
  async function priorLocal(namespace,options,found){
    const local=await legacy.loadHistoricalChatMutation(namespace,options);await check(namespace,options);if(!local)return {row:null,ended:false};
    const row=await inspectHistoricalChatMutation(local);if(row.namespace!==namespace)fail('本机恢复记录账户不符');
    if(found.exists&&found.value.reference.sha256===row.proposalDigest&&found.value.createdAt===row.createdAt){
      if(row.revision>found.value.revision||row.revision===found.value.revision&&row.phase!==found.value.phase)fail('本机旧页面又更新了恢复记录，请保留两份核对');return {row,ended:found.value.closed};
    }
    const expected=marker(namespace,row.proposalDigest,row.createdAt),ended=await read(await markerKey(expected),namespace,options);
    if(ended.exists){if(!same(ended.value,expected))fail('本机旧记录结束依据损坏');return {row,ended:true};}
    if(found.exists)fail('ST 与本机有两份不同的待核对记录，均已保留，未自动覆盖');return {row,ended:false};
  }
  async function state(namespace,options){
    await check(namespace,options);let found=await loadHead(namespace,options);const original=await priorLocal(namespace,options,found),local=original.row;
    if(!found.exists&&local&&!original.ended){
      const reference=await pack(local,namespace,options);
      if(!same(await legacy.loadHistoricalChatMutation(namespace,options),local))fail('保全期间本机旧记录已变化，未发布旧副本');await check(namespace,options);
      found=await write(slot,envelope(local,reference),null,namespace,options);
      // Preserve the original IDB record. Never delete it as a migration step.
    }
    const row=await unpack(found,namespace,options),last=await priorLocal(namespace,options,found);return {found,row:found.value?.closed?null:row,legacyBaseline:last.row};
  }
  async function exclusive(work){if(closed||busy)fail('恢复记录正在核对或已关闭');busy=true;try{return await work();}finally{busy=false;}}
  async function historyUnchanged(before,namespace,options){
    await check(namespace,options);const latest=await loadHead(namespace,options);
    if(latest.fingerprint!==before.found.fingerprint||!same(await legacy.loadHistoricalChatMutation(namespace,options),before.legacyBaseline))fail('配置保全期间原聊天恢复记录已变化，请重新核对');
    await check(namespace,options);return true;
  }
  const configurationPending=(namespace,options)=>typeof legacy.hasConfigurationMutation==='function'?legacy.hasConfigurationMutation(namespace,options):legacy.loadMutation(namespace);
  return Object.freeze({...legacy,persistence:'st-account-file',concurrency:'optimistic-non-cas',
    loadHistoricalChatMutation(namespace,options={}){return exclusive(async()=>structuredClone((await state(namespace,options)).row));},
    assertNoHistoricalChatMutation(namespace,options={}){return exclusive(async()=>{if((await state(namespace,options)).row)fail('本账户有原聊天恢复记录，请先核对原包或在分镜恢复记录中明确结束');return true;});},
    hasMutation(namespace){return exclusive(async()=>Boolean((await state(namespace,{})).row||await configurationPending(namespace,{})));},
    prepareMutation(input,options={}){const captured=structuredClone(input);return exclusive(async()=>{const before=await state(captured.namespace,options);if(before.row)fail('本账户有原聊天恢复记录，未开始其他导入');
      const nativeHistoricalCheck=()=>historyUnchanged(before,captured.namespace,options);
      const saved=await legacy.prepareMutation(captured,{...options,nativeHistoricalBaseline:before.legacyBaseline,nativeHistoricalCheck});await nativeHistoricalCheck();return saved;});},
    updateMutation(input,phase,options={}){const captured=structuredClone(input);return exclusive(async()=>{const before=await state(captured.namespace,options);if(before.row)fail('本账户有原聊天恢复记录，请保留双方核对');
      const nativeHistoricalCheck=()=>historyUnchanged(before,captured.namespace,options);
      const saved=await legacy.updateMutation(captured,phase,{...options,nativeHistoricalCheck});await nativeHistoricalCheck();return saved;});},
    prepareHistoricalChatMutation(input,{confirmed=false,...options}={}){
      const captured=structuredClone(input);return exclusive(async()=>{
        if(confirmed!==true)fail('请明确确认保存原聊天待核对记录');const row=await inspectHistoricalChatMutation(captured),namespace=row.namespace;
        if(row.phase!=='prepared'||row.revision!==1)fail('恢复记录必须从准备阶段开始');
        const before=await state(namespace,options);if(before.row||await configurationPending(namespace,options))fail('本账户已有待核对记录，未覆盖');await check(namespace,options);
        if(before.found.exists){const ended=marker(namespace,before.found.value.reference.sha256,before.found.value.createdAt);await put(await markerKey(ended),ended,namespace,options);}
        const reference=await pack(row,namespace,options);await historyUnchanged(before,namespace,options);
        if(await configurationPending(namespace,options))fail('保全期间出现配置恢复记录，请先核对，未发布原聊天恢复');await check(namespace,options);
        const saved=await write(slot,envelope(row,reference),before.found.fingerprint,namespace,options),result=await unpack(saved,namespace,options);
        if(await configurationPending(namespace,options))fail('原聊天与配置恢复记录并发变化，请保留双方核对');await check(namespace,options);return result;
      });
    },
    updateHistoricalChatMutation(input,phase,options={}){
      const captured=structuredClone(input);return exclusive(async()=>{
        const previous=await inspectHistoricalChatMutation(captured),namespace=previous.namespace,before=await state(namespace,options);
        if(!same(before.row,previous))fail('恢复记录已被另一页面修改');const next=historicalChatMutationNext(previous,phase,now());
        if(await configurationPending(namespace,options))fail('存在配置恢复记录，请先核对双方状态');await check(namespace,options);
        const saved=await write(slot,envelope(next,before.found.value.reference),before.found.fingerprint,namespace,options);return unpack(saved,namespace,options);
      });
    },
    dismissHistoricalChatMutation(input,{confirmed=false,...options}={}){
      const captured=structuredClone(input);return exclusive(async()=>{
        if(confirmed!==true)fail('请明确确认结束此记录；不会删除聊天或原件');const previous=await inspectHistoricalChatMutation(captured),namespace=previous.namespace,before=await state(namespace,options);
        if(!same(before.row,previous))fail('恢复记录已变化，未结束');const saved=await write(slot,envelope(previous,before.found.value.reference,true),before.found.fingerprint,namespace,options);
        await unpack(saved,namespace,options);return true;
      });
    },
    close(){closed=true;storage?.close();legacy.close();},
  });
}
