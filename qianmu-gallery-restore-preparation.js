import {mergeGallerySupplement} from './qianmu-gallery-merge-supplement.js';
import {createChatGalleryDigest} from './qianmu-chat-gallery-digest.js';
import {GALLERY_RESTORE_PLAN_LIMITS as LIMIT} from './qianmu-gallery-restore-plan.js';

const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=message=>{throw Object.assign(Error(message),{code:'gallery_restore_preparation',writeState:'not_started'});};
// Streaming preparation only: retain references, not a second full gallery.
// Source callbacks are provisional until their complete digest is verified.
export async function prepareGalleryRestore({source,baseline,planStorage,guard,verifyCurrent,signal,onProgress=()=>{}}={}){
  async function check(){if(signal?.aborted||await guard()!==true||signal?.aborted)fail('恢复准备已取消或来源变化');}
  if(typeof guard!=='function'||typeof verifyCurrent!=='function'||typeof onProgress!=='function')fail('恢复准备缺少完整来源保护');
  await check();const current=await baseline.metadata(),incoming=await source.metadata();await check();
  if(!same(current.selection.scope,incoming.selection.scope)||!same(current.supplement.target,incoming.supplement.target)
    ||current.evidence.chatEvidence.digest!==incoming.evidence.chatEvidence.digest)fail('请在原聊天及相同正文版本中准备恢复；未将资料混入其他聊天');
  const owner=current.selection.scope,merged=await mergeGallerySupplement(current.supplement.saved,incoming.supplement.saved,{namespace:owner.namespace,chatKey:owner.chatKey});await check();
  let added=0,kept=0,offset=0,conflicts=merged.conflicts.length;const examples=merged.conflicts.slice(0,20),known=new Map(),pages=[];let rows=[];
  const digest=createChatGalleryDigest();
  async function flush(){if(!rows.length)return;await check();pages.push(await planStorage.stagePage(rows,offset));offset+=rows.length;rows=[];await check();}
  async function append(item,origin){digest.append(item.record);rows.push({index:offset+rows.length,recordId:item.record.id,origin,sourceIndex:item.index,reference:item.reference});if(rows.length===LIMIT.rows)await flush();}
  async function verify(){await check();if(await source.verify()!==true||await baseline.verify()!==true||await verifyCurrent()!==true)fail('恢复准备的原资料或当前基线已变化');await check();return true;}
  try{
    const progress=phase=>async value=>{await onProgress({phase,...value});await check();};
    await baseline.scan({onProgress:progress('baseline'),visit:async item=>{
      await check();if(known.has(item.record.id))fail('当前基线编号重复');known.set(item.record.id,item.reference);await append(item,'baseline');
    }});
    await source.scan({onProgress:progress('source'),visit:async item=>{
      await check();const before=known.get(item.record.id);
      if(before){if(same(before,item.reference))kept++;else{conflicts++;if(examples.length<20)examples.push({field:'storyboardImages',id:item.record.id,reason:'different-record'});}}
      else{known.set(item.record.id,item.reference);added++;await append(item,'source');}
    }});
    await verify();
    if(conflicts)return {compatible:false,conflicts,examples,proof:'restore-conflicts-only',restoreReady:false,canPrune:false};
    const gallery=digest.finish();await flush();
    const result=await planStorage.publish({target:current.supplement.target,source:incoming.selection,baseline:current.selection,
      evidenceDigest:current.evidence.chatEvidence.digest,gallery,pages,added,kept},{saved:merged.saved,verify});await check();
    return {compatible:true,reference:result.reference,total:gallery.count,added,kept,companions:merged.added,conflicts:0,
      persistence:'st-account-file',proof:result.proof,restoreReady:false,canPrune:false};
  }finally{digest.close();}
}
