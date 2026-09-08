import {vibeFileError} from './qianmu-vibe-file.js';
const size=value=>new TextEncoder().encode(JSON.stringify(value)).byteLength;
const fail=()=>{throw vibeFileError('index','Vibe 原件键或索引计值不一致，请先保全数据');};

// Payloads retain their original UTF-8/file-byte basis; metadata is a separate JSON projection.
// This is not serialized JSON escaping of the entire file, UTF-16 heap size or physical IDB overhead.
export function summarizeVibeAssetMetadata(namespace,{heads,usage,documentKeys,previewKeys}){
  if(!Array.isArray(heads)||heads.length>1024||!Array.isArray(documentKeys)||!Array.isArray(previewKeys))fail();
  const seen=new Set(),previews=[];let bytes=usage?size(usage):0,count=usage?1:0,fileBytes=0,previewBytes=0;
  for(const head of heads){
    if(head.namespace!==namespace||head.key!==JSON.stringify([namespace,head.assetId])||seen.has(head.key)||!Number.isSafeInteger(head.bytes)||head.bytes<1
      ||!Number.isSafeInteger(head.previewBytes??0)||(head.previewBytes??0)<0)fail();
    seen.add(head.key);fileBytes+=head.bytes;previewBytes+=head.previewBytes||0;bytes+=size(head)+size({key:head.key,namespace,serialized:null})-4;count+=2;
    if(head.previewBytes){previews.push(head.key);bytes+=size({key:head.key,namespace,blob:null})-4;count++;}
  }
  const same=(a,b)=>JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
  if(!same(documentKeys,seen)||!same(previewKeys,previews)||fileBytes+previewBytes>512*1048576
    ||usage&&(usage.key!==namespace||usage.count!==heads.length||usage.bytes!==fileBytes||(usage.previewBytes??0)!==previewBytes)||!usage&&heads.length)fail();
  return {bytes,count};
}
