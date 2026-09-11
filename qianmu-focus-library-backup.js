// Reuse the bounded strict JSON reader used by resource packages. No URLs or credentials in this format.
import {parseStrictStoryboardJson} from './qianmu-storyboard-package-input.js';
import {normalizeFocusLibraryClip,focusLibraryError,FOCUS_LIBRARY_LIMITS} from './qianmu-focus-library.js';
export const FOCUS_BACKUP_LIMIT=32*1024*1024;
const fail=message=>{throw focusLibraryError('backup',message);};
const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
const encoder=new TextEncoder();
const hash=async(clip,blob)=>digest(encoder.encode(JSON.stringify([clip,blob.type,blob.size,await digest(await blob.arrayBuffer())])));
function encode(bytes){let result='';for(let i=0;i<bytes.length;i+=8192)result+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(result);}
export async function exportFocusLibrary(rows,{readAudio,guard=async()=>{}}) {
  if(!rows.length||rows.length>FOCUS_LIBRARY_LIMITS.clips)fail('请先选择语音');
  // Check encoded size before allocating originals. Large libraries can be exported in selected batches.
  if(rows.reduce((sum,row)=>sum+Math.ceil(row.audioBytes/3)*4+8192,256)>FOCUS_BACKUP_LIMIT)fail('所选语音超过32 MiB备份上限，请分批选择');
  const items=[],seen=new Set();
  for(const row of rows){
    await guard();const key=JSON.stringify([row.namespace,row.characterKey,row.id]);if(seen.has(key))fail('语音条重复');seen.add(key);
    const clip=normalizeFocusLibraryClip(row,row),result=await readAudio(row,row.id,row.revision);await guard();
    if(result.status!=='ready')fail('语音已变化或原件缺失，未输出缺件备份');
    const blob=result.blob;if(blob.size!==row.audioBytes||blob.type!==row.mimeType)fail('语音原件信息不符');
    items.push({clip,mime:blob.type,bytes:blob.size,sha256:await hash(clip,blob),data:encode(new Uint8Array(await blob.arrayBuffer()))});
  }
  await guard();const file=new Blob([JSON.stringify({schema:'qianmu.focus.library.v1',credentialsIncluded:false,items})],{type:'application/json'});
  if(file.size>FOCUS_BACKUP_LIMIT)fail('备份超过32 MiB，请分批导出');return file;
}
export async function inspectFocusLibraryBackup(file,{guard=async()=>{}}={}) {
  if(!(file instanceof Blob)||file.size<1||file.size>FOCUS_BACKUP_LIMIT)fail('请选择32 MiB以内的专注语音备份');
  const pack=parseStrictStoryboardJson(await file.text(),{maxBytes:FOCUS_BACKUP_LIMIT});await guard();
  if(pack?.schema!=='qianmu.focus.library.v1'||pack.credentialsIncluded!==false||Object.keys(pack).some(k=>!['schema','credentialsIncluded','items'].includes(k))
    ||!Array.isArray(pack.items)||!pack.items.length||pack.items.length>FOCUS_LIBRARY_LIMITS.clips)fail('专注语音备份格式不支持');
  const result=[],seen=new Set();
  for(const item of pack.items){
    await guard();if(!item||Object.keys(item).some(k=>!['clip','mime','bytes','sha256','data'].includes(k)))fail('备份含未知字段');
    const clip=normalizeFocusLibraryClip(item.clip,item.clip);
    if(JSON.stringify(clip)!==JSON.stringify(item.clip))fail('备份内容不能无损读取');
    const key=JSON.stringify([clip.namespace,clip.characterKey,clip.id]);if(seen.has(key))fail('备份包含重复条目');seen.add(key);
    if(!Number.isSafeInteger(item.bytes)||item.bytes<1||item.bytes>FOCUS_LIBRARY_LIMITS.audioBytes||typeof item.mime!=='string'||!/^audio\//i.test(item.mime)
      ||typeof item.data!=='string'||item.data.length!==4*Math.ceil(item.bytes/3)||!/^[A-Za-z0-9+/]*={0,2}$/.test(item.data))fail('备份音频大小或格式错误');
    const raw=atob(item.data);if(raw.length!==item.bytes||btoa(raw)!==item.data)fail('备份音频不完整');
    const blob=new Blob([Uint8Array.from(raw,c=>c.charCodeAt(0))],{type:item.mime});
    if(await hash(clip,blob)!==item.sha256)fail('备份内容校验失败，未导入');result.push({clip,blob});
  }await guard();return result;
}
