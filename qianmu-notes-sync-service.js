import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createAccountDocumentFiles} from './qianmu-account-document-files.js';
import {imageServiceAccount,imageServiceAccountStillMatches} from './qianmu-image-service-access.js';
import {NOTES_SYNC_SCHEMA,NOTES_SYNC_LIMITS,notesSyncError,notesSyncMutationId,notesSyncWriteRequest,notesSyncListResponse,notesSyncWriteResponse} from './qianmu-notes-sync-contract.js';

const filename = '.qianmu-notes-sync-v1.json', lockname = '.qianmu-notes-sync-v1.lock';
const sha = text => createHash('sha256').update(text).digest('hex');
const fields = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every(key=>keys.includes(key));
const safeInteger = n => Number.isSafeInteger(n) && n >= 0;
const fail = (code,message,status) => {throw notesSyncError(code,message,status);};
const child = (root,target) => {const relative=path.relative(root,target);return relative!==''&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};

// Only host-authorized account roots; constructing/reading this service creates no files.
export function createNotesSyncService({dataRoot,io=fs,now=Date.now,processStatus}={}) {
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot) || dataRoot.includes('\0')) fail('setup','便笺同步缺少可信的 ST 数据目录',503);
  const root = path.resolve(dataRoot);
  if (root === path.parse(root).root) fail('setup','便笺同步数据目录无效',503);
  const {read,writeAtomic,exclusive}=createAccountDocumentFiles({root,filename,lockname,temporaryPrefix:'.qianmu-notes-sync-write-',bytes:NOTES_SYNC_LIMITS.bytes,errorFactory:notesSyncError,label:'便笺',validate,empty,io,processStatus});
  let closed=false;
  const tails=new Map(), pending=new Set();
  function capture(request,signal) {
    let account;
    try {account=imageServiceAccount(request);} catch (_) {fail('account','请先登录 ST 账户同步便笺',401);}
    const original=request?.user?.directories?.root;
    if (typeof original!=='string'||!path.isAbsolute(original)||original.includes('\0')) fail('path','ST 未提供有效的账户便笺目录',503);
    const folder=path.resolve(original);
    if (!child(root,folder)) fail('path','便笺目录不属于当前 ST 数据范围',403);
    const context={account,folder,roots:new Map(),writeState:'not_started',guard(){
      if(closed||signal?.aborted)fail('closed','便笺同步已中止，未继续处理',409);
      if(!imageServiceAccountStillMatches(request,account)||request.user?.directories?.root!==original)fail('account','ST 账户或目录已变化，请重新打开便笺',401);
    }};
    context.guard();return context;
  }
  function empty(context){return {schema:NOTES_SYNC_SCHEMA,expectedAccount:context.account.namespace,revision:0,notes:[],mutations:[]};}
  function validate(raw,context) {
    if(!fields(raw,['schema','expectedAccount','revision','notes','mutations','checksum'])||raw.schema!==NOTES_SYNC_SCHEMA||raw.expectedAccount!==context.account.namespace
      ||typeof raw.checksum!=='string'||!/^[a-f0-9]{64}$/.test(raw.checksum))fail('corrupt','便笺文件格式或账户不一致，请保留原文件核对',503);
    const {checksum,...state}=raw;
    if(sha(JSON.stringify(state))!==checksum)fail('corrupt','便笺文件校验失败，请保留原文件核对',503);
    notesSyncListResponse({ok:true,version:1,expectedAccount:state.expectedAccount,revision:state.revision,notes:state.notes});
    if(!Array.isArray(state.mutations)||state.mutations.length>NOTES_SYNC_LIMITS.mutations||state.mutations.length!==state.revision)fail('corrupt','便笺保存凭据数量或版本异常',503);
    const ids=new Set(),versions=new Map();
    for(const row of state.mutations){
      if(!fields(row,['mutationId','hash','revision','updatedAt'])||!safeInteger(row.revision)||row.revision<1||row.revision>state.revision
        ||!safeInteger(row.updatedAt)||typeof row.hash!=='string'||!/^[a-f0-9]{64}$/.test(row.hash)||ids.has(row.mutationId)||versions.has(row.revision))fail('corrupt','便笺保存凭据损坏，未覆盖任何正文',503);
      notesSyncMutationId(row.mutationId);ids.add(row.mutationId);versions.set(row.revision,row.updatedAt);
    }
    const currentVersions=new Set();
    for(const note of state.notes){if(versions.get(note.revision)!==note.updatedAt||currentVersions.has(note.revision))fail('corrupt','便笺正文与保存凭据不一致',503);currentVersions.add(note.revision);}
    return state;
  }
  const response = (context,note) => notesSyncWriteResponse({ok:true,version:1,expectedAccount:context.account.namespace,revision:note.revision,note});
  function rowFor(body,revision,updatedAt){return {id:body.id,...(body.deleted?{title:'',body:'',pinned:false,createdAt:body.note.createdAt}:body.note),updatedAt,revision,deleted:body.deleted};}
  function conflict(context,state,note){
    const error=notesSyncError('conflict','此便笺已在另一设备变更，本机内容仍保留');
    error.conflict={ok:false,version:1,code:error.code,message:error.message,writeState:'not_started',expectedAccount:context.account.namespace,revision:state.revision,note:note||null};throw error;
  }
  async function mutate(context,body){
    return exclusive(context,async()=>{
      const {state,fingerprint}=await read(context),hash=sha(JSON.stringify(body)),receipt=state.mutations.find(row=>row.mutationId===body.mutationId);
      if(receipt){if(receipt.hash!==hash)fail('mutation_conflict','便笺操作编号已用于不同内容，未重新保存');return response(context,rowFor(body,receipt.revision,receipt.updatedAt));}
      const previous=state.notes.find(row=>row.id===body.id);
      if((previous?.revision||0)!==body.baseRevision||previous?.deleted)conflict(context,state,previous);
      if(previous&&previous.createdAt!==body.note.createdAt)fail('contract','便笺创建时间不能在更新时更改',400);
      if(!previous&&state.notes.length>=NOTES_SYNC_LIMITS.notes||state.mutations.length>=NOTES_SYNC_LIMITS.mutations)fail('capacity','便笺同步记录已达安全上限，未截断或清理任何内容',507);
      const timestamp=now();if(!safeInteger(timestamp))fail('clock','便笺保存时钟无效，未写入',503);
      const revision=state.revision+1,updatedAt=Math.max(timestamp,(previous?.updatedAt||0)+1);
      if(!Number.isSafeInteger(updatedAt)||!safeInteger(revision))fail('clock','便笺保存时钟或版本无效，未写入',503);
      const note=rowFor(body,revision,updatedAt);
      const next={...state,revision,notes:previous?state.notes.map(row=>row.id===body.id?note:row):[...state.notes,note],
        mutations:[...state.mutations,{mutationId:body.mutationId,hash,revision,updatedAt}]};
      await writeAtomic(context,next,fingerprint);context.guard();return response(context,note);
    });
  }
  function track(request,body,options,write){
    let context,input;
    try{context=capture(request,options?.signal);if(write){input=notesSyncWriteRequest(body);if(input.expectedAccount!==context.account.namespace)fail('account','便笺请求与当前 ST 账户不一致',401);}if(pending.size>=64)fail('busy','便笺同步请求过多，请稍后重试',429);}
    catch(error){return Promise.reject(error);}
    const key=context.account.namespace,prior=tails.get(key)||Promise.resolve();
    const task=prior.catch(()=>{}).then(async()=>{
      try{context.guard();if(write){const result=await mutate(context,input);context.guard();return result;}const {state}=await read(context);context.guard();return notesSyncListResponse({ok:true,version:1,expectedAccount:context.account.namespace,revision:state.revision,notes:state.notes});}
      catch(error){let cause=error;try{context.guard();}catch(changed){cause=changed;}
        const known=String(cause?.code||'').startsWith('notes_sync_')?cause:notesSyncError('storage','便笺储存暂不可用，请保留本机内容并稍后重试',503);known.writeState=context.writeState;throw known;}
    });
    tails.set(key,task);pending.add(task);void task.finally(()=>{pending.delete(task);if(tails.get(key)===task)tails.delete(key);}).catch(()=>{});return task;
  }
  return Object.freeze({list:(request,options)=>track(request,null,options,false),write:(request,input,options)=>track(request,input,options,true),
    async close(){closed=true;await Promise.allSettled([...pending]);}});
}
