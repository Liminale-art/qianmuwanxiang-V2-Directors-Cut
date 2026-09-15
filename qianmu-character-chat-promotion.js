import {normalizeChatCharacterDraft,prepareChatCharacterPromotion} from './qianmu-character-chat-draft.js';
import {characterArchiveError,normalizeCharacterArchive} from './qianmu-character-archive.js';

const fail=message=>{throw characterArchiveError('promotion',message);};
const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),byte=>byte.toString(16).padStart(2,'0')).join('');

// Both attempts use the same opaque archive ID, even when the first commit's acknowledgement was lost.
// No name matching, implicit binding, draft deletion or host metadata write occurs here.
export async function promoteChatCharacterDraft(value,{owner,expectedRevision,confirmed,store,readDraft,isCurrent,guard}={}){
  let writeAttempted=false,archiveId='';
  try{
    if(typeof store?.createOnce!=='function'||typeof store?.load!=='function'||typeof readDraft!=='function'||typeof isCurrent!=='function'||typeof guard!=='function')fail('固定档案缺少保存、读回或当前身份保护');
    const captured=normalizeChatCharacterDraft(value,owner),intent=prepareChatCharacterPromotion(captured,{owner:captured.owner,expectedRevision,confirmed}),snapshot=JSON.stringify(captured);
    const check=()=>{
      if(isCurrent()!==true||JSON.stringify(normalizeChatCharacterDraft(readDraft(),captured.owner))!==snapshot)fail('当前聊天人物或账户已变化，未继续固定保存');
      return true;
    };
    check();await guard();check();
    archiveId='chatdraft_'+await digest(JSON.stringify([captured.owner.namespace,captured.owner.chatKey,captured.id]));
    await guard();check();writeAttempted=true;
    const result=await store.createOnce(captured.owner.namespace,{id:archiveId,document:intent.document},{isCurrent:check});
    await guard();check();
    if(!result?.head||result.head.id!==archiveId||result.head.namespace!==captured.owner.namespace||result.head.key!==JSON.stringify([captured.owner.namespace,archiveId])
      ||result.head.version!==1||typeof result.head.revision!=='string'||!/^[a-zA-Z0-9_-]{1,160}$/.test(result.head.revision)||typeof result.created!=='boolean')fail('固定档案的保存返回不一致，请核对原档案');
    const record=await store.load(captured.owner.namespace,archiveId);
    await guard();check();
    if(!record?.head||record.head.id!==archiveId||record.head.namespace!==captured.owner.namespace||record.head.key!==JSON.stringify([captured.owner.namespace,archiveId])
      ||record.head.revision!==result.head.revision||record.head.version!==1||JSON.stringify(normalizeCharacterArchive(record.document))!==JSON.stringify(intent.document))fail('固定档案的保存结果尚未读回确认，请保留原人物资料');
    return Object.freeze({status:'saved',archiveId,archiveRevision:record.head.revision,created:result.created,draftId:captured.id,draftRevision:captured.revision,automaticBinding:false});
  }catch(error){
    const cause=typeof error?.code==='string'&&error.code.startsWith('character_archive_')?error:characterArchiveError('promotion','固定档案未确认，请保留原人物资料后重试');
    // Once storage was invoked, failure can also mean a committed record with a lost receipt. Never blindly create a fresh ID.
    cause.promotionState=writeAttempted?'unconfirmed':'not_started';if(archiveId)cause.promotionArchiveId=archiveId;throw cause;
  }
}
