import {assertComfyRouteNamespace} from './qianmu-comfy-route-contract.js';
const size=value=>new TextEncoder().encode(JSON.stringify(value)).byteLength;
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const identifier=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,160}$/.test(value);
const fail=()=>{throw Error('Comfy 索引或计值不一致，请先保全资料');};
const limits={workflows:{count:128,bytes:64*1048576},pools:{count:32,bytes:16*1048576}};

// Account-local metadata and document keys only. Quota usage remains a separate, unchanged contract.
export function summarizeComfyLibraryStorage(kind,namespace,{heads,versions,documentKeys}){
  assertComfyRouteNamespace(namespace);const limit=limits[kind];
  if(!limit||!Array.isArray(heads)||heads.length>limit.count||!Array.isArray(versions)||versions.length>limit.count*64||!Array.isArray(documentKeys))fail();
  const byId=new Map(),byVersion=new Map();let documentBytes=0,indexBytes=0;
  for(const head of heads){
    if(head.namespace!==namespace||!identifier(head.id)||!identifier(head.revision)||head.key!==JSON.stringify([namespace,head.id])||byId.has(head.id)
      ||!integer(head.version)||head.version<1||head.version>64||!integer(head.bytes)||head.bytes<1||!integer(head.totalBytes)||head.totalBytes<head.bytes||typeof head.archived!=='boolean')fail();
    byId.set(head.id,head);indexBytes+=size(head);
  }
  for(const row of versions){
    const head=byId.get(row.id),key=JSON.stringify([namespace,row.id,row.revision]);
    if(!head||row.namespace!==namespace||!identifier(row.revision)||row.key!==key||byVersion.has(key)||row[kind==='workflows'?'workflowKey':'poolKey']!==head.key
      ||!integer(row.version)||row.version<1||row.version>64||!integer(row.bytes)||row.bytes<1||!integer(row.totalBytes)||row.totalBytes<row.bytes)fail();
    byVersion.set(key,row);documentBytes+=row.bytes;indexBytes+=size(row);
    const wrapper=kind==='workflows'?{key,namespace,id:row.id,revision:row.revision,document:null}
      :{key,namespace,id:row.id,revision:row.revision,version:row.version,name:row.name,pool:null,bytes:row.bytes};
    indexBytes+=size(wrapper)-4;
  }
  if(documentBytes>limit.bytes||JSON.stringify([...documentKeys].sort())!==JSON.stringify([...byVersion.keys()].sort()))fail();
  for(const head of heads){
    const chain=versions.filter(row=>row.id===head.id).sort((a,b)=>a.version-b.version);let total=0;
    if(chain.length!==head.version)fail();
    for(let i=0;i<chain.length;i++){const row=chain[i];total+=row.bytes;
      if(row.version!==i+1||row.totalBytes!==total||kind==='workflows'&&row.parentRevision!==(chain[i-1]?.revision||''))fail();
    }
    const last=chain.at(-1);if(!last||last.revision!==head.revision||last.bytes!==head.bytes||total!==head.totalBytes)fail();
  }
  return {status:'ready',count:heads.length,archived:heads.filter(row=>row.archived).length,versions:versions.length,
    documentBytes,indexBytes,bytes:documentBytes+indexBytes};
}

export function readComfyLibraryStorage(tx,read,set,keyRange,kind,namespace){
  const limit=limits[kind],headStore=kind==='workflows'?'workflows':'heads',versionStore=kind==='workflows'?'revisions':'versions';
  const prefix=JSON.stringify([namespace]).slice(0,-1)+',',range=keyRange.bound(prefix,prefix+'\uffff');
  const snapshot={};let pending=3;
  const receive=name=>rows=>{snapshot[name]=rows;if(!--pending){
    try{set(summarizeComfyLibraryStorage(kind,namespace,snapshot));}
    catch(error){throw Object.assign(Error(error.message),{code:kind==='workflows'?'comfy_library_storage':'comfy_pool_index'});}
  }};
  read(tx.objectStore(headStore).index('namespace').getAll(keyRange.only(namespace),limit.count+1),receive('heads'));
  read(tx.objectStore(versionStore).getAll(range,limit.count*64+1),receive('versions'));
  read(tx.objectStore('documents').getAllKeys(range,limit.count*64+1),receive('documentKeys'));
}

export function validateComfyStorageSummary(value,namespace){
  assertComfyRouteNamespace(namespace);
  const keys=['version','status','namespace','workflows','pools','scenes','bytes','count','errors'];
  if(!value||Object.keys(value).some(key=>!keys.includes(key))||value.version!==1||value.namespace!==namespace||!integer(value.bytes)||!integer(value.count)||!Array.isArray(value.errors))fail();
  let bytes=0,count=0,ready=0;const errors=[];
  for(const key of ['workflows','pools','scenes']){
    const row=value[key];if(!row||Object.keys(row).some(name=>!['status','bytes','count','documentBytes','indexBytes','archived','versions','generation','error'].includes(name)))fail();
    if(row.status==='unavailable'){
      if(Object.keys(row).some(name=>!['status','bytes','count','error'].includes(name))||row.bytes!==null||row.count!==null||typeof row.error!=='string'||!row.error||row.error.length>512)fail();
      errors.push(row.error);continue;
    }
    const max=key==='scenes'?{count:1024,bytes:4*1048576}:limits[key];
    if(row.status!=='ready'||!['bytes','count','documentBytes','indexBytes'].every(name=>integer(row[name]))||row.count>max.count||row.documentBytes>max.bytes||row.bytes!==row.documentBytes+row.indexBytes||Object.hasOwn(row,'error'))fail();
    if(key==='scenes'){
      if(!integer(row.generation)||Object.hasOwn(row,'versions')||Object.hasOwn(row,'archived'))fail();
    }else if(!integer(row.archived)||row.archived>row.count||!integer(row.versions)||row.versions<row.count||row.versions>row.count*64||Object.hasOwn(row,'generation'))fail();
    ready++;bytes+=row.bytes;count+=row.count;
  }
  if(value.status!==(ready===3?'ready':ready?'partial':'unavailable')||bytes!==value.bytes||count!==value.count||JSON.stringify(errors)!==JSON.stringify(value.errors))fail();
  return structuredClone(value);
}
