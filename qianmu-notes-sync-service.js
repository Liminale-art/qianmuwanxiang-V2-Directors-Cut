import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {imageServiceAccount,imageServiceAccountStillMatches} from './qianmu-image-service-access.js';
import {NOTES_SYNC_SCHEMA,NOTES_SYNC_LIMITS,notesSyncError,notesSyncMutationId,notesSyncWriteRequest,notesSyncListResponse,notesSyncWriteResponse} from './qianmu-notes-sync-contract.js';

const filename = '.qianmu-notes-sync-v1.json', lockname = '.qianmu-notes-sync-v1.lock';
const sha = text => createHash('sha256').update(text).digest('hex');
const fields = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every(key=>keys.includes(key));
const sameFile = (a,b) => a?.ino > 0n && a?.dev >= 0n && a.ino === b?.ino && a.dev === b?.dev;
const sameVersion = (a,b) => sameFile(a,b) && a.size === b.size && a.mtimeNs === b.mtimeNs;
const safeInteger = n => Number.isSafeInteger(n) && n >= 0;
const fail = (code,message,status) => {throw notesSyncError(code,message,status);};
const child = (root,target) => {const relative=path.relative(root,target);return relative!==''&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
const localProcessStatus = pid => {try{process.kill(pid,0);return 'alive';}catch(error){return error?.code==='ESRCH'?'dead':'unknown';}};

// Only host-authorized account roots; constructing/reading this service creates no files.
export function createNotesSyncService({dataRoot,io=fs,now=Date.now,processStatus=localProcessStatus}={}) {
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot) || dataRoot.includes('\0')) fail('setup','便笺同步缺少可信的 ST 数据目录',503);
  const root = path.resolve(dataRoot);
  if (root === path.parse(root).root) fail('setup','便笺同步数据目录无效',503);
  let closed=false;
  const tails=new Map(), pending=new Set(), stat=file=>io.lstat(file,{bigint:true});
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
  async function checkedRoots(context,authorize=true) {
    if(authorize)context.guard();let cursor=root;
    const directories=[cursor];for(const segment of path.relative(root,context.folder).split(path.sep)){cursor=path.join(cursor,segment);directories.push(cursor);}
    for(const directory of directories){
      const before=await stat(directory),prior=context.roots.get(directory);
      if(!before.isDirectory()||before.isSymbolicLink()||path.resolve(await io.realpath(directory))!==directory||prior&&!sameFile(before,prior))fail('path','便笺目录为链接或已变化，未继续操作',409);
      context.roots.set(directory,before);if(authorize)context.guard();
    }
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
  async function read(context) {
    await checkedRoots(context);const target=path.join(context.folder,filename);let before;
    try{before=await stat(target);}catch(error){if(error?.code==='ENOENT'){await checkedRoots(context);return {state:empty(context),fingerprint:null};}throw error;}
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size<1n||before.size>BigInt(NOTES_SYNC_LIMITS.bytes))fail('corrupt','便笺文件为链接、非常规文件或超出安全读取上限，未覆盖',503);
    const handle=await io.open(target,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    try{
      const opened=await handle.stat({bigint:true});if(!sameVersion(before,opened)||opened.nlink!==1n)fail('changed','便笺在读取时已变化，请重新同步');
      const buffer=Buffer.alloc(Number(opened.size)+1);let length=0;
      while(length<buffer.length){context.guard();const result=await handle.read(buffer,length,buffer.length-length,length);if(!result.bytesRead)break;length+=result.bytesRead;}
      const after=await handle.stat({bigint:true}),current=await stat(target);
      if(BigInt(length)!==opened.size||!sameVersion(opened,after)||!sameVersion(after,current)||!current.isFile()||current.isSymbolicLink()||current.nlink!==1n)fail('changed','便笺在核对期间已变化，请重新同步');
      let raw;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,length)));}catch(_){fail('corrupt','便笺文件无法完整读取，请保留原文件核对',503);}
      let state;try{state=validate(raw,context);}catch(error){if(error?.code==='notes_sync_contract')fail('corrupt','便笺文件内容或保存凭据损坏，未覆盖原文件',503);throw error;}
      await checkedRoots(context);return {state,fingerprint:current};
    }finally{await handle.close();}
  }
  async function syncFolder(context){if(process.platform==='win32')return;const handle=await io.open(context.folder,'r');try{await handle.sync();}finally{await handle.close();}}
  async function targetUnchanged(context,prior){
    const target=path.join(context.folder,filename);let current;
    try{current=await stat(target);}catch(error){if(error?.code==='ENOENT'&&!prior)return;throw error;}
    if(!prior||!sameVersion(current,prior)||!current.isFile()||current.isSymbolicLink()||current.nlink!==1n)fail('changed','便笺已由其他操作更改，未覆盖');
  }
  async function writeAtomic(context,state,prior){
    const json=JSON.stringify(state),body=JSON.stringify({...state,checksum:sha(json)});
    if(Buffer.byteLength(body)>NOTES_SYNC_LIMITS.bytes)fail('capacity','便笺同步库已达安全容量上限，未截断或清理任何内容',507);
    const temporary=path.join(context.folder,`.qianmu-notes-sync-write-${randomUUID()}.tmp`);let handle,identity,renamed=false;
    try{
      await checkedRoots(context);handle=await io.open(temporary,'wx',0o600);identity=await handle.stat({bigint:true});
      await handle.writeFile(body);await handle.sync();identity=await handle.stat({bigint:true});await handle.close();handle=null;
      await checkedRoots(context);await targetUnchanged(context,prior);
      const staged=await stat(temporary);
      if(!sameVersion(identity,staged)||!staged.isFile()||staged.isSymbolicLink()||staged.nlink!==1n)fail('changed','待保存便笺文件已变化，未替换原文',503);
      context.guard();
      context.writeState='unconfirmed';await io.rename(temporary,path.join(context.folder,filename));renamed=true;await syncFolder(context);
      const confirmed=await read(context);
      if(JSON.stringify(confirmed.state)!==json)fail('changed','便笺写入尚未确认，请保留本机内容后重试',503);
    }finally{
      if(handle)await handle.close();
      if(identity&&!renamed){
        await checkedRoots(context,false);
        try{const current=await stat(temporary);if(!sameFile(identity,current)||!current.isFile()||current.isSymbolicLink()||current.nlink!==1n)fail('path','便笺临时文件发生变化，未清理',503);await io.unlink(temporary);}
        catch(error){if(error?.code!=='ENOENT')throw error;}
      }
    }
  }
  async function occupiedLock(context,file){
    // Do not auto-unlink even a dead PID: stat+unlink is not an atomic identity-conditional delete.
    // Another ST process could replace the lock between those calls. Preserve originals and report the precise condition.
    await checkedRoots(context);let before;
    try{before=await stat(file);}catch(error){if(error?.code==='ENOENT')fail('busy','便笺保存锁刚刚变化，请重新同步',423);throw error;}
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>512n)fail('lock_unverifiable','便笺保存锁异常，已保留原文；请由服务器管理员核对后恢复',503);
    if(before.size===0n)fail('busy','便笺保存锁正在初始化或曾异常中断；如持续不可用，请核对服务器保存锁',423);
    const handle=await io.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    try{
      const opened=await handle.stat({bigint:true});if(!sameVersion(before,opened)||opened.nlink!==1n)fail('busy','便笺保存锁正在变化，请重新同步',423);
      const buffer=Buffer.alloc(513);let length=0;
      while(length<buffer.length){context.guard();const chunk=await handle.read(buffer,length,buffer.length-length,length);if(!chunk.bytesRead)break;length+=chunk.bytesRead;}
      let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,length)));}catch(_){fail('lock_unverifiable','便笺保存锁无法识别，已保留原文；请由服务器管理员核对后恢复',503);}
      if(BigInt(length)!==opened.size||!fields(value,['version','owner','pid'])||value.version!==1||typeof value.owner!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.owner)
        ||!Number.isSafeInteger(value.pid)||value.pid<1||value.pid>0x7fffffff)fail('lock_unverifiable','便笺保存锁格式未知，已保留原文；请由服务器管理员核对后恢复',503);
      const status=await processStatus(value.pid),after=await handle.stat({bigint:true}),current=await stat(file);
      await checkedRoots(context);
      if(!sameVersion(opened,after)||!sameVersion(after,current)||!current.isFile()||current.isSymbolicLink()||current.nlink!==1n)fail('busy','便笺保存锁已变化，未自动清理，请重新同步',423);
      if(status==='dead')fail('stale_lock','检测到上次中断留下的便笺保存锁；已保留原文，请由服务器管理员核对后恢复',503);
      if(status!=='alive')fail('lock_unverifiable','无法确认便笺保存进程状态，已保留原文；请由服务器管理员核对后恢复',503);
      fail('busy','便笺正在其他设备保存，请稍后重试',423);
    }finally{await handle.close();}
  }
  async function exclusive(context,operation){
    await checkedRoots(context);const file=path.join(context.folder,lockname);let handle,identity;
    try{handle=await io.open(file,'wx',0o600);}catch(error){if(error?.code==='EEXIST')return occupiedLock(context,file);throw error;}
    try{identity=await handle.stat({bigint:true});await handle.writeFile(JSON.stringify({version:1,owner:randomUUID(),pid:process.pid}));return await operation();}
    finally{
      await handle.close();await checkedRoots(context,false);const current=await stat(file);
      if(!sameFile(identity,current)||!current.isFile()||current.isSymbolicLink()||current.nlink!==1n)fail('path','便笺保存锁发生变化，请保留文件核对',503);
      await io.unlink(file);
    }
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
