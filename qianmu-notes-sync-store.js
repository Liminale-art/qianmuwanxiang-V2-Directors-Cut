// Account-scoped durable notes and outbox. Never opens or migrates the legacy notes database.
import {NOTES_SYNC_LIMITS,notesSyncNoteInput} from './qianmu-notes-sync-contract.js';
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

export function createNotesSyncStore({indexedDB=globalThis.indexedDB,dbName='qianmu-notes-sync',timeoutMs=8000}={}) {
  let database=null,opening=null,closed=false;const pending=new Set(),timeout=Math.max(100,Math.min(30000,Number(timeoutMs)||8000));
  const check=guard=>{if(closed)throw notesLocalError('closed','便笺会话已关闭');if(guard()===false)throw notesLocalError('account','便笺账户已变化');};
  function open(){
    if(closed)return Promise.reject(notesLocalError('closed','便笺会话已关闭'));
    if(database)return Promise.resolve(database);if(opening)return opening;
    const attempt=new Promise((resolve,reject)=>{
      let request,done=false;const finish=(error,db)=>{if(done){db?.close();return;}done=true;clearTimeout(timer);error?reject(error):resolve(db);};
      const timer=setTimeout(()=>finish(notesLocalError('timeout','本机便笺打开超时')),timeout);
      try{request=indexedDB.open(dbName,1);}catch(_){finish(notesLocalError('storage','本机便笺储存不可用，未降级为易丢失的临时保存'));return;}
      request.onupgradeneeded=()=>{if(done||closed){request.transaction?.abort();return;}request.result.createObjectStore('accounts',{keyPath:'namespace'});};
      request.onblocked=()=>finish(notesLocalError('storage','便笺库被旧页面占用，请关闭后重试'));
      request.onerror=()=>finish(notesLocalError('storage','本机便笺打开失败'));
      request.onsuccess=()=>{const db=request.result;if(done||closed){db.close();finish(notesLocalError('closed','便笺会话已关闭'));return;}
        database=db;db.onversionchange=()=>{db.close();if(database===db){database=null;opening=null;}};db.onclose=()=>{if(database===db){database=null;opening=null;}};finish(null,db);};
    });opening=attempt;void attempt.catch(()=>{if(opening===attempt)opening=null;});return attempt;
  }
  async function access(namespace,mutator,{guard=()=>true}={}){
    notesLocalNamespace(namespace);check(guard);const db=await open();check(guard);
    return new Promise((resolve,reject)=>{
      let tx,done=false,result,failure;const finish=error=>{if(done)return;done=true;clearTimeout(timer);pending.delete(tx);error?reject(error):resolve(result);};
      const abort=error=>{failure=error;try{tx?.abort();}catch(_){finish(error);}};
      const timer=setTimeout(()=>{const error=notesLocalError('timeout','便笺保存结果尚未确认，请保留编辑内容并重读');abort(error);finish(error);},timeout);
      try{tx=db.transaction('accounts',mutator?'readwrite':'readonly');pending.add(tx);}catch(_){finish(notesLocalError('storage','便笺储存暂不可用'));return;}
      tx.oncomplete=()=>{try{check(guard);finish();}catch(error){finish(error);}};
      tx.onabort=()=>finish(failure||notesLocalError('storage','便笺操作未完成，原内容保留'));
      tx.onerror=()=>{failure ||= notesLocalError('storage','本机便笺保存失败，可能空间不足');};
      const store=tx.objectStore('accounts'),request=store.get(namespace);
      request.onsuccess=()=>{try{check(guard);const state=validateNotesLocalState(request.result||emptyNotesLocalState(namespace),namespace);
        if(mutator){const returned=mutator(state);if(returned?.then)throw notesLocalError('storage','便笺事务不能等待网络');validateNotesLocalState(state,namespace);check(guard);store.put(state);}
        result=structuredClone(state);
      }catch(error){abort(error);}};
    });
  }
  return Object.freeze({read:(namespace,options)=>access(namespace,null,options),update:(namespace,mutator,options)=>{
    if(typeof mutator!=='function')return Promise.reject(notesLocalError('storage','缺少便笺事务'));return access(namespace,mutator,options);
  },close(){closed=true;for(const tx of pending)try{tx.abort();}catch(_){}database?.close();database=null;opening=null;}});
}
