import {textCollectionSyncMutation,textCollectionSyncResponse,textCollectionSyncError as error} from './qianmu-text-collection-sync-contract.js';
import {TEXT_COLLECTION_BULK_LIMITS} from './qianmu-text-collection-bulk-contract.js';
import {validateNativeCollectionDocument} from './qianmu-text-collection-document.js';

export const NATIVE_COLLECTION_PROTOCOL='qianmu.st-account-document.v1';
const exact=(value,keys)=>value!==null&&typeof value==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(value))
  &&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>{const descriptor=Object.getOwnPropertyDescriptor(value,key);return descriptor?.enumerable&&Object.hasOwn(descriptor,'value');});
const fail=message=>{throw error('native_response',message,502);};
const digest=async(value,cryptoImpl)=>Array.from(new Uint8Array(await cryptoImpl.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)))),byte=>byte.toString(16).padStart(2,'0')).join('');

export function nativeCollectionCapabilities(value,expectedAccount){
  if(!exact(value,['ok','version','expectedAccount','nativeProtocol','indexVersion'])||value.ok!==true||value.version!==1
    ||!/^st-user:[a-f0-9]{64}$/.test(expectedAccount||'')||value.expectedAccount!==expectedAccount
    ||value.nativeProtocol!==NATIVE_COLLECTION_PROTOCOL||value.indexVersion!==2)fail('收藏服务能力与当前账户或文件版本不一致');
  return Object.freeze({...value});
}

// A distinct operation endpoint, not an expansion of legacy restore/delete bulk.
// Fixed mutation IDs/base revisions work identically in the native file path.
export function nativeCollectionWriteRequest(value){
  if(!exact(value,['version','expectedAccount','mutations'])||value.version!==1||!Array.isArray(value.mutations)
    ||value.mutations.length<1||value.mutations.length>TEXT_COLLECTION_BULK_LIMITS.items)throw error('contract','收藏保存批次范围无效',400);
  const ids=new Set(),operations=new Set();
  const mutations=Array.from(value.mutations,raw=>{
    const item=textCollectionSyncMutation(raw);
    if(item.expectedAccount!==value.expectedAccount||ids.has(item.id)||operations.has(item.mutationId))throw error('contract','收藏保存账户或目标重复',400);
    ids.add(item.id);operations.add(item.mutationId);return item;
  });
  const result={version:1,expectedAccount:value.expectedAccount,mutations:Object.freeze(mutations)};
  if(new TextEncoder().encode(JSON.stringify(result)).byteLength>TEXT_COLLECTION_BULK_LIMITS.bytes)throw error('contract','收藏保存超过单批上限，未截断正文',400);
  return Object.freeze(result);
}

// Trust neither a bare success flag nor an unrelated receipt. Verify the exact
// canonical index fingerprint and each request's durable receipt before warming
// the existing native cache; no second browser-side directory read is required.
export async function nativeCollectionWriteResponse(value,raw,{scope,cryptoImpl=globalThis.crypto}={}){
  const request=nativeCollectionWriteRequest(raw);
  if(!/^[a-f0-9]{64}$/.test(scope||'')||!cryptoImpl?.subtle?.digest
    ||!exact(value,['ok','version','expectedAccount','scope','verified','acknowledgements'])||value.ok!==true||value.version!==1
    ||value.expectedAccount!==request.expectedAccount||value.scope!==scope||!exact(value.verified,['value','fingerprint'])
    ||!/^[a-f0-9]{64}$/.test(value.verified.fingerprint||''))fail('收藏保存回执不完整或账户不一致');
  const state=validateNativeCollectionDocument(value.verified.value,{expectedAccount:request.expectedAccount,scope});
  if(state.version!==2)fail('收藏保存返回了不同版本的目录');
  const fingerprint=await digest({schema:NATIVE_COLLECTION_PROTOCOL,scope,slot:'collections',value:state},cryptoImpl);
  if(fingerprint!==value.verified.fingerprint)fail('收藏目录完整性校验未通过');
  const ack=value.acknowledgements;
  if(!exact(ack,['ok','version','expectedAccount','libraryRevision','results'])||ack.ok!==true||ack.version!==1
    ||ack.expectedAccount!==request.expectedAccount||ack.libraryRevision!==state.revision||!Array.isArray(ack.results)
    ||ack.results.length!==request.mutations.length)fail('收藏保存结果与目录不一致');
  const receipts=new Map(state.receipts.map(row=>[row.mutationId,row])),results=[];
  for(let index=0;index<request.mutations.length;index++){
    const input=request.mutations[index],result=textCollectionSyncResponse(ack.results[index],'write',input),receipt=receipts.get(input.mutationId);
    if(!receipt||result.libraryRevision>state.revision||receipt.hash!==await digest(input,cryptoImpl)
      ||Object.keys(result).some(key=>receipt[key]!==result[key]))fail('收藏原操作的保存凭据未完整核实');
    results.push(result);
  }
  return Object.freeze({...value,verified:Object.freeze({value:state,fingerprint}),acknowledgements:Object.freeze({...ack,results:Object.freeze(results)})});
}
