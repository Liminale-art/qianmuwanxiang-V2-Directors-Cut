import {stAccountImmutableReference} from './qianmu-st-account-storage.js';
import {COMFY_LIBRARY_BACKUP_SCHEMA,validateComfyLibraryBackup,validateComfyLibraryMetadata,validateComfyLibraryVersion} from './qianmu-comfy-library-backup.js';

export const COMFY_NATIVE_SLOT='comfy-workflow-library',COMFY_ORIGINAL_SLOT='comfy-workflow-version';
export const COMFY_NATIVE_SCHEMA='qianmu.comfy.native-library.v1';
const originalSchema='qianmu.comfy.native-version.v1';
export const comfyNativeFail=message=>{throw Object.assign(Error(message),{code:'comfy_library_native',submissionState:'not_submitted'});};
export const comfyNativeSame=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export const comfyNativeBytes=value=>new TextEncoder().encode(JSON.stringify(value)).length;
export const comfyNativeId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,160}$/.test(value);
export const comfyNativeAccount=value=>{if(typeof value!=='string'||!/^st-user:.+/.test(value)||value.length>240||/[\u0000-\u001f\u007f]/.test(value))comfyNativeFail('工作流账户无效');return value;};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
export const comfyNativePacket=(namespace,workflows)=>({schema:COMFY_LIBRARY_BACKUP_SCHEMA,namespace,credentialsIncluded:false,workflows});
export const emptyComfyNativeIndex=namespace=>({schema:COMFY_NATIVE_SCHEMA,namespace,revision:0,workflows:[],retired:[],sources:[]});
export function validateComfyNativeRow(row,scope){
  if(!exact(row,['head','versions']))comfyNativeFail('工作流目录条目格式无效');
  validateComfyLibraryMetadata(row.head);
  if(Object.hasOwn(row.head,'parentRevision')||!Array.isArray(row.versions)||row.versions.length!==row.head.version)comfyNativeFail('工作流完整版本链缺失');
  let previous='',sum=0;const seen=new Set();
  for(let i=0;i<row.versions.length;i++){
    const version=row.versions[i];if(!exact(version,['meta','reference']))comfyNativeFail('工作流原件目录无效');validateComfyLibraryMetadata(version.meta);const meta=version.meta;
    if(meta.id!==row.head.id||meta.version!==i+1||meta.parentRevision!==previous||seen.has(meta.revision)||meta.archived!==false||meta.createdAt!==row.head.createdAt)comfyNativeFail('工作流版本链归属或前序不符');
    sum+=meta.bytes;if(meta.totalBytes!==sum)comfyNativeFail('工作流版本占用不符');seen.add(meta.revision);previous=meta.revision;
    stAccountImmutableReference(version.reference,{scope,slot:COMFY_ORIGINAL_SLOT,maxBytes:8*1048576+1024});
  }
  const {parentRevision,...tail}=row.versions.at(-1).meta,expected={...tail,archived:row.head.archived,updatedAt:row.head.updatedAt};
  // Compare metadata independent of property insertion order; recipe graph
  // strings and document bytes are never reordered or normalized here.
  const sorted=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
  if(row.head.updatedAt<tail.updatedAt||sorted(row.head)!==sorted(expected))comfyNativeFail('工作流当前指针与版本链不符');return row;
}
export function validateComfyNativeIndex(value,namespace,scope,{maxBytes=64*1048576}={}){
  comfyNativeAccount(namespace);
  if(!exact(value,['schema','namespace','revision','workflows','retired','sources'])||value.schema!==COMFY_NATIVE_SCHEMA||value.namespace!==namespace
    ||!Number.isSafeInteger(value.revision)||value.revision<0||!Array.isArray(value.workflows)||value.workflows.length>128||!Array.isArray(value.retired)||value.retired.length>8192
    ||!Array.isArray(value.sources)||value.sources.length>256
    ||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>64*1048576||comfyNativeBytes(value)>8*1048576)comfyNativeFail('工作流目录格式、归属或容量无效');
  const seen=new Set();let bytes=0;
  for(const [rows,active]of [[value.workflows,true],[value.retired,false]])for(const row of rows){validateComfyNativeRow(row,scope);if(seen.has(row.head.id))comfyNativeFail('工作流目录编号重复');seen.add(row.head.id);if(active)bytes+=row.head.totalBytes;}
  const sources=new Set();for(const source of value.sources){
    if(!exact(source,['census','digest','workflows','pending'])||!['census','digest'].every(key=>typeof source[key]==='string'&&/^[a-f0-9]{64}$/.test(source[key]))||sources.has(source.census)
      ||!Array.isArray(source.workflows)||source.workflows.length>128||!Array.isArray(source.pending)||new Set(source.pending).size!==source.pending.length)comfyNativeFail('工作流旧库来源记录无效');
    sources.add(source.census);const ids=new Set();let total=0;
    for(const row of source.workflows){validateComfyNativeRow(row,scope);if(ids.has(row.head.id))comfyNativeFail('旧库来源编号重复');ids.add(row.head.id);total+=row.head.totalBytes;}
    if(total>64*1048576||source.pending.some(id=>!ids.has(id)))comfyNativeFail('工作流旧库待核对项目无效');
  }
  if(bytes>maxBytes)comfyNativeFail('工作流库达到原有64MiB容量上限');return value;
}
export const comfyNativeStoredHead=(namespace,head)=>({...structuredClone(head),namespace,key:JSON.stringify([namespace,head.id])});
export const comfyNativeStoredVersion=(namespace,meta)=>({...structuredClone(meta),namespace,key:JSON.stringify([namespace,meta.id,meta.revision]),workflowKey:JSON.stringify([namespace,meta.id])});

export function createComfyNativeOriginals(client){
  const namespace=comfyNativeAccount(client.namespace),scope=client.scope;
  function checked(value){
    if(!exact(value,['schema','namespace','meta','document'])||value.schema!==originalSchema||value.namespace!==namespace)comfyNativeFail('工作流原件格式或账户不符');
    validateComfyLibraryVersion({meta:value.meta,document:value.document});return value;
  }
  return {
    async preserve(version,options){
      const value=checked({schema:originalSchema,namespace,...structuredClone(version)}),saved=await client.preserveImmutable(COMFY_ORIGINAL_SLOT,value,options);
      if(!comfyNativeSame(checked(saved.value),value))comfyNativeFail('工作流完整版本尚未读回');
      return {meta:structuredClone(value.meta),reference:stAccountImmutableReference(saved.reference,{scope,slot:COMFY_ORIGINAL_SLOT,maxBytes:8*1048576+1024})};
    },
    async read(version,options){
      const captured=structuredClone(version),reference=stAccountImmutableReference(captured.reference,{scope,slot:COMFY_ORIGINAL_SLOT,maxBytes:8*1048576+1024}),saved=await client.readImmutable(reference,options);
      const value=checked(saved.value);if(!comfyNativeSame(value.meta,captured.meta))comfyNativeFail('工作流原件与准确版本目录不符');
      return {meta:structuredClone(value.meta),document:structuredClone(value.document)};
    },
    async readRow(row,options){
      validateComfyNativeRow(row,scope);const versions=[];for(const version of row.versions)versions.push(await this.read(version,options));
      const result={head:structuredClone(row.head),versions};validateComfyLibraryBackup(comfyNativePacket(namespace,[result]));return result;
    },
  };
}
