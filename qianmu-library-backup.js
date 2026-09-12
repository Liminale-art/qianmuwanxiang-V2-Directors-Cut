// Original-file library formats. Keep import admission and export warnings aligned.
import {parseBoundedJson,assertJsonInputBounds} from './qianmu-json-input.js';
export const NOTES_BACKUP_LIMITS=Object.freeze({bytes:12*1024*1024,entries:1000});
export const FAVORITES_BACKUP_LIMITS=Object.freeze({bytes:256*1024*1024,entries:2000,encodedBytes:64*1024*1024,audioBytes:48*1024*1024});
export const NOTE_TEXT_LIMITS=Object.freeze({id:120,title:120,body:20000});
export const FAVORITE_TEXT_LIMITS=Object.freeze({id:240,label:1000,text:12000,field:512});

// Validate every row before opening the destination. Never repair/truncate a backup.
export function validateLibraryBackupRows(payload){
  const notes=payload?.type==='qianmu-notes',favorites=payload?.type==='qianmu-tts-favorites';
  const rows=notes?payload.notes:payload?.entries,limits=notes?NOTES_BACKUP_LIMITS:FAVORITES_BACKUP_LIMITS;
  const label=notes?'便笺':'语音收藏';
  if((!notes&&!favorites)||![1,'1'].includes(payload.version)||!Array.isArray(rows))throw Error('不是有效的千幕资料备份');
  if(rows.length>limits.entries)throw Error(`${label}备份超过 ${limits.entries} 条，请拆分后导入；未写入内容。`);
  const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
  for(let index=0;index<rows.length;index++){
    const row=rows[index],caps=notes?NOTE_TEXT_LIMITS:FAVORITE_TEXT_LIMITS;
    const fail=reason=>{throw Error(`${label}第 ${index+1} 条${reason}；未写入内容，请保留原文件。`);};
    const text=(value,limit,field,codePoints=false)=>{
      if(value==null)return;
      if(typeof value!=='string')fail(`${field}格式无效`);
      if(value.length<=limit)return;
      if(!codePoints)fail(`${field}过长，不能无损恢复`);
      let count=0;for(const _ of value)if(++count>limit)fail(`${field}过长，不能无损恢复`);
    };
    if(!object(row))fail('格式无效');
    text(row.id,caps.id,'编号');
    if(row.id!=null&&row.id!==row.id.trim())fail('编号包含首尾空白，不能无损恢复');
    if(notes){text(row.title,caps.title,'标题',true);text(row.body,caps.body,'正文',true);continue;}
    text(row.label,caps.label,'名称');
    if(row.meta!=null){
      if(!object(row.meta))fail('元数据格式无效');
      for(const [key,value] of Object.entries(row.meta))if(typeof value==='string')text(value,key==='text'?caps.text:caps.field,'文字');
    }
    if(row.mime!=null&&(typeof row.mime!=='string'||!/^audio\/[a-z0-9.+-]+$/i.test(row.mime)))fail('音频类型无效');
    const data=row.data;
    if(typeof data!=='string'||!data.length||data.length>limits.encodedBytes||data.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(data))fail('音频编码或体积无效');
    const padding=data.endsWith('==')?2:data.endsWith('=')?1:0;
    // Check canonical padding bits without allocating another full audio copy.
    const last='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(data[data.length-padding-1]);
    if(padding&&(last& (padding===2?15:3)))fail('音频编码不完整');
    if(data.length/4*3-padding>limits.audioBytes)fail('音频超过 48 MB');
  }
  return rows;
}

export async function readLibraryBackupFile(file,type,{check}){
  const notes=type==='qianmu-notes',limits=notes?NOTES_BACKUP_LIMITS:FAVORITES_BACKUP_LIMITS,label=notes?'便笺备份':'语音收藏备份';
  check();
  if(!file||typeof file.text!=='function'||file.size!=null&&(!Number.isSafeInteger(file.size)||file.size<1||file.size>limits.bytes))throw Error(`${label}为空或超过 ${notes?12:256} MB；未写入内容。`);
  const raw=await file.text();check();
  const payload=parseBoundedJson(raw,{maxBytes:limits.bytes,label});
  if(payload?.type!==type)throw Error(`不是有效的千幕${label}；未写入内容。`);
  validateLibraryBackupRows(payload);check();return payload;
}

export function prepareLibraryBackup(payload){
  const notes=payload?.type==='qianmu-notes',favorites=payload?.type==='qianmu-tts-favorites';
  const rows=notes?payload.notes:payload?.entries,limits=notes?NOTES_BACKUP_LIMITS:FAVORITES_BACKUP_LIMITS;
  if((!notes&&!favorites)||payload.version!==1||!Array.isArray(rows))throw Error('备份格式无效，未导出。');
  const serialized=JSON.stringify(payload),blob=new Blob([serialized],{type:'application/json'});
  let preservationOnly=blob.size>limits.bytes;
  try{assertJsonInputBounds(serialized,{maxBytes:limits.bytes});validateLibraryBackupRows(payload);}catch{preservationOnly=true;}
  return {blob,preservationOnly,label:notes?'固定便笺':'语音收藏',prefix:notes?'qianmu-notes':'qianmu-语音收藏',count:rows.length};
}

export async function exportLibraryBackup(payload,{confirm,check,download,stamp,notify}){
  check();
  const result=prepareLibraryBackup(payload);
  if(result.preservationOnly&&!await confirm('仅保存保全副本',`${result.label}备份超过当前导入限制或含不能完整恢复的条目，不能直接完整恢复。可保存全部原内容供后续整理，不会截断或删条。是否下载保全副本？`))return {status:'cancelled'};
  check();
  download(result.blob,`${result.prefix}-${result.preservationOnly?'preservation-':''}${stamp()}.json`);
  notify(result.preservationOnly?`${result.label}保全副本已导出，当前不能直接完整恢复；请保留原文件和本机资料。`:`已导出 ${result.count} 条${result.label}。`,result.preservationOnly?'warning':'success');
  return {status:'exported',preservationOnly:result.preservationOnly};
}
