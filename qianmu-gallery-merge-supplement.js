import {projectChatGallerySupplement} from './qianmu-chat-gallery-supplement.js';
import {chatGalleryReceiptText} from './qianmu-chat-gallery-receipt.js';
import {chatCharacterCollectionReceiptText} from './qianmu-chat-character-receipt.js';
import {captureGallerySupplement} from './qianmu-gallery-archive-supplement.js';
import {mergeGalleryContinuity} from './qianmu-gallery-continuity.js?v=1.59.342';

const same=(a,b)=>chatGalleryReceiptText([{value:a}]).text===chatGalleryReceiptText([{value:b}]).text;
const fail=message=>{throw Object.assign(Error(message),{code:'gallery_restore_merge',writeState:'not_started'});};
// Chat-owned fields only. Unknown fields stay intact; names or higher imported
// revision counters never authorize replacing an existing same-ID object.
export async function mergeGallerySupplement(before,incoming,owner){
  const local=captureGallerySupplement(before),source=captureGallerySupplement(incoming);
  await projectChatGallerySupplement(local,owner);await projectChatGallerySupplement(source,owner);
  const saved=structuredClone(local),conflicts=[],added={storyboardCollections:0,characterDrafts:0};
  function merge(a,b,field,max){
    const result=new Map();
    for(const [rows,imported] of [[a,false],[b,true]]){
      if(!Array.isArray(rows)||rows.length>max)fail('恢复关联条目超出完整支持范围，未截断');const ids=new Set();
      for(const row of rows){
        if(!row||typeof row!=='object'||Array.isArray(row)||typeof row.id!=='string'||!row.id.trim()||row.id.length>240||ids.has(row.id))fail('恢复关联条目编号缺失或重复');ids.add(row.id);
        if(!result.has(row.id)){result.set(row.id,row);if(imported)added[field]++;}
        else if(!same(result.get(row.id),row))conflicts.push({field,id:row.id,reason:'different-record'});
      }
    }
    if(result.size>max)fail('恢复关联条目合并后超限，未丢弃原记录');return [...result.values()];
  }
  if(Object.hasOwn(source,'storyboardCollections'))saved.storyboardCollections=merge(local.storyboardCollections||[],source.storyboardCollections,'storyboardCollections',10000);
  if(Object.hasOwn(source,'characterDrafts')){
    const beforeDraft=local.characterDrafts,next=source.characterDrafts;
    if(!beforeDraft){saved.characterDrafts=next;added.characterDrafts=next.items.length;}
    else{
      const result={...beforeDraft,items:merge(beforeDraft.items,next.items,'characterDrafts',256)};let changed=false;
      for(const key of Object.keys(next)){
        if(['items','revision'].includes(key))continue;
        if(!Object.hasOwn(beforeDraft,key)){Object.defineProperty(result,key,{value:next[key],writable:true,enumerable:true,configurable:true});changed=true;}
        else if(!same(beforeDraft[key],next[key]))conflicts.push({field:'characterDrafts',id:null,key,reason:'different-collection-field'});
      }
      if(added.characterDrafts||changed){if(beforeDraft.revision===Number.MAX_SAFE_INTEGER)fail('当前人物列表版本已到上限');result.revision++;}
      try{chatCharacterCollectionReceiptText(result,owner);}catch{conflicts.push({field:'characterDrafts',id:null,reason:'incompatible-identities-or-size'});}
      saved.characterDrafts=result;
    }
  }
  const continuity=mergeGalleryContinuity(local,source,same);Object.assign(saved,continuity.saved);Object.assign(added,continuity.added);conflicts.push(...continuity.conflicts);
  if(!conflicts.length)await projectChatGallerySupplement(saved,owner);
  return {saved:conflicts.length?null:saved,conflicts,added:conflicts.length?null:added};
}
