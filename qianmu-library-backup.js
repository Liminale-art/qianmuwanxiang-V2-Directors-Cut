// Original-file library formats. Keep import admission and export warnings aligned.
export const NOTES_BACKUP_LIMITS=Object.freeze({bytes:12*1024*1024,entries:1000});
export const FAVORITES_BACKUP_LIMITS=Object.freeze({bytes:256*1024*1024,entries:2000,encodedBytes:64*1024*1024,audioBytes:48*1024*1024});

export function prepareLibraryBackup(payload){
  const notes=payload?.type==='qianmu-notes',favorites=payload?.type==='qianmu-tts-favorites';
  const rows=notes?payload.notes:payload?.entries,limits=notes?NOTES_BACKUP_LIMITS:FAVORITES_BACKUP_LIMITS;
  if((!notes&&!favorites)||payload.version!==1||!Array.isArray(rows))throw Error('备份格式无效，未导出。');
  const blob=new Blob([JSON.stringify(payload)],{type:'application/json'});
  const preservationOnly=blob.size>limits.bytes||rows.length>limits.entries||favorites&&rows.some(row=>typeof row?.data!=='string'||row.data.length>limits.encodedBytes);
  return {blob,preservationOnly,label:notes?'固定便笺':'语音收藏',prefix:notes?'qianmu-notes':'qianmu-语音收藏',count:rows.length};
}

export async function exportLibraryBackup(payload,{confirm,check,download,stamp,notify}){
  check();
  const result=prepareLibraryBackup(payload);
  if(result.preservationOnly&&!await confirm('仅保存保全副本',`${result.label}备份超过当前导入的体积或条数限制，不能直接完整恢复。可保存全部原内容供后续整理，不会截断或删条。是否下载保全副本？`))return {status:'cancelled'};
  check();
  download(result.blob,`${result.prefix}-${result.preservationOnly?'preservation-':''}${stamp()}.json`);
  notify(result.preservationOnly?`${result.label}保全副本已导出，当前不能直接完整恢复；请保留原文件和本机资料。`:`已导出 ${result.count} 条${result.label}。`,result.preservationOnly?'warning':'success');
  return {status:'exported',preservationOnly:result.preservationOnly};
}
