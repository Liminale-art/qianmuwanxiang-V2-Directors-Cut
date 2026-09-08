import {normalizeComfyLibraryDocument,inspectComfyLibraryDocument,comfyLibraryError} from './qianmu-comfy-library.js';
import {parseStrictStoryboardJson} from './qianmu-storyboard-package-input.js';
import {vibeDigest} from './qianmu-vibe-file.js';

export const COMFY_LIBRARY_BACKUP_SCHEMA='qianmu.comfy.library-backup.v1';
export const COMFY_LIBRARY_BACKUP_BYTES=80*1024*1024;
const fail=message=>{throw comfyLibraryError('backup',message);};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const integer=(v,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const identifier=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,160}$/.test(v);
const size=v=>new TextEncoder().encode(JSON.stringify(v)).byteLength;
const account=v=>{if(typeof v!=='string'||!/^st-user:.+/.test(v)||v.length>240||/[\u0000-\u001f\u007f]/.test(v))fail('工作流备份账户无效');return v;};
const fields=['id','name','revision','version','createdAt','updatedAt','archived','bytes','totalBytes','nodes','slots','issue','classification'];
const only=(v,keys)=>{if(!object(v)||Object.keys(v).some(k=>!keys.includes(k)))fail('工作流备份含未知字段，请保留原文件');};
const canonical=v=>JSON.stringify(v,(_,item)=>object(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const equal=(a,b)=>canonical(a)===canonical(b);
const clean=meta=>Object.fromEntries(fields.filter(k=>Object.hasOwn(meta,k)).map(k=>[k,structuredClone(meta[k])]));
function metadata(meta){
  only(meta,[...fields,'parentRevision']);
  if(!identifier(meta.id)||!identifier(meta.revision)||typeof meta.name!=='string'||!meta.name.trim()||meta.name.length>80
    ||!integer(meta.version,1,64)||!integer(meta.createdAt)||!integer(meta.updatedAt,meta.createdAt)||typeof meta.archived!=='boolean'
    ||!integer(meta.bytes,1,64*1048576)||!integer(meta.totalBytes,meta.bytes,64*1048576)||!integer(meta.nodes,1,512)
    ||!Array.isArray(meta.slots)||meta.slots.some(x=>typeof x!=='string')||typeof meta.issue!=='string')fail('工作流备份版本索引无效');
}
export function validateComfyLibraryBackup(value){
  only(value,['schema','namespace','credentialsIncluded','workflows']);
  if(value.schema!==COMFY_LIBRARY_BACKUP_SCHEMA||value.credentialsIncluded!==false||!Array.isArray(value.workflows)||value.workflows.length>128)fail('工作流库备份格式或数量无效');account(value.namespace);
  const ids=new Set();let bytes=0,versions=0;
  for(const row of value.workflows){
    only(row,['head','versions']);metadata(row.head);if(Object.hasOwn(row.head,'parentRevision')||ids.has(row.head.id))fail('工作流编号重复或头记录无效');ids.add(row.head.id);
    if(!Array.isArray(row.versions)||row.versions.length!==row.head.version)fail('工作流缺少历史版本，不接受缺件备份');
    let parent='',sum=0;const revisions=new Set();
    for(let i=0;i<row.versions.length;i++){
      const version=row.versions[i];only(version,['meta','document']);metadata(version.meta);const meta=version.meta;
      if(meta.id!==row.head.id||meta.version!==i+1||meta.parentRevision!==parent||revisions.has(meta.revision)||meta.archived!==false||meta.createdAt!==row.head.createdAt)fail('工作流版本链不连续或归属不符');
      revisions.add(meta.revision);parent=meta.revision;
      let normalized;try{normalized=normalizeComfyLibraryDocument(version.document);}catch(_){fail('工作流原文无效或含凭据字段，请保留原件并单独核对');}
      if(!equal(normalized,version.document))fail('工作流版本含无法无损保留的字段，未改写原文');
      const inspected=inspectComfyLibraryDocument(normalized);sum+=inspected.bytes;
      if(meta.bytes!==inspected.bytes||meta.totalBytes!==sum||meta.nodes!==inspected.nodes||!equal(meta.slots,inspected.slots)||meta.issue!==inspected.issue
        ||!equal(meta.classification,normalized.classification))fail('工作流索引与原文不一致');
    }
    const tail=row.versions.at(-1).meta,expected={...clean(tail),archived:row.head.archived,updatedAt:row.head.updatedAt};
    if(row.head.updatedAt<tail.updatedAt||!equal(row.head,expected))fail('工作流最新指针与版本链不符');bytes+=sum;versions+=row.versions.length;
    if(bytes>64*1048576)fail('工作流库原文超过 64 MiB');
  }
  if(size(value)>COMFY_LIBRARY_BACKUP_BYTES)fail('工作流备份超过 80 MiB');return {count:ids.size,versions,bytes};
}
// Storage-only keys are rebuilt for the destination, never interpreted as server grants or live selections.
export function packComfyLibraryRecords(namespace,records){
  account(namespace);for(const row of records){only(row.head,[...fields,'key','namespace']);for(const version of row.versions)only(version.meta,[...fields,'parentRevision','key','namespace','workflowKey']);}
  const workflows=records.map(({head,versions})=>({head:clean(head),versions:versions.map(({meta,document})=>({meta:{...clean(meta),parentRevision:meta.parentRevision},document:structuredClone(document)})).sort((a,b)=>a.meta.version-b.meta.version)})).sort((a,b)=>a.head.id.localeCompare(b.head.id));
  const packet={schema:COMFY_LIBRARY_BACKUP_SCHEMA,namespace,credentialsIncluded:false,workflows};validateComfyLibraryBackup(packet);return packet;
}
export function unpackComfyLibraryRecord(namespace,row){
  account(namespace);const key=JSON.stringify([namespace,row.head.id]);return {
    head:{...structuredClone(row.head),namespace,key},
    versions:row.versions.map(({meta,document})=>{const documentKey=JSON.stringify([namespace,meta.id,meta.revision]);return {
      meta:{...structuredClone(meta),namespace,key:documentKey,workflowKey:key},
      document:{key:documentKey,namespace,id:meta.id,revision:meta.revision,document:structuredClone(document)},
    };}),
  };
}
export function planComfyLibraryRestore(local,incoming,{maxBytes=64*1048576}={}){
  const localUsage=validateComfyLibraryBackup(local),incomingUsage=validateComfyLibraryBackup(incoming),current=new Map(local.workflows.map(row=>[row.head.id,row])),writes=[];
  let added=0,extended=0,kept=0,addedVersions=0,addedBytes=0;
  for(const row of incoming.workflows){const old=current.get(row.head.id);
    if(old){for(let i=0;i<Math.min(old.versions.length,row.versions.length);i++)if(!equal(old.versions[i],row.versions[i]))fail('工作流存在不同的同编号版本，未覆盖本机数据；请先分别保全后核对');
      if(old.head.version>=row.head.version){kept++;continue;}extended++;
    }else added++;
    const versions=row.versions.slice(old?.versions.length||0);addedVersions+=versions.length;addedBytes+=versions.reduce((n,v)=>n+v.meta.bytes,0);writes.push({head:row.head,versions});
  }
  if(localUsage.count+added>128||localUsage.bytes+addedBytes>maxBytes)fail('恢复后工作流库超过数量或容量上限，未自动清理');
  return {writes,summary:{added,extended,kept,addedVersions,addedBytes,sourceCount:incomingUsage.count,sourceVersions:incomingUsage.versions}};
}
export const comfyLibraryBackupDigest=value=>vibeDigest(canonical(value));
export async function readComfyLibraryBackup(file){
  if(!(file instanceof Blob)||file.size<1||file.size>COMFY_LIBRARY_BACKUP_BYTES)fail('请选择 80 MiB 以内的工作流库备份');
  const bytes=await file.arrayBuffer();if(bytes.byteLength!==file.size)fail('备份文件读取大小不符');let text;
  try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch(_){fail('备份文件不是完整 UTF-8');}
  const value=parseStrictStoryboardJson(text,{maxBytes:COMFY_LIBRARY_BACKUP_BYTES});validateComfyLibraryBackup(value);return value;
}
