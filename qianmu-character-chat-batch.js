import {characterArchiveError} from './qianmu-character-archive.js';
import {normalizeChatCharacterDraft,normalizeChatCharacterDraftOwner,normalizeChatCharacterDraftSource,
  createChatCharacterDraft,observeChatCharacterDraft,resolveChatCharacterDraftSubject,projectChatCharacterDraftVisual} from './qianmu-character-chat-draft.js';

export const CHAT_CHARACTER_COLLECTION_SCHEMA='qianmu.character.chat-collection.v1';
export const CHAT_CHARACTER_COLLECTION_LIMITS=Object.freeze({items:256,bytes:1024*1024,batch:256});
const object=value=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const fail=message=>{throw characterArchiveError('chat_collection',message);};
const nameKey=value=>String(value||'').normalize('NFKC').trim().toLocaleLowerCase('en-US');
const names=doc=>new Set([doc.name,...doc.aliases].map(nameKey).filter(Boolean));
const originKey=value=>JSON.stringify([value.chatKey,value.messageKey,value.revisionId,value.characterId]);
const hostKey=value=>value?JSON.stringify([value.category,value.subjectKey]):'';
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const identity=value=>JSON.stringify(projectChatCharacterDraftVisual(value));

export function emptyChatCharacterCollection(owner){
  return {schema:CHAT_CHARACTER_COLLECTION_SCHEMA,owner:normalizeChatCharacterDraftOwner(owner),revision:0,items:[]};
}
export function normalizeChatCharacterCollection(value,owner){
  owner=normalizeChatCharacterDraftOwner(owner);
  if(!object(value)||value.invalid||value.schema!==CHAT_CHARACTER_COLLECTION_SCHEMA||!Number.isSafeInteger(value.revision)||value.revision<0
    ||!Array.isArray(value.items)||value.items.length>CHAT_CHARACTER_COLLECTION_LIMITS.items)fail('聊天人物列表格式无效或超过 256 项，请保全原数据');
  if(!equal(normalizeChatCharacterDraftOwner(value.owner),owner))fail('聊天人物列表属于另一账户或聊天');
  const ids=new Set(),origins=new Set(),hosts=new Set(),items=Array.from(value.items,row=>{
    const draft=normalizeChatCharacterDraft(row,owner),origin=originKey(draft.source);
    const host=hostKey(draft.hostSubject);
    if(ids.has(draft.id)||origins.has(origin)||host&&hosts.has(host))fail('聊天人物身份或初次识别来源重复，不会自动合并');
    ids.add(draft.id);origins.add(origin);if(host)hosts.add(host);return draft;
  });
  const result={schema:CHAT_CHARACTER_COLLECTION_SCHEMA,owner,revision:value.revision,items};
  if(new TextEncoder().encode(JSON.stringify(result)).byteLength>CHAT_CHARACTER_COLLECTION_LIMITS.bytes)fail('聊天人物资料超过 1 MB，请先固定保存并整理；未截断或清理');
  return result;
}
// Works on the extension's existing per-chat object, never on global settings or the full ST chat.
// Only absence means legacy empty. Invalid/present data must not be overwritten with an empty list.
export function readChatCharacterCollection(chatStore,owner){
  if(!object(chatStore))fail('当前聊天资料尚未就绪');
  return Object.hasOwn(chatStore,'characterDrafts')?normalizeChatCharacterCollection(chatStore.characterDrafts,owner):emptyChatCharacterCollection(owner);
}
function assertReplacement(before,after){
  if(equal(before,after))return;
  const states={detected:['detected','chat_bound','rejected'],chat_bound:['chat_bound','rejected'],rejected:['rejected','detected']};
  if(after.revision!==before.revision+1||!equal(before.source,after.source)||!equal(before.hostSubject,after.hostSubject)
    ||before.userEditedFields.some(field=>!after.userEditedFields.includes(field))||!states[before.status].includes(after.status))fail('人物版本、编辑选择或初次身份已变化，未覆盖');
}
export function prepareChatCharacterMetadataWrite(chatStore,next,{owner,expectedRevision}={}){
  const before=readChatCharacterCollection(chatStore,owner),after=normalizeChatCharacterCollection(next,owner);
  if(before.revision!==expectedRevision)fail('聊天人物列表已变化，请按最新版本重试');
  if(equal(before,after))return {changed:false,chatStore,collection:after};
  if(before.revision===Number.MAX_SAFE_INTEGER||after.revision!==before.revision+1)fail('聊天人物保存版本不连续');
  const old=new Map(before.items.map(row=>[row.id,row]));
  for(const row of after.items){
    if(old.has(row.id)){assertReplacement(old.get(row.id),row);old.delete(row.id);}
    else if(row.revision!==1||row.status!=='detected')fail('新识别不能冒充已确认或历史人物');
  }
  if(old.size)fail('自动保存不能删除既有人物或拒绝记录，请使用明确的清理流程');
  // A copy/intent only; no assignment to live metadata and no claim that saveMetadata() committed it.
  return {changed:true,chatStore:{...chatStore,characterDrafts:after},collection:after};
}
export function replaceChatCharacterDraft(value,replacement,{owner,expectedRevision}={}){
  const collection=normalizeChatCharacterCollection(value,owner),draft=normalizeChatCharacterDraft(replacement,owner);
  if(collection.revision!==expectedRevision)fail('聊天人物列表已变化，请按最新版本重试');
  const index=collection.items.findIndex(row=>row.id===draft.id),before=collection.items[index];
  if(!before)fail('原临时人物不存在，不会借用同名资料');
  if(equal(before,draft))return collection;
  assertReplacement(before,draft);
  if(collection.revision===Number.MAX_SAFE_INTEGER)fail('聊天人物列表版本已到上限');
  collection.items[index]=draft;
  return normalizeChatCharacterCollection({...collection,revision:collection.revision+1},owner);
}

