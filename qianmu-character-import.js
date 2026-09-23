import {characterBackupBindingKey as bindingKey} from './qianmu-character-library-backup.js';
import {sameCharacterSubject} from './qianmu-user-identity.js';
import {CHARACTER_IMPORT_SLOT,CHARACTER_RECONCILED_SCHEMA,characterNativeEqual as equal,characterNativeExact as exact,
  characterNativeFail as fail,emptyCharacterNativeIndex,validateCharacterNativeIndex,characterNativeUsage} from './qianmu-character-native-contract.js';

export const CHARACTER_IMPORT_SCHEMA='qianmu.character.legacy-source.v1';
export function validateCharacterImport(value,storage){
  if(!exact(value,['schema','namespace','digest','archives','bindings','usage'])||value.schema!==CHARACTER_IMPORT_SCHEMA
    ||value.namespace!==storage.namespace||typeof value.digest!=='string'||!/^[a-f0-9]{64}$/.test(value.digest))fail('original','旧角色库保全清单无效');
  validateCharacterNativeIndex({...emptyCharacterNativeIndex(storage.namespace),archives:value.archives,bindings:value.bindings,usage:value.usage},storage);
  return value;
}
export async function preserveCharacterImport(storage,value,options){
  const captured=structuredClone(value);validateCharacterImport(captured,storage);
  const saved=await storage.preserveImmutable(CHARACTER_IMPORT_SLOT,captured,options);
  if(!saved.exists||!equal(validateCharacterImport(saved.value,storage),captured))fail('original','旧角色库保全清单回读不一致');
  return {digest:captured.digest,source:saved.reference,pending:[]};
}
export async function readCharacterImport(storage,receipt,options){
  const saved=await storage.readImmutable(receipt.source,options),value=validateCharacterImport(saved.value,storage);
  if(!saved.exists||value.digest!==receipt.digest||!equal(saved.reference,receipt.source))fail('original','旧角色库保全凭据与原件不符');
  const keys=new Set([...value.archives.map(row=>`archive:${row.head.id}`),...value.bindings.map(row=>`binding:${bindingKey(row)}`)]);
  if(receipt.pending.some(key=>!keys.has(key)))fail('original','旧资料核对项缺少对应原件');
  return value;
}
const archiveKey=id=>`archive:${id}`,targetKey=row=>`binding:${bindingKey(row)}`;
function samePosition(a,b){return sameCharacterSubject(a,b)&&a.scope===b.scope&&a.chatKey===b.chatKey;}
function retiredBinding(index,row){return index.retired.bindings.some(key=>{const [category,subjectKey,scope,chatKey]=JSON.parse(key);return samePosition({category,subjectKey,scope,chatKey},row);});}

// No chronology/ancestry heuristic. Automatic acceptance is limited to genuinely
// absent identities/targets. Different contents remain visible review items;
// tombstones always win automatically, including equivalent USER address forms.
export function planCharacterImport(index,source,{reviewKeys=null,decisions={}}={}){
  source=structuredClone(source);
  const next=structuredClone(index),pending=[],conflicts=[],known=new Set(reviewKeys||[]),chosen=new Set();
  const archives=new Map(next.archives.map(row=>[row.head.id,row])),bindings=new Map(next.bindings.map(row=>[bindingKey(row),row]));
  const archivePending=new Set();
  function decision(key,details){
    const choice=Object.hasOwn(decisions,key)?decisions[key]:'';
    if(choice&&!['current','source'].includes(choice))fail('choice_stale','旧资料核对选择无效');
    chosen.add(key);conflicts.push({key,...details,choice});if(!choice)pending.push(key);return choice;
  }
  for(const row of source.archives){
    const id=row.head.id,key=archiveKey(id),current=archives.get(id);
    if(reviewKeys&&!known.has(key))continue;
    const deleted=next.retired.archives.includes(id);
    if(!reviewKeys&&deleted)continue;
    if(!reviewKeys&&(!current||equal(current,row))){if(!current)archives.set(id,row);continue;}
    const choice=decision(key,{kind:'archive',id,localName:current?.head.name||'已删除',sourceName:row.head.name,
      localVersion:current?.head.version||0,sourceVersion:row.head.version,deleted,categoryConflict:Boolean(current&&current.head.category!==row.head.category)});
    if(choice==='source'){
      if(deleted||current&&current.head.category!==row.head.category)fail('conflict','已删除或分类不同的旧档案不能直接覆盖，请保留当前并另行导入为新档案');
      archives.set(id,row);
    }else if(!choice)archivePending.add(id);
  }
  for(const row of source.bindings){
    const key=targetKey(row),slot=bindingKey(row),current=bindings.get(slot);
    if(reviewKeys&&!known.has(key))continue;
    const deleted=retiredBinding(next,row)||Boolean(row.archiveId&&next.retired.archives.includes(row.archiveId));
    const target=archives.get(row.archiveId),missing=Boolean(row.archiveId&&(!target||target.head.category!==row.category));
    const alias=Boolean(row.category==='user'&&[...bindings.values(),...source.bindings].some(item=>sameCharacterSubject(item,row)&&item.subjectKey!==row.subjectKey));
    const blocked=archivePending.has(row.archiveId)||missing||alias;
    if(!reviewKeys&&deleted)continue;
    if(!reviewKeys&&current&&current.archiveId===row.archiveId)continue;
    if(!reviewKeys&&!current&&!blocked){bindings.set(slot,row);continue;}
    const choice=decision(key,{kind:'binding',category:row.category,subjectKey:row.subjectKey,scope:row.scope,chatKey:row.chatKey,
      localArchiveId:current?.archiveId??null,sourceArchiveId:row.archiveId,deleted,blocked,alias,missing});
    if(choice==='source'){
      if(deleted||blocked)fail('conflict','旧绑定涉及删除、未核对档案或USER地址差异，请先保留当前并核对身份');
      bindings.set(slot,row);
    }
  }
  if(Object.keys(decisions).some(key=>!chosen.has(key)))fail('choice_stale','旧资料核对项已变化，请重新打开');
  next.archives=[...archives.values()];next.bindings=[...bindings.values()];
  next.usage={count:next.archives.length,bytes:characterNativeUsage(next.archives),bindings:next.bindings.length};
  return {next,pending,conflicts,ready:pending.length===0};
}
export function attachCharacterImport(index,receipt,pending){
  if((index.imports||[]).some(row=>row.digest===receipt.digest))fail('conflict','旧资料来源已经登记，请重新核对');
  index.schema=CHARACTER_RECONCILED_SCHEMA;index.imports=[...(index.imports||[]),{...structuredClone(receipt),pending:[...pending]}];
  return index;
}
