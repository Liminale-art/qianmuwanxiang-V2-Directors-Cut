import {validateCharacterLibraryBackup,characterLibraryBackupDigest,CHARACTER_LIBRARY_BACKUP_SCHEMA} from './qianmu-character-library-backup.js';

// Portable old-source records, not current bindings or replayable approvals.
// Keep the complete original library, including resolved and explicit-empty bindings.
export const CHARACTER_SOURCES_SCHEMA='qianmu.character.sources.v1';
export const CHARACTER_SOURCES_BYTES=64*1048576;
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const fail=message=>{throw Object.assign(new Error(message),{code:'character_sources',submissionState:'not_submitted'});};
export const emptyCharacterSources=namespace=>({schema:CHARACTER_SOURCES_SCHEMA,namespace,credentialsIncluded:false,restoreAuthorized:false,sources:[]});
export function characterSourceLibrary(namespace,archives,bindings){
  const value={schema:CHARACTER_LIBRARY_BACKUP_SCHEMA,namespace,credentialsIncluded:false,archives,bindings,
    usage:{count:archives.length,bytes:archives.reduce((sum,row)=>sum+row.head.bytes,0),bindings:bindings.length}};
  validateCharacterLibraryBackup(value);return value;
}
export function validateCharacterSources(value,namespace=value?.namespace){
  if(!exact(value,['schema','namespace','credentialsIncluded','restoreAuthorized','sources'])||value.schema!==CHARACTER_SOURCES_SCHEMA||value.namespace!==namespace
    ||typeof namespace!=='string'||!/^st-user:.+/.test(namespace)||namespace.length>512||/[\u0000-\u001f\u007f]/.test(namespace)
    ||value.credentialsIncluded!==false||value.restoreAuthorized!==false||!Array.isArray(value.sources)||value.sources.length>256)fail('角色旧源清单格式、范围或数量不符');
  const seen=new Set();let bytes=0;
  for(const row of value.sources){
    if(!exact(row,['digest','library'])||typeof row.digest!=='string'||!/^[a-f0-9]{64}$/.test(row.digest)||seen.has(row.digest)||row.library?.namespace!==namespace)fail('角色旧源编号重复或账户不符');
    validateCharacterLibraryBackup(row.library);seen.add(row.digest);bytes+=new TextEncoder().encode(JSON.stringify(row)).byteLength;
    if(bytes>CHARACTER_SOURCES_BYTES)fail('角色旧源超过64MiB，请保留原环境；未裁剪来源');
  }
  if(new TextEncoder().encode(JSON.stringify(value)).byteLength>CHARACTER_SOURCES_BYTES)fail('角色旧源超过64MiB，未输出缺件包');
  return {count:value.sources.length,bytes};
}
export async function inspectCharacterSources(value,namespace=value?.namespace,{guard=async()=>{}}={}){
  const summary=validateCharacterSources(value,namespace);
  for(const row of value.sources){await guard();if(await characterLibraryBackupDigest(row.library)!==row.digest)fail('角色旧源与完整原文摘要不符');}
  await guard();return summary;
}
export async function captureCharacterSources(store,namespace,options={}){
  const value=typeof store.backupSources==='function'?await store.backupSources(namespace,options):emptyCharacterSources(namespace);
  await inspectCharacterSources(value,namespace,{guard:options.guard});return value;
}