// This is the post-casting input from all shots of ONE body revision, not another model call.
// No ID/name inferred here can grant archive, host, reference-image or generation authority.
export function prepareChatCharacterBatch(value,{source,characters,hostLinks={},hostSubjects=[]},{owner,expectedRevision,createId=()=>globalThis.crypto.randomUUID()}={}){
  const collection=normalizeChatCharacterCollection(value,owner);
  if(collection.revision!==expectedRevision)fail('聊天人物列表已变化，请重新整理本次结果');
  const base=normalizeChatCharacterDraftSource({...source,characterId:'batch'},owner);
  if(!Array.isArray(characters)||characters.length>CHAT_CHARACTER_COLLECTION_LIMITS.batch||!object(hostLinks)||typeof createId!=='function')fail('本次人物批次格式无效或过大');
  const byId=new Map(collection.items.map(row=>[row.subjectId,row])),byOrigin=new Map(collection.items.map(row=>[originKey(row.source),row]));
  const byHost=new Map(collection.items.filter(row=>row.hostSubject).map(row=>[hostKey(row.hostSubject),row]));
  const groups=new Map(),warnings=[],assignments=[],items=[...collection.items];let changed=false;
  for(const character of characters){
    if(!object(character)||typeof character.id!=='string'||!character.id||character.id.length>160)fail('本次人物编号无效');
    if(character.visible===false)continue;
    if(character.archiveSnapshot!=null||character.id.startsWith('archive:'))continue;
    projectChatCharacterDraftVisual(character);
    const group=groups.get(character.id)||[];group.push(character);groups.set(character.id,group);
  }
  const targets=new Map(),links=new Map(),counts=new Map();
  for(const characterId of groups.keys()){
    const link=resolveChatCharacterDraftSubject(Object.hasOwn(hostLinks,characterId)?hostLinks[characterId]:null,hostSubjects);
    const target=characterId.startsWith('chat-character:')?byId.get(characterId):byHost.get(hostKey(link))||byOrigin.get(originKey({...base,characterId}));
    links.set(characterId,link);targets.set(characterId,target);
    const key=target?.subjectId||(link?`host:${hostKey(link)}`:'');
    if(key)counts.set(key,(counts.get(key)||0)+1);
  }
  for(const [characterId,group] of groups){
    const character=group[0],currentSource={...base,characterId},link=links.get(characterId);
    const warn=reason=>warnings.push({characterId,reason});
    if(group.some(row=>identity(row)!==identity(character))){warn('inconsistent_identity');continue;}
    const previous=targets.get(characterId);let next;
    if((counts.get(previous?.subjectId||(link?`host:${hostKey(link)}`:''))||0)>1){warn('duplicate_identity');continue;}
    if(previous&&link&&hostKey(previous.hostSubject)!==hostKey(link)){warn('identity_conflict');continue;}
    if(characterId.startsWith('chat-character:')||previous&&link){
      if(!previous){warn('unknown_identity');continue;}
      if(previous.status==='rejected'){warn('rejected');continue;}
      // A caller-confirmed host key may resolve a local ID; a matching display name may not.
      next=observeChatCharacterDraft(previous,{source:{...currentSource,characterId:previous.subjectId},character:{...character,id:previous.subjectId}},{owner,expectedRevision:previous.revision});
    }else{
      if(previous){
        if(previous.status==='rejected'){warn('rejected');continue;}
        // A rerun may assign C1 to somebody else; origin alone does not justify lending an edited/renamed identity.
        if(!names(previous.document).has(nameKey(character.name))){warn('identity_conflict');continue;}
        next=previous;
      }else{
        // Names can STOP automatic duplication, never establish an identity or borrow another draft.
        const conflicts=collection.items.filter(row=>names(row.document).has(nameKey(character.name)));
        if(conflicts.length){warn(conflicts.some(row=>row.status==='rejected')?'rejected_name_candidate':'name_needs_confirmation');continue;}
        next=createChatCharacterDraft({owner,source:currentSource,character,id:createId(),hostSubject:link,hostSubjects});
      }
    }
    if(previous){
      if(!equal(previous,next)){items[items.findIndex(row=>row.id===previous.id)]=next;changed=true;}
    }else{items.push(next);changed=true;}
    assignments.push({characterId,subjectId:next.subjectId,draftRevision:next.revision});
  }
  if(changed&&collection.revision===Number.MAX_SAFE_INTEGER)fail('聊天人物列表版本已到上限');
  const next=normalizeChatCharacterCollection({...collection,revision:collection.revision+(changed?1:0),items},owner);
  return {collection:next,changed,assignments,warnings};
}

export function summarizeChatCharacterCollection(value,owner){
  const collection=normalizeChatCharacterCollection(value,owner),counts={detected:0,chat_bound:0,rejected:0};
  for(const row of collection.items)counts[row.status]++;
  return {count:collection.items.length,bytes:new TextEncoder().encode(JSON.stringify(collection)).byteLength,revision:collection.revision,...counts,mediaIncluded:false};
}
