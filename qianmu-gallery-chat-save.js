import {captureCurrentChatSource} from './qianmu-current-chat-source.js';
import {createChatGalleryReceiptClient,createChatGallerySupplementClient,createChatGalleryEvidenceSourceClient} from './qianmu-chat-character-receipt-client.js';
import {chatGalleryDigest} from './qianmu-chat-gallery-digest.js';
import {captureGallerySupplement} from './qianmu-gallery-archive-supplement.js';
import {chatGalleryReceiptText} from './qianmu-chat-gallery-receipt.js';
import {scanGalleryEvidenceSource} from './qianmu-gallery-evidence-source.js';
import {projectStoryboardChatMessages,storyboardChatProjectionMatches} from './qianmu-storyboard-chat-evidence.js';
import {readResolvedGalleryWrite,scanResolvedGalleryWrite} from './qianmu-gallery-resolved-write.js';
import {createGalleryWriteProposal} from './qianmu-gallery-write-proposal.js';
import {createHistoricalChatMutation,inspectHistoricalChatMutation} from './qianmu-historical-chat-journal.js';
import {acquireChatSaveLock,releaseChatSaveLock} from './qianmu-chat-save-lock.js';
import {verifyPreparedGalleryFiles} from './qianmu-gallery-write-files.js';
import {GALLERY_SUPPLEMENT_FIELDS,galleryContinuitySavePending} from './qianmu-gallery-continuity.js?v=1.59.370';

const scope='paged-gallery-current-chat',fields=['storyboardImages',...GALLERY_SUPPLEMENT_FIELDS];
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),equal=(a,b)=>chatGalleryReceiptText([{value:a}]).text===chatGalleryReceiptText([{value:b}]).text;
const fail=message=>{throw Object.assign(Error(message),{code:'gallery_chat_save',submissionState:'not_submitted'});};
const summary=receipt=>({count:receipt.count,bytes:receipt.bytes,sha256:receipt.sha256});

