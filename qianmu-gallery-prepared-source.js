import {createGalleryRestoreSource} from './qianmu-gallery-restore-source.js';
import {createChatGalleryDigest} from './qianmu-chat-gallery-digest.js';
import {mergeGallerySupplement} from './qianmu-gallery-merge-supplement.js';
import {chatGalleryReceiptText} from './qianmu-chat-gallery-receipt.js';

const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),fail=message=>{throw Object.assign(Error(message),{code:'gallery_prepared_source',writeState:'not_started'});};
// Reconstruct the prepared order from its two exact immutable sources. A valid
// plan-file hash alone does not prove its rows, companion merge or image bytes.
// Callbacks are provisional; consumers must finish this scan before any writes.
export async function openPreparedGallerySource({reference,planStorage,archive,guard,signal}={}){
  if(typeof guard!=='function')fail('恢复方案缺少来源保护');let closed=false,busy=false,source,baseline,metadata;const rows=new Map();
  async function check(){if(closed||signal?.aborted||await guard()!==true||closed||signal?.aborted)fail('恢复方案已取消或来源变化');return true;}
  function close(){closed=true;source?.close();baseline?.close();rows.clear();metadata=null;}
  async function verify(){await check();const saved=await planStorage.read(reference);await check();
    if(!same(saved.plan,metadata.plan)||!same(saved.saved,metadata.saved)||await source.verify()!==true||await baseline.verify()!==true)fail('恢复方案或原资料已变化');await check();return true;}
  async function exclusive(work){await check();if(busy)fail('恢复方案正在读取');busy=true;try{return await work();}finally{busy=false;}}
  try{
    metadata=await planStorage.scan(reference,{visit:row=>{if(rows.has(row.recordId))fail('恢复方案记录重复');rows.set(row.recordId,row);}});await check();
    baseline=await createGalleryRestoreSource({selection:metadata.plan.baseline,archive,guard:check,signal});await check();
    source=await createGalleryRestoreSource({selection:metadata.plan.source,archive,guard:check,signal});await check();
    const before=await baseline.metadata(),incoming=await source.metadata(),plan=metadata.plan;
    if(!same(before.supplement.target,plan.target)||!same(incoming.supplement.target,plan.target)
      ||before.evidence.chatEvidence.digest!==plan.evidenceDigest||incoming.evidence.chatEvidence.digest!==plan.evidenceDigest)fail('恢复方案正文或准确聊天不符');
    const merged=await mergeGallerySupplement(before.supplement.saved,incoming.supplement.saved,{namespace:plan.scope.namespace,chatKey:plan.scope.chatKey});await check();
    if(merged.conflicts.length||chatGalleryReceiptText([{saved:merged.saved}]).text!==chatGalleryReceiptText([{saved:metadata.saved}]).text)fail('恢复方案关联资料与原合并结果不符');
    return Object.freeze({get metadata(){return structuredClone(metadata);},
      verify:()=>exclusive(verify),
      readSelected:index=>exclusive(async()=>{const item=await source.read(index);await check();return item;}),
      scan({visit=async()=>{},onProgress=()=>{}}={}){return exclusive(async()=>{
        if(typeof visit!=='function'||typeof onProgress!=='function')fail('恢复方案缺少记录接收器');const digest=createChatGalleryDigest(),known=new Map();let count=0,added=0,kept=0;
        const progress=origin=>async value=>{await onProgress({origin,...value});await check();};
        try{
          await baseline.scan({onProgress:progress('baseline'),visit:async item=>{
            await check();const row=rows.get(item.record.id);
            if(!row||row.index!==count||row.origin!=='baseline'||row.sourceIndex!==item.index||!same(row.reference,item.reference))fail('恢复方案当前基线顺序或记录不符');
            known.set(item.record.id,item.reference);digest.append(item.record);count++;
            await visit({...item,origin:'baseline',outputIndex:row.index,kept:false});await check();
          }});
          await source.scan({onProgress:progress('source'),visit:async item=>{
            await check();const row=rows.get(item.record.id),existing=known.get(item.record.id);let duplicate=false;
            if(existing){if(!same(existing,item.reference))fail('恢复方案混入了同编号不同记录');kept++;duplicate=true;}
            else{
              if(!row||row.index!==count||row.origin!=='source'||row.sourceIndex!==item.index||!same(row.reference,item.reference))fail('恢复方案历史新增顺序或记录不符');
              known.set(item.record.id,item.reference);digest.append(item.record);added++;count++;
            }
            await visit({...item,origin:'source',outputIndex:row.index,kept:duplicate});await check();
          }});
          if(count!==rows.size||added!==plan.added||kept!==plan.kept||!same(digest.finish(),plan.gallery))fail('恢复方案没有完整覆盖原合并结果');
          await verify();return {total:count,added,kept,proof:'prepared-records-readback-only',restoreReady:false,canPrune:false};
        }finally{digest.close();}
      });},close,
    });
  }catch(error){close();throw error;}
}
