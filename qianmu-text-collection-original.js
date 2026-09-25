import {stAccountImmutableReference} from './qianmu-st-account-storage.js';
import {textCollectionPreview} from './qianmu-text-collection.js';
import {TEXT_COLLECTION_SYNC_LIMITS,textCollectionSyncEntry,textCollectionSyncResponse,textCollectionSyncError as error} from './qianmu-text-collection-sync-contract.js';

// One complete, owned text original. No library head, chat or settings mutation.
// The native library will publish descriptors only after every body is verified.
export const TEXT_COLLECTION_ORIGINAL_SLOT='collection-record';
const utf8=new TextEncoder(),bytes=value=>utf8.encode(JSON.stringify(value)).byteLength;
const fail=()=>{throw error('original','收藏原件与目录不一致，未采用或覆盖内容',503);};
const exact=(value,names)=>value!==null&&typeof value==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(value))
  &&Reflect.ownKeys(value).length===names.length&&names.every(key=>{const d=Object.getOwnPropertyDescriptor(value,key);return d?.enumerable&&Object.hasOwn(d,'value');});
const envelopeKeys=['version','expectedAccount','entry'];
const descriptorKeys=['version','id','revision','updatedAt','original','summary','recordBytes','textBytes'];
const summary=record=>({id:record.id,revision:record.revision,createdAt:record.createdAt,updatedAt:record.updatedAt,
  charName:record.source.charName,userName:record.source.userName,mode:record.mode,preview:textCollectionPreview(record)});
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

export function textCollectionOriginalDescriptor(value,{expectedAccount,scope}={}){
  if(!exact(value,descriptorKeys)||value.version!==1)fail();
  const original=stAccountImmutableReference(value.original,{scope,slot:TEXT_COLLECTION_ORIGINAL_SLOT});
  const request={version:1,expectedAccount,cursor:null,limit:1};
  const result=textCollectionSyncResponse({ok:true,version:1,expectedAccount,libraryRevision:value.revision,
    items:[value.summary],total:1,nextCursor:null},'list',request),item=result.items[0];
  if(value.id!==item.id||value.revision!==item.revision||value.updatedAt!==item.updatedAt
    ||!Number.isSafeInteger(value.recordBytes)||value.recordBytes<1||value.recordBytes>=original.bytes
    ||!Number.isSafeInteger(value.textBytes)||value.textBytes<1||value.textBytes>=value.recordBytes)fail();
  const clean=Object.freeze(Object.fromEntries(['id','revision','createdAt','updatedAt','charName','userName','mode','preview'].map(key=>[key,item[key]])));
  return Object.freeze({version:1,id:item.id,revision:item.revision,updatedAt:item.updatedAt,original,summary:clean,recordBytes:value.recordBytes,textBytes:value.textBytes});
}

export function createTextCollectionOriginalStore({storage,expectedAccount}={}){
  if(!/^st-user:[a-f0-9]{64}$/.test(expectedAccount||'')||!storage||!/^([a-f0-9]{64})$/.test(storage.scope||'')
    ||typeof storage.preserveImmutable!=='function'||typeof storage.readImmutable!=='function')throw error('setup','收藏原件储存环境未就绪',503);
  const options={expectedAccount,scope:storage.scope};
  const descriptor=(entry,reference)=>textCollectionOriginalDescriptor({version:1,id:entry.id,revision:entry.revision,updatedAt:entry.updatedAt,
    original:reference,summary:summary(entry.record),recordBytes:bytes(entry.record),textBytes:utf8.encode(entry.record.text).byteLength},options);
  function validateResult(result){
    if(result?.exists!==true||!exact(result.value,envelopeKeys)||result.value.version!==1||result.value.expectedAccount!==expectedAccount)fail();
    const entry=textCollectionSyncEntry(result.value.entry,expectedAccount);if(entry.deleted)fail();
    const reference=stAccountImmutableReference(result.reference,{scope:storage.scope,slot:TEXT_COLLECTION_ORIGINAL_SLOT});
    if(result.fingerprint!==reference.fingerprint)fail();return {entry,reference};
  }
  return Object.freeze({
    async preserve(input,transportOptions){
      const entry=structuredClone(textCollectionSyncEntry(input,expectedAccount));if(entry.deleted)fail();
      const saved=validateResult(await storage.preserveImmutable(TEXT_COLLECTION_ORIGINAL_SLOT,{version:1,expectedAccount,entry},transportOptions));
      if(!equal(saved.entry,entry))fail();return descriptor(entry,saved.reference);
    },
    async read(input,transportOptions){
      const captured=textCollectionOriginalDescriptor(input,options),saved=validateResult(await storage.readImmutable(captured.original,transportOptions));
      if(!equal(descriptor(saved.entry,saved.reference),captured))fail();return saved.entry;
    },
    async readMany(inputs,transportOptions){
      if(!Array.isArray(inputs)||inputs.length<1||inputs.length>4)throw error('contract','收藏原件批次范围无效',400);
      const captured=inputs.map(input=>textCollectionOriginalDescriptor(input,options));
      if(typeof storage.readImmutableBatch!=='function')return Promise.all(captured.map(input=>this.read(input,transportOptions)));
      const entries=[];let start=0;
      while(start<captured.length){
        let end=start,total=0;
        while(end<captured.length&&end-start<4&&total+captured[end].original.bytes<=TEXT_COLLECTION_SYNC_LIMITS.bytes+1024){total+=captured[end].original.bytes;end++;}
        if(end===start)end++;
        const group=captured.slice(start,end),results=await storage.readImmutableBatch(group.map(input=>input.original),transportOptions);
        if(!Array.isArray(results)||results.length!==group.length)fail();
        for(let index=0;index<group.length;index++){
          const result=results[index];if(result.status==='rejected')throw result.reason;
          if(result.status!=='fulfilled')fail();
          const saved=validateResult(result.value);
          if(!equal(descriptor(saved.entry,saved.reference),group[index]))fail();
          entries.push(saved.entry);
        }
        start=end;
      }
      return entries;
    },
  });
}
