import {comfyLibraryBackupDigest,validateComfyLibraryBackup} from './qianmu-comfy-library-backup.js';
import {comfyNativeFail as fail,comfyNativeSame as same,comfyNativeBytes,comfyNativePacket,COMFY_ORIGINAL_SLOT} from './qianmu-comfy-native-contract.js';

// Upper-bound metadata only: UTF-8 content/escaped names count exactly, while
// reference hashes have fixed length. Never upload all legacy graphs merely to
// discover that their source receipt cannot fit. No graph body enters the index.
export function estimateComfyMigrationIndexBytes(index,packet,family={}){
  const {key='workflows',originalSlot=COMFY_ORIGINAL_SLOT,originalBytes=8*1048576+1024}=family;
  const reference={version:1,scope:'0'.repeat(64),slot:originalSlot,fingerprint:'0'.repeat(64),bytes:originalBytes};
  const rows=packet[key].map(row=>({head:row.head,versions:row.versions.map(version=>({meta:version.meta,reference}))}));
  const projected=structuredClone(index);
  for(const row of rows){const at=projected[key].findIndex(old=>old.head.id===row.head.id);if(at<0)projected[key].push(row);else if(comfyNativeBytes(projected[key][at])<comfyNativeBytes(row))projected[key][at]=row;}
  projected.sources.push({census:'0'.repeat(64),digest:'0'.repeat(64),[key]:rows,pending:rows.map(row=>row.head.id)});
  projected.revision=Number.MAX_SAFE_INTEGER;return comfyNativeBytes(projected);
}

// The local three-table metadata/key census is cheap and atomic. Full graph
// documents are read only for a previously unregistered source, never on every
// ordinary lookup. Local originals are never written, cleared or replaced.
export async function prepareComfyLegacy({legacy,namespace,ctx,current,maxBytes,family={}}){
  const {key='workflows',limit=128,validate=validateComfyLibraryBackup,fail:reject=fail,title='工作流'}=family;
  if(!legacy)return async()=>{};
  const options={isCurrent:current},before=await legacy.census(namespace,options),census=await comfyLibraryBackupDigest(before);await ctx.check();
  const stable=async()=>{await ctx.check();if(await comfyLibraryBackupDigest(await legacy.census(namespace,options))!==census)reject(`本机旧${title}库在核对期间变化，未覆盖，请重新打开`);await ctx.check();};
  if(ctx.index.sources.some(source=>source.census===census)||!before.heads.length)return stable;
  if(ctx.index.sources.length>=256)reject(`旧${title}来源记录达到上限，请先导出核对；未删减来源`);
  const packet=await legacy.backup(namespace,options);validate(packet);if(packet.namespace!==namespace)reject(`${title}旧库账户不符`);await stable();
  if(estimateComfyMigrationIndexBytes(ctx.index,packet,family)>8*1048576)reject('完整旧库来源目录预计超出8MiB，未上传或裁剪原件；请先导出旧库核对');
  const workflows=[];for(const row of packet[key]){const versions=[];for(const version of row.versions){versions.push(await ctx.originals.preserve(version,ctx.transport));await ctx.check();}workflows.push({head:row.head,versions});}
  const next=structuredClone(ctx.index),pending=[];
  for(const row of workflows){
    const old=next[key].find(item=>item.head.id===row.head.id),retired=next.retired.some(item=>item.head.id===row.head.id);
    const prefix=!old||old.versions.slice(0,Math.min(old.versions.length,row.versions.length)).every((version,i)=>same(version,row.versions[i]));
    const extendsChain=old&&row.head.version>old.head.version;
    const differentState=old&&row.head.version===old.head.version&&row.head.archived!==old.head.archived;
    const count=next[key].length+(old?0:1),total=next[key].reduce((n,item)=>n+item.head.totalBytes,0)+(row.head.totalBytes-(old?.head.totalBytes||0));
    if(retired||!prefix||differentState||extendsChain&&old.head.archived||count>limit||(!old||extendsChain)&&total>maxBytes){pending.push(row.head.id);continue;}
    if(old&&!extendsChain)continue;
    next[key]=next[key].filter(item=>item.head.id!==row.head.id);next[key].push(structuredClone(row));
  }
  next.sources.push({census,digest:await comfyLibraryBackupDigest(packet),[key]:workflows,pending});ctx.validate({...next,revision:ctx.index.revision+1});await stable();await ctx.save(next);await stable();return stable;
}

export async function exportComfyLegacy(ctx,namespace,census,family={}){
  const {key='workflows',validate=validateComfyLibraryBackup,pack=comfyNativePacket,fail:reject=fail,title='工作流'}=family;
  const source=ctx.index.sources.find(item=>item.census===census);if(!source)reject(`旧${title}来源不存在`);
  const rows=[];for(const row of source[key])rows.push(await ctx.originals.readRow(row,ctx.transport));
  const packet=pack(namespace,rows);validate(packet);
  if(await comfyLibraryBackupDigest(packet)!==source.digest)reject(`旧${title}完整来源校验不符`);return packet;
}
