import {stAccountImmutableReference} from './qianmu-st-account-storage.js';
import {COMFY_POOL_LIMITS} from './qianmu-comfy-pool-store.js';
import {COMFY_POOL_BACKUP_SCHEMA,validateComfyPoolBackup,validateComfyPoolMetadata,validateComfyPoolVersion} from './qianmu-comfy-pool-backup.js';
import {comfyNativeBytes as bytes,comfyNativeSame as same,comfyNativeAccount as account} from './qianmu-comfy-native-contract.js';

export const COMFY_POOL_NATIVE_SLOT='comfy-pool-library',COMFY_POOL_ORIGINAL_SLOT='comfy-pool-version';
export const COMFY_POOL_NATIVE_SCHEMA='qianmu.comfy.native-pool-library.v1';
export const COMFY_POOL_ORIGINAL_BYTES=256*1024+4096;
export const comfyPoolNativeFail=message=>{throw Object.assign(Error(message),{code:'comfy_pool_native',submissionState:'not_submitted'});};
const fail=comfyPoolNativeFail,exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(key=>Object.hasOwn(v,key));
const canonical=v=>JSON.stringify(v,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
export const comfyPoolNativePacket=(namespace,pools)=>({schema:COMFY_POOL_BACKUP_SCHEMA,namespace,credentialsIncluded:false,pools});
export const emptyComfyPoolNativeIndex=namespace=>({schema:COMFY_POOL_NATIVE_SCHEMA,namespace,revision:0,pools:[],retired:[],sources:[]});
export function validateComfyPoolNativeRow(row,scope){
  if(!exact(row,['head','versions']))fail('候选方案目录格式无效');validateComfyPoolMetadata(row.head);
  if(!Array.isArray(row.versions)||row.versions.length!==row.head.version)fail('候选方案完整历史缺失');
  const seen=new Set();let total=0,at=row.head.createdAt;
  for(let i=0;i<row.versions.length;i++){
    const version=row.versions[i];if(!exact(version,['meta','reference']))fail('候选方案原件目录无效');validateComfyPoolMetadata(version.meta);const meta=version.meta;
    if(meta.id!==row.head.id||meta.version!==i+1||seen.has(meta.revision)||meta.archived||meta.createdAt!==row.head.createdAt||meta.updatedAt<at)fail('候选方案历史顺序或归属不符');
    seen.add(meta.revision);at=meta.updatedAt;total+=meta.bytes;if(meta.totalBytes!==total)fail('候选方案历史计值不符');
    stAccountImmutableReference(version.reference,{scope,slot:COMFY_POOL_ORIGINAL_SLOT,maxBytes:COMFY_POOL_ORIGINAL_BYTES});
  }
  const tail=row.versions.at(-1).meta;
  if(row.head.updatedAt<tail.updatedAt||canonical(row.head)!==canonical({...tail,archived:row.head.archived,updatedAt:row.head.updatedAt}))fail('候选方案当前指针与历史不符');return row;
}
export function validateComfyPoolNativeIndex(value,namespace,scope,{maxBytes=COMFY_POOL_LIMITS.totalBytes}={}){
  account(namespace);if(!exact(value,['schema','namespace','revision','pools','retired','sources'])||value.schema!==COMFY_POOL_NATIVE_SCHEMA||value.namespace!==namespace
    ||!Number.isSafeInteger(value.revision)||value.revision<0||!Array.isArray(value.pools)||value.pools.length>COMFY_POOL_LIMITS.plans||!Array.isArray(value.retired)||value.retired.length>2048
    ||!Array.isArray(value.sources)||value.sources.length>256||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>COMFY_POOL_LIMITS.totalBytes||bytes(value)>8*1048576)fail('候选方案目录格式、账户或容量无效');
  const ids=new Set();let total=0;
  for(const [rows,active]of [[value.pools,true],[value.retired,false]])for(const row of rows){validateComfyPoolNativeRow(row,scope);if(ids.has(row.head.id))fail('候选方案编号重复');ids.add(row.head.id);if(active)total+=row.head.totalBytes;}
  if(total>maxBytes)fail('候选方案达到原有容量上限');const receipts=new Set();
  for(const source of value.sources){
    if(!exact(source,['census','digest','pools','pending'])||!['census','digest'].every(key=>typeof source[key]==='string'&&/^[a-f0-9]{64}$/.test(source[key]))||receipts.has(source.census)
      ||!Array.isArray(source.pools)||source.pools.length>COMFY_POOL_LIMITS.plans||!Array.isArray(source.pending)||new Set(source.pending).size!==source.pending.length)fail('旧候选方案来源无效');
    receipts.add(source.census);const entries=new Set();let bytes=0;for(const row of source.pools){validateComfyPoolNativeRow(row,scope);if(entries.has(row.head.id))fail('旧方案来源编号重复');entries.add(row.head.id);bytes+=row.head.totalBytes;}
    if(bytes>COMFY_POOL_LIMITS.totalBytes||source.pending.some(id=>!entries.has(id)))fail('旧候选方案来源计值或待核对项目无效');
  }return value;
}
export const storedComfyPoolHead=(namespace,meta)=>({...structuredClone(meta),namespace,key:JSON.stringify([namespace,meta.id])});
export const storedComfyPoolVersion=(namespace,meta)=>({...structuredClone(meta),namespace,key:JSON.stringify([namespace,meta.id,meta.revision])});
export function createComfyPoolNativeOriginals(client){
  const namespace=account(client.namespace),scope=client.scope;
  const checked=value=>{if(!exact(value,['schema','namespace','meta','pool'])||value.schema!=='qianmu.comfy.native-pool-version.v1'||value.namespace!==namespace)fail('候选方案原件格式或账户不符');validateComfyPoolVersion({meta:value.meta,pool:value.pool},namespace);return value;};
  const reference=value=>stAccountImmutableReference(value,{scope,slot:COMFY_POOL_ORIGINAL_SLOT,maxBytes:COMFY_POOL_ORIGINAL_BYTES});
  return {
    async preserve(version,options){const value=checked({schema:'qianmu.comfy.native-pool-version.v1',namespace,...structuredClone(version)}),saved=await client.preserveImmutable(COMFY_POOL_ORIGINAL_SLOT,value,options);if(!same(checked(saved.value),value))fail('候选方案完整原件尚未读回');return {meta:structuredClone(value.meta),reference:reference(saved.reference)};},
    async read(version,options){const captured=structuredClone(version),saved=await client.readImmutable(reference(captured.reference),options),value=checked(saved.value);if(!same(value.meta,captured.meta))fail('候选方案原件与准确版本不符');return {meta:structuredClone(value.meta),pool:structuredClone(value.pool)};},
    async readRow(row,options){validateComfyPoolNativeRow(row,scope);const versions=[];for(const version of row.versions)versions.push(await this.read(version,options));const result={head:structuredClone(row.head),versions};validateComfyPoolBackup(comfyPoolNativePacket(namespace,[result]));return result;},
  };
}
