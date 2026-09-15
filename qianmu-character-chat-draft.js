import {characterArchiveError,newCharacterArchive,normalizeCharacterArchive} from './qianmu-character-archive.js';
import {canonicalUserSubjectKey} from './qianmu-user-identity.js';
import {normalizeNarrativeContext,isMainlineNarrativeFact} from './qianmu-narrative-context.js';

// Pure draft rules only. Persistence, host identity selection and global-library writes belong to the caller.
export const CHAT_CHARACTER_DRAFT_SCHEMA='qianmu.character.chat-draft.v1';
const fields=['name','aliases','appearance','negative','ageStatus','sensitiveAppearance'];
const object=value=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const clean=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&value===value.trim()&&!/[\u0000-\u001f\u007f]/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const fail=message=>{throw characterArchiveError('chat_draft',message);};
const clone=value=>structuredClone(value);
const freeze=value=>{if(object(value)||Array.isArray(value)){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
function owner(value){
  if(!object(value)||!clean(value.namespace,512)||!value.namespace.startsWith('st-user:')||value.namespace.length===8||!clean(value.chatKey,512))fail('请先确认当前聊天和 ST 账户');
  return {namespace:value.namespace,chatKey:value.chatKey};
}
function origin(value,scope){
  // The caller must resolve this existing body revision; these labels are not proof of truth or authority.
  if(!object(value)||value.invalid||value.kind!=='body'||value.chatKey!==scope.chatKey||!clean(value.messageKey,80)||!clean(value.revisionId,80)||!clean(value.characterId,160))fail('临时人物缺少本次正文的准确来源');
  const result={kind:'body',chatKey:value.chatKey,messageKey:value.messageKey,revisionId:value.revisionId,characterId:value.characterId};
  if(Object.hasOwn(value,'narrativeContext')){
    const context=normalizeNarrativeContext(value.narrativeContext);
    if(context.chatKey!==scope.chatKey||!isMainlineNarrativeFact(context))fail('预测或平行画面不能自动成为主线人物资料');
    result.narrativeContext=context;
  }
  return result;
}
function subject(value){
  if(value===null)return null;
  if(!object(value)||!['char','user'].includes(value.category)||!clean(value.subjectKey,1024))fail('人物宿主身份无效');
  if(value.category==='char'&&(!value.subjectKey.startsWith('char:')||value.subjectKey.length===5))fail('角色身份须使用当前角色标识');
  const key=value.category==='user'?canonicalUserSubjectKey(value.subjectKey):value.subjectKey;
  if(!key)fail('不能用显示名猜测 USER 身份');
  return {category:value.category,subjectKey:key};
}
function visual(value){
  if(!object(value)||value.visible===false||!clean(value.id,160)||!clean(value.name,80)||!Array.isArray(value.identity)||value.identity.length>30
    ||value.identity.some(row=>typeof row!=='string'||row.length>500||/[\u0000\u0008\u000b\u000c]/.test(row)))fail('本次人物描述无效，请保留原提取结果');
  if(value.archiveSnapshot!=null)fail('已绑定角色档案的人物不应另建临时草稿');
  const appearance=value.identity.map(row=>row.trim()).filter(Boolean).join('\n');
  if(appearance.length>12000)fail('本次人物描述过长，不会截断保存');
  return {name:value.name,appearance};
}
function bodyDocument(value){
  const document=normalizeCharacterArchive(value);
  if(Object.hasOwn(document,'comfy'))fail('临时人物不能携带角色专属工作流绑定');
  return document;
}
export function normalizeChatCharacterDraft(value,expectedOwner){
  if(!object(value)||value.invalid||value.schema!==CHAT_CHARACTER_DRAFT_SCHEMA||!uuid(value.id)||value.subjectId!==`chat-character:${value.id}`
    ||!Number.isSafeInteger(value.revision)||value.revision<1||!['detected','chat_bound','rejected'].includes(value.status))fail('临时人物格式或版本无效');
  const scope=owner(value.owner),expected=owner(expectedOwner);
  if(scope.namespace!==expected.namespace||scope.chatKey!==expected.chatKey)fail('临时人物属于另一账户或聊天');
  const target=subject(value.hostSubject),document=bodyDocument(value.document);
  if(document.category!==(target?.category||'other'))fail('临时人物分类与宿主身份不一致');
  if(!Array.isArray(value.userEditedFields)||value.userEditedFields.length>fields.length||value.userEditedFields.some(field=>!fields.includes(field))
    ||new Set(value.userEditedFields).size!==value.userEditedFields.length)fail('临时人物编辑标记无效');
  return {schema:CHAT_CHARACTER_DRAFT_SCHEMA,id:value.id,subjectId:value.subjectId,owner:scope,revision:value.revision,status:value.status,
    hostSubject:target,source:origin(value.source,scope),lastObserved:origin(value.lastObserved,scope),document,userEditedFields:[...value.userEditedFields].sort()};
}
export function createChatCharacterDraft({owner:scope,source,character,hostSubject=null,hostSubjects=[],id=globalThis.crypto?.randomUUID()}={}){
  scope=owner(scope);source=origin(source,scope);const description=visual(character),target=subject(hostSubject);
  if(source.characterId!==character.id)fail('本次人物编号与正文来源不一致');
  // This list must come from the host, never from a model response. Matching is by a selected key, not a name.
  if(target&&(!Array.isArray(hostSubjects)||hostSubjects.length>33||!hostSubjects.some(row=>{
    try{const known=subject(row);return known?.category===target.category&&known.subjectKey===target.subjectKey;}catch(_){return false;}
  })))fail('当前聊天未确认此 CHAR 或 USER 身份');
  const document=newCharacterArchive(target?.category||'other');document.name=description.name;document.imagegen.appearance=description.appearance;
  return freeze(normalizeChatCharacterDraft({schema:CHAT_CHARACTER_DRAFT_SCHEMA,id,subjectId:`chat-character:${id}`,owner:scope,revision:1,
    status:'detected',hostSubject:target,source,lastObserved:source,document,userEditedFields:[]},scope));
}
function editable(value,options){
  const draft=normalizeChatCharacterDraft(value,options?.owner);
  if(draft.revision!==options?.expectedRevision)fail('临时人物已被修改，请按最新版本重试');
  return draft;
}
function changed(draft,patch){
  if(draft.revision===Number.MAX_SAFE_INTEGER)fail('临时人物版本已到上限，请先保全资料');
  return freeze(normalizeChatCharacterDraft({...draft,...patch,revision:draft.revision+1},draft.owner));
}
export function editChatCharacterDraft(value,patch,options){
  const draft=editable(value,options);
  if(draft.status==='rejected')fail('请先恢复被拒绝的人物再编辑');
  if(!object(patch)||!Object.keys(patch).length||Object.keys(patch).some(field=>!fields.includes(field)))fail('只可编辑人物资料，不能改写身份或来源');
  const document=clone(draft.document);
  for(const [field,data] of Object.entries(patch)){
    if(field==='ageStatus'&&!['unknown','adult','minor'].includes(data))fail('年龄状态无效');
    if(['name','aliases','ageStatus'].includes(field))document[field]=data;else document.imagegen[field]=data;
  }
  return changed(draft,{document:bodyDocument(document),userEditedFields:[...new Set([...draft.userEditedFields,...Object.keys(patch)])]});
}
export function setChatCharacterDraftStatus(value,action,options){
  const draft=editable(value,options),status={confirm:'chat_bound',reject:'rejected',restore:'detected'}[action];
  if(!status||action==='confirm'&&draft.status==='rejected'||action==='restore'&&draft.status!=='rejected')fail('临时人物状态操作无效');
  return status===draft.status?freeze(draft):changed(draft,{status});
}
// No display-name, alias or recycled C1 matching: subsequent model observations must use this draft's supplied stable ID.
export function observeChatCharacterDraft(value,{source,character},options){
  const draft=editable(value,options),nextSource=origin(source,draft.owner),description=visual(character);
  if(character.id!==draft.subjectId||nextSource.characterId!==draft.subjectId)fail('不能用本次镜头编号或同名人物更新既有草稿');
  if(draft.status!=='detected')return freeze(draft); // Confirmed and rejected choices are not revised by the model.
  const document=clone(draft.document);
  if(!draft.userEditedFields.includes('name'))document.name=description.name;
  if(!draft.userEditedFields.includes('appearance'))document.imagegen.appearance=description.appearance;
  if(JSON.stringify(document)===JSON.stringify(draft.document)&&JSON.stringify(nextSource)===JSON.stringify(draft.lastObserved))return freeze(draft);
  return changed(draft,{document,lastObserved:nextSource});
}
// Relevant drafts only; owner labels, file locations, negatives and sensitive fields never enter the extraction catalogue.
export function chatCharacterDraftInput(values,scope){
  if(!Array.isArray(values)||values.length>64)fail('本次相关临时人物超过 64 项');
  scope=owner(scope);const ids=new Set(),rows=[];
  for(const value of values){
    const draft=normalizeChatCharacterDraft(value,scope);
    if(ids.has(draft.subjectId))fail('本次临时人物编号重复');ids.add(draft.subjectId);
    if(draft.status==='rejected')continue;
    rows.push({subject_id:draft.subjectId,draft_revision:draft.revision,name:draft.document.name,aliases:[...draft.document.aliases],
      base_appearance:draft.document.imagegen.appearance,provisional:draft.status==='detected'});
  }
  if(new TextEncoder().encode(JSON.stringify(rows)).byteLength>64*1024)fail('本次临时人物描述超过 64 KB，请缩小取景范围');
  return rows;
}
// An explicit create-only intent, NOT a write receipt. The future save coordinator must persist before changing draft status.
export function prepareChatCharacterPromotion(value,options){
  const draft=editable(value,options);
  if(options?.confirmed!==true||draft.status==='rejected')fail('请明确选择要固定保存的人物');
  return freeze({draftId:draft.id,draftRevision:draft.revision,owner:clone(draft.owner),document:clone(draft.document),
    createOnly:true,automaticBinding:false,hostSubject:clone(draft.hostSubject)});
}