// Explicit, CURRENT exact chat only. Shared host lock + shared durable journal;
// no alternative JSONL writer, no pruning, no automatic retry after uncertainty.
export function createPagedGallerySaveSession({source,writeStorage,writeReference,getContext,epoch,account,headers,guard,isCurrent,journal,
  fetchImpl=globalThis.fetch,timeoutMs=600000,hostTimeoutMs=10000,onProgress=()=>{}}={}){
  if(![getContext,epoch,account,headers,guard,isCurrent,fetchImpl,onProgress].every(fn=>typeof fn==='function')||!source?.metadata||!writeStorage
    ||!['loadHistoricalChatMutation','prepareHistoricalChatMutation','updateHistoricalChatMutation'].every(k=>typeof journal?.[k]==='function')
    ||!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>600000||!Number.isFinite(hostTimeoutMs)||hostTimeoutMs<1)fail('分页保存缺少准确来源、宿主或持久记录');
  const selected=source.metadata,reference=structuredClone(writeReference),namespace=selected.plan.scope.namespace,currentSource=captureCurrentChatSource({getContext,epoch});
  const context=getContext(),store=context.chatMetadata.story_director_liminale,saveHost=context.saveMetadata,token={};
  if(!same(currentSource.target,selected.plan.target)||!same(currentSource.source,{ownerKey:selected.plan.scope.ownerKey,chatKey:selected.plan.scope.chatKey})
    ||!store||typeof saveHost!=='function'){currentSource.close();fail('请先打开准确的原聊天，未切换或创建资料槽');}
  let closed=false,busy=false,hostPending=false,intent=null,row=null,abortActive;
  const current=()=>{if(closed||isCurrent()!==true)fail('分页保存页面已变化');currentSource.assertCurrent();
    if(getContext().chatMetadata.story_director_liminale!==store||getContext().saveMetadata!==saveHost)fail('宿主资料或保存接口已变化');
    if(galleryContinuitySavePending(store))fail('续写或换版依据仍在保存，未写回恢复资料');return true;};
  const release=()=>{if(!busy&&!hostPending)releaseChatSaveLock(store,token);};
  const unknown=reason=>({status:'unconfirmed',reason,durableJournal:Boolean(row),metadataVerified:false,canPrune:false});
  const supplement=()=>{const saved={};for(const key of fields.slice(1)){const descriptor=Object.getOwnPropertyDescriptor(store,key);
    if(descriptor){if(!Object.hasOwn(descriptor,'value'))fail('聊天资料存在不可安全读取的字段');saved[key]=descriptor.value;}}
    return captureGallerySupplement(saved);};
  const local=expected=>{current();const property=Object.getOwnPropertyDescriptor(store,'storyboardImages');if(!property||!Object.hasOwn(property,'value'))fail('原聊天画面未初始化');
    return same(chatGalleryDigest(property.value),expected.gallery)&&equal(supplement(),expected.saved);};
  async function operation(work){
    current();if(busy||hostPending||!acquireChatSaveLock(store,token))fail('上一项聊天保存尚未结束，请先核对');busy=true;
    const controller=new AbortController(),clients=[];let reject,worker,finished=false;
    const cancelled=new Promise((_,no)=>reject=no),abort=()=>{controller.abort();clients.forEach(c=>c.close());reject(Error('分页保存已取消或超时'));};abortActive=abort;
    const timer=setTimeout(()=>{closed=true;abort();},timeoutMs);
    const active=()=>{try{return !controller.signal.aborted&&current();}catch{return false;}};
    const check=async()=>{current();if(controller.signal.aborted||await guard()!==true||await account()!==namespace||controller.signal.aborted)fail('分页保存账户或来源已变化');current();return true;};
    const fetchLinked=async(url,options={})=>{await check();const linked=new AbortController(),stop=()=>{linked.abort();controller.signal.removeEventListener('abort',stop);options.signal?.removeEventListener('abort',stop);};
      controller.signal.addEventListener('abort',stop,{once:true});options.signal?.addEventListener('abort',stop,{once:true});if(controller.signal.aborted||options.signal?.aborted)stop();
      try{return await fetchImpl(url,{...options,signal:linked.signal});}catch(error){stop();throw error;}};
    const shared={namespace,target:currentSource.target,headers,guard:check,fetchImpl:fetchLinked};
    for(const create of [createChatGalleryReceiptClient,createChatGallerySupplementClient,createChatGalleryEvidenceSourceClient])clients.push(create(shared));
    const op={check,active,signal:controller.signal,receipt:clients[0],supplement:clients[1],body:clients[2],shared};
    worker=Promise.resolve().then(()=>work(op));void worker.finally(()=>{finished=true;if(!busy)release();}).catch(()=>{});
    try{return await Promise.race([worker,cancelled]);}catch(error){if(intent||row)return {...unknown('needs_review'),message:error.message};throw error;}
    finally{clearTimeout(timer);abortActive=null;controller.abort();clients.forEach(c=>c.close());
      // A late guard/IO operation cannot release exclusion before it has stopped.
      if(finished){busy=false;release();}else void worker.finally(()=>{busy=false;release();}).catch(()=>{});}
  }
  async function load(op){
    await op.check();const resolved=await readResolvedGalleryWrite({reference,source,writeStorage,guard:op.check,signal:op.signal});await op.check();
    const beforeMeta=await source.baselineMetadata();await op.check();
    const before={gallery:summary(selected.plan.baseline.sourceReceipt),saved:beforeMeta.supplement.saved,header:beforeMeta.supplement.source},after={gallery:resolved.plan.gallery,saved:selected.saved};
    if(beforeMeta.evidence.chatEvidence.digest!==selected.plan.evidenceDigest)fail('当前基线正文依据不符');
    return {resolved,before,after,proposal:createGalleryWriteProposal({prepared:selected,resolved})};
  }
  async function body(op){
    await op.check();const messages=projectStoryboardChatMessages(getContext().chat),evidence=await scanGalleryEvidenceSource(messages,currentSource.target.chatId,{guard:op.active});await op.check();
    if(evidence.digest!==selected.plan.evidenceDigest||!storyboardChatProjectionMatches(messages,getContext().chat))fail('正文或候选版本已变化，未恢复旧资料');return messages;
  }
  async function observed(expected,op){
    await op.check();const first=await op.receipt.inspect({signal:op.signal});await op.check();
    if(first.state!=='present'||!same(first.gallery,expected.gallery))return false;
    const companion=await op.supplement.read(expected.gallery.sha256,{signal:op.signal});await op.check();if(!equal(companion.saved,expected.saved))return false;
    // ST saves the whole metadata header. Reject remote edits to OTHER modules
    // too, even when their fields are outside this operation's three writes.
    if(expected.header&&['bytes','sha256'].some(key=>companion.source[key]!==expected.header[key]))return false;
    const evidence=await op.body.read(expected.gallery.sha256,{signal:op.signal});await op.check();if(evidence.chatEvidence.digest!==selected.plan.evidenceDigest)return false;
    const last=await op.supplement.read(expected.gallery.sha256,{signal:op.signal});await op.check();
    return equal(last.saved,expected.saved)&&last.source.sha256===companion.source.sha256&&last.source.bytes===companion.source.bytes;
  }
  async function files(loaded,op){return verifyPreparedGalleryFiles({source,resolutions:loaded.resolved.resolutions,headers,guard:op.check,fetchImpl:op.shared.fetchImpl,signal:op.signal,onProgress});}
  function unchangedBody(messages){current();if(!storyboardChatProjectionMatches(messages,getContext().chat))fail('保存前正文已变化');}
  async function materialize(loaded,op){const images=[];
    const result=await scanResolvedGalleryWrite({source,resolutions:loaded.resolved.resolutions,guard:op.check,signal:op.signal,visit:record=>images.push(record)});
    if(!same(result.gallery,loaded.after.gallery))fail('写回记录摘要不符');return {storyboardImages:images,...structuredClone(loaded.after.saved)};
  }
  function assignments(saved){const out=[];for(const key of fields){if(!Object.hasOwn(saved,key))continue;
    const descriptor=Object.getOwnPropertyDescriptor(store,key);if(descriptor&&(!Object.hasOwn(descriptor,'value')||!descriptor.writable)||!descriptor&&!Object.isExtensible(store))fail('聊天字段不可安全写入，未部分修改');out.push([key,saved[key]]);}return out;}
  async function journalCurrent(op){const active=await journal.loadHistoricalChatMutation(namespace,{isCurrent:op.active});await op.check();
    if(!same(active,row))fail('待核对记录已被另一页面更新，未重复写回');}
  async function verified(loaded,op){
    if(!local(loaded.after))return unknown(local(loaded.before)?'reload_required':'local_conflict');const messages=await body(op);
    if(!await observed(loaded.after,op))return unknown('readback_mismatch');const checked=await files(loaded,op);
    if(!await observed(loaded.after,op))return unknown('readback_mismatch');await op.check();unchangedBody(messages);if(!local(loaded.after))fail('最终核对时资料已编辑');
    if(row){await journalCurrent(op);if(row.phase!=='verified'){row=await journal.updateHistoricalChatMutation(row,'verified',{isCurrent:op.active});await op.check();}}
    unchangedBody(messages);if(!local(loaded.after))fail('记录确认期间资料已编辑');intent=null;
    return {status:'saved',fileHash:loaded.proposal.fileHash,metadataVerified:true,durableJournal:Boolean(row),...checked,proof:'paged-chat-and-files-readback',canPrune:false};
  }
  async function invoke(loaded,op){
    current();hostPending=true;let promise;try{promise=Promise.resolve(saveHost.call(context));}catch(error){promise=Promise.reject(error);}
    const settled=promise.then(()=>{hostPending=false;release();return true;},()=>{hostPending=false;release();return true;});
    let timer;try{if(!await Promise.race([settled,new Promise(done=>timer=setTimeout(()=>done(false),Math.min(30000,hostTimeoutMs)))]))return unknown('host_pending');}finally{clearTimeout(timer);}
    return verified(loaded,op);
  }
  async function dispatch(loaded,op,{retry=false}={}){
    const expected=local(loaded.before)?loaded.before:retry&&local(loaded.after)?loaded.after:null;if(!expected)fail('当前资料已编辑，未覆盖');
    const messages=await body(op);if(!await observed(loaded.before,op))fail('服务器不在原基线，未重新提交');
    await files(loaded,op);const saved=await materialize(loaded,op);assignments(saved);await op.check();
    if(!local(expected))fail('恢复准备期间资料已编辑');unchangedBody(messages);
    if(!row){const created=await createHistoricalChatMutation(loaded.proposal);await op.check();
      row=await journal.prepareHistoricalChatMutation(created,{confirmed:true,isCurrent:op.active});await op.check();intent=loaded.proposal;}
    else await journalCurrent(op);
    if(row.phase==='verified')fail('已核对记录不会重新提交旧内容');
    row=await journal.updateHistoricalChatMutation(row,'submitted',{isCurrent:op.active});await op.check();intent=loaded.proposal;
    if(!await observed(loaded.before,op))fail('写前记录提交期间服务器资料已变化');await op.check();
    if(!local(expected))fail('最终写回前资料已编辑');unchangedBody(messages);const changes=assignments(saved);
    // No await between final source/body/value checks, scoped assignments and ST.
    current();for(const [key,value]of changes)store[key]=value;return invoke(loaded,op);
  }
  return Object.freeze({
    pending:()=>intent?structuredClone(intent):null,
    close(){closed=true;currentSource.close();abortActive?.();release();},
    save({confirmed=false,scope:requestedScope}={}){if(confirmed!==true||requestedScope!==scope)return Promise.reject(Error('请明确确认分页恢复至此原聊天'));
      return operation(async op=>{await op.check();if(intent||row||await journal.loadHistoricalChatMutation(namespace,{isCurrent:op.active}))fail('已有恢复待核对，未启动新写回');
        const loaded=await load(op);if(!local(loaded.before))fail('当前资料与已准备基线不符');
        if(same(loaded.before.gallery,loaded.after.gallery)&&equal(loaded.before.saved,loaded.after.saved)){const result=await verified(loaded,op);return result.status==='saved'?{...result,status:'unchanged'}:result;}
        return dispatch(loaded,op);
      });},
    recover(){return operation(async op=>{if(intent||row)fail('本会话已有待核对内容');await op.check();const pending=await journal.loadHistoricalChatMutation(namespace,{isCurrent:op.active});await op.check();if(!pending)return {status:'idle'};
      const checked=await inspectHistoricalChatMutation(pending),loaded=await load(op);await op.check();
      if(!same(checked.proposal,loaded.proposal))fail('待核对记录不属于此准确分页方案');row=checked;intent=loaded.proposal;await body(op);
      if(local(loaded.after))return verified(loaded,op);if(!local(loaded.before))return unknown('local_conflict');
      if(await observed(loaded.after,op))return unknown('reload_required');if(await observed(loaded.before,op))return unknown('confirmation_required');return unknown('server_conflict');
    });},
    verify(){return operation(async op=>{if(!intent&&!row)return {status:'idle'};return verified(await load(op),op);});},
    retry({confirmed=false}={}){if(confirmed!==true)return Promise.reject(Error('请明确确认重试此待核对分页恢复'));
      return operation(async op=>{if(!intent||!row)return {status:'idle'};await journalCurrent(op);const loaded=await load(op);if(!same(row.proposal,loaded.proposal))fail('待核对方案已变化');
        await body(op);if(await observed(loaded.after,op))return verified(loaded,op);if(row.phase==='verified')fail('已核对记录不会重放');return dispatch(loaded,op,{retry:true});
      });},
  });
}
