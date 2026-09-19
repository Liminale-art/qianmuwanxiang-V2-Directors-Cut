// Account-scoped durable notes and outbox. Never opens or migrates the legacy notes database.
import {NOTES_SYNC_LIMITS,notesSyncNoteInput} from './qianmu-notes-sync-contract.js';
import {createAccountLocalStore} from './qianmu-account-local-store.js';
export const NOTES_LOCAL_LIMITS = Object.freeze({rows:NOTES_SYNC_LIMITS.notes*2,bytes:NOTES_SYNC_LIMITS.bytes*3,receipts:1000});
export const notesLocalError = (code,message) => Object.assign(new Error(message),{code:`notes_sync_${code}`});
export function notesLocalNamespace(value) {
  if(typeof value!=='string'||!/^st-user:.+/.test(value)||value.length>512||/[\u0000-\u001f\u007f]/.test(value))throw notesLocalError('account','尚未确认便笺账户');
  return value;
}
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const text=(value,limit,empty=true)=>typeof value==='string'&&(empty||value.length>0)&&Array.from(value).length<=limit;
export function notesLocalContent(value) {
  if(!plain(value)||!text(value.id,120,false)||value.id.trim()!==value.id||/[\u0000-\u001f\u007f]/.test(value.id)
    ||!text(value.title,120)||!text(value.body,20000)||typeof value.pinned!=='boolean'||!integer(value.createdAt)||!integer(value.updatedAt))throw notesLocalError('content','便笺内容或时间无效，未截断或覆盖原文');
  if(new TextDecoder().decode(new TextEncoder().encode(value.id))!==value.id)throw notesLocalError('content','便笺编号含非法字符');
  return {id:value.id,...notesSyncNoteInput({title:value.title,body:value.body,pinned:value.pinned,createdAt:value.createdAt}),updatedAt:value.updatedAt};
}
export function notesLocalGeometry(value={}) {
  const out={floating:false,minimized:false,x:24,y:96,width:280,height:220,zOrder:1};
  for(const field of ['floating','minimized'])if(typeof value[field]==='boolean')out[field]=value[field];
  for(const [field,min,max] of [['x',0,100000],['y',0,100000],['width',220,520],['height',120,620],['zOrder',1,1000000]])
    if(Number.isFinite(value[field]))out[field]=Math.min(max,Math.max(min,value[field]));
  return out;
}
export function validateNotesLocalState(value,namespace) {
  notesLocalNamespace(namespace);
  if(!plain(value)||value.namespace!==namespace||value.version!==1||!Array.isArray(value.rows)||value.rows.length>NOTES_LOCAL_LIMITS.rows
    ||!Array.isArray(value.receipts)||value.receipts.length>NOTES_LOCAL_LIMITS.receipts||!integer(value.serverRevision))throw notesLocalError('storage','本机便笺资料结构异常，未覆盖');
  const ids=new Set();
  for(const row of value.rows){
    if(!plain(row)||row.namespace!==namespace||row.id!==row.note?.id||ids.has(row.id)||!integer(row.generation)||row.generation<1
      ||!integer(row.remoteRevision)||typeof row.deleted!=='boolean'||!text(row.writer,120,false)||!plain(row.geometry)
      ||(row.conflictOf!==null&&!text(row.conflictOf,120,false)))throw notesLocalError('storage','本机便笺编号或版本异常，未覆盖');
    notesLocalContent(row.note);ids.add(row.id);
    if(JSON.stringify(notesLocalGeometry(row.geometry))!==JSON.stringify(row.geometry))throw notesLocalError('storage','本机便笺窗口位置异常，未覆盖');
    if(row.pending!==null){const p=row.pending;
      if(!plain(p)||!integer(p.baseRevision)||!integer(p.generation)||p.generation<1||p.generation>row.generation||typeof p.deleted!=='boolean'||typeof p.started!=='boolean'
        ||!text(p.mutationId,120,false)||!/^[A-Za-z0-9_-]{8,120}$/.test(p.mutationId)||p.note?.id!==row.id)throw notesLocalError('storage','本机便笺待同步记录异常，未覆盖');
      notesLocalContent(p.note);
    }
  }
  if(new Set(value.receipts).size!==value.receipts.length||value.receipts.some(receipt=>!text(receipt,180,false)))throw notesLocalError('storage','便笺迁移回执异常');
  if(new TextEncoder().encode(JSON.stringify(value)).byteLength>NOTES_LOCAL_LIMITS.bytes)throw notesLocalError('capacity','本机便笺空间达到安全上限，原内容保留');
  return value;
}
export function emptyNotesLocalState(namespace){return {version:1,namespace:notesLocalNamespace(namespace),rows:[],receipts:[],serverRevision:0};}

// Logical UTF-8 bytes, not browser allocation or server disk usage. No prose leaves this projection.
export function summarizeNotesLocalState(state) {
  validateNotesLocalState(state, state?.namespace);
  const live = state.rows.filter(row => !row.deleted);
  return Object.freeze({ status: 'ready', namespace: state.namespace,
    count: live.length, pinned: live.filter(row => row.note.pinned).length,
    pending: state.rows.filter(row => row.pending).length, deleted: state.rows.length - live.length,
    bytes: state.rows.length || state.receipts.length || state.serverRevision ? new TextEncoder().encode(JSON.stringify(state)).byteLength : 0,
    estimated: true, scope: 'current-account-local',
  });
}

export function createNotesSyncStore({indexedDB=globalThis.indexedDB,dbName='qianmu-notes-sync',timeoutMs=8000}={}) {
  return createAccountLocalStore({indexedDB,dbName,timeoutMs,validateNamespace:notesLocalNamespace,validate:validateNotesLocalState,empty:emptyNotesLocalState,error:notesLocalError,label:'便笺'});
}
