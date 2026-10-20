import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createAccountDocumentFiles} from './qianmu-account-document-files.js';
import {parseBoundedJson} from './qianmu-json-input.js';
import {createChatBackupHost} from './qianmu-chat-backup-host.js';

const MIB=1024*1024,MINUTE=60000,DAY=24*60*MINUTE,DIR='qianmu-chat-backups';
export const CHAT_BACKUP_LIMITS=Object.freeze({fileBytes:16*MIB,roundBytes:256*MIB,files:20000,folders:5000,versions:20000,roundMs:30000,diskReserveBytes:64*MIB});
export const CHAT_BACKUP_RETENTION_DAYS=Object.freeze([3,7,15,30]);
export const DEFAULT_CHAT_BACKUP_RETENTION_DAYS=30;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA=/^[a-f0-9]{64}$/;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const object=value=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const name=value=>typeof value==='string'&&value.length>0&&value.length<=1024&&!/[\x00-\x1f\x7f/\\]/.test(value)&&value!=='.'&&value!=='..';
const child=(root,target)=>{const relative=path.relative(root,target);return relative!==''&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
const sameFile=(a,b)=>a?.ino>0n&&a.dev>=0n&&a.ino===b?.ino&&a.dev===b.dev;
const unchanged=(a,b)=>sameFile(a,b)&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs&&b.nlink===1n&&b.isFile()&&!b.isSymbolicLink();
const exact=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const number=value=>Number.isSafeInteger(value)&&value>=0;
const iso=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(Date.parse(value)).toISOString()===value;
export const chatBackupError=(code,message,status=409)=>Object.assign(new Error(message),{code:'chat_backup_'+code,status});
const fail=(code,message,status)=>{throw chatBackupError(code,message,status);};
const result=()=>({created:0,unchanged:0,skipped:0});
const known=error=>String(error?.code||'').startsWith('chat_backup_')?error:chatBackupError('storage','自动备份存储暂不可用，已有聊天和备份保持不变',503);
const empty=namespace=>({version:1,expectedAccount:namespace,enabled:false,intervalMinutes:30,limitMiB:1024,maxVersionsPerChat:0,retentionDays:DEFAULT_CHAT_BACKUP_RETENTION_DAYS,lastRunAt:null,lastSuccessAt:null,nextRunAt:null,lastResult:result()});

function parseChat(bytes) {
  let text;
  try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{fail('format','聊天编码异常，已跳过而未改写原件');}
  const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/);
  if(lines.at(-1)==='')lines.pop();
  if(lines.length<2)fail('empty','检测到空聊天，已保留此前的非空备份');
  if(lines.length>50001)fail('file_limit','聊天条目超过单份核对上限，未截断备份');
  for(let index=0;index<lines.length;index++) {
    let row;
    try{row=parseBoundedJson(lines[index],{maxBytes:CHAT_BACKUP_LIMITS.fileBytes,maxDepth:60,maxNodes:500000,label:'聊天'});}catch{fail('format','聊天结构异常，已跳过而未改写原件');}
    if(!object(row)||index===0&&(!object(row.chat_metadata)||Object.hasOwn(row,'mes'))||index>0&&typeof row.mes!=='string')fail('format','聊天结构异常，已跳过而未改写原件');
  }
  return {text,messageCount:lines.length-1};
}

function validateConfig(raw,context) {
  const keys=['version','expectedAccount','enabled','intervalMinutes','limitMiB','lastRunAt','lastSuccessAt','nextRunAt','lastResult','checksum'];
  const hasCount=object(raw)&&Object.hasOwn(raw,'maxVersionsPerChat');if(hasCount)keys.push('maxVersionsPerChat');
  const hasRetention=object(raw)&&Object.hasOwn(raw,'retentionDays');if(hasRetention)keys.push('retentionDays');
  if(!exact(raw,keys)||raw.version!==1||raw.expectedAccount!==context.namespace||typeof raw.enabled!=='boolean'
    ||!Number.isInteger(raw.intervalMinutes)||raw.intervalMinutes<15||raw.intervalMinutes>1440
    ||!Number.isInteger(raw.limitMiB)||raw.limitMiB<256||raw.limitMiB>10240
    ||hasCount&&(!Number.isInteger(raw.maxVersionsPerChat)||raw.maxVersionsPerChat<0||raw.maxVersionsPerChat>20000)
    ||hasRetention&&!CHAT_BACKUP_RETENTION_DAYS.includes(raw.retentionDays)
    ||![raw.lastRunAt,raw.lastSuccessAt,raw.nextRunAt].every(value=>value===null||number(value))
    ||!object(raw.lastResult)||!['created','unchanged','skipped'].every(key=>number(raw.lastResult[key]))
    ||Object.keys(raw.lastResult).some(key=>!['created','unchanged','skipped','error'].includes(key))
    ||raw.lastResult.error!==undefined&&(typeof raw.lastResult.error!=='string'||raw.lastResult.error.length>300))fail('corrupt','自动备份配置损坏，未覆盖配置或旧备份',503);
  const {checksum,...state}=raw;
  if(typeof checksum!=='string'||checksum!==hash(JSON.stringify(state)))fail('corrupt','自动备份配置校验失败，未覆盖配置或旧备份',503);
  // Verify the original schema-1 bytes/field order before adding new defaults.
  // Existing installations retain their previous version policy while adopting
  // the bounded default retention policy on the next atomic config write.
  return {...state,
    ...(hasCount?null:{maxVersionsPerChat:0}),
    ...(hasRetention?null:{retentionDays:DEFAULT_CHAT_BACKUP_RETENTION_DAYS}),
  };
}

function validateEntry(raw,namespace,id) {
  if(!exact(raw,['version','expectedAccount','id','avatar','chatFile','createdAt','messageCount','sizeBytes','sha256'])||raw.version!==1||raw.expectedAccount!==namespace
    ||raw.id!==id||!UUID.test(id)||!name(raw.avatar)||!raw.avatar.endsWith('.png')||!name(raw.chatFile)||!raw.chatFile.endsWith('.jsonl')
    ||!iso(raw.createdAt)||!number(raw.messageCount)||raw.messageCount<1||!number(raw.sizeBytes)||raw.sizeBytes<1||raw.sizeBytes>CHAT_BACKUP_LIMITS.fileBytes
    ||!SHA.test(raw.sha256))fail('corrupt','备份索引无法核对，已保留原件，请稍后核查',503);
  const {version,expectedAccount,...entry}=raw;return entry;
}

// The service reads complete on-disk chats. It never receives chat text from a browser.
export function createChatBackupService({dataRoot,accounts,hostDirectory=process.cwd(),io=fs,now=Date.now,timers=globalThis,limits={},processStatus}={}) {
  if(typeof dataRoot!=='string'||!path.isAbsolute(dataRoot)||dataRoot.includes('\0')||path.resolve(dataRoot)===path.parse(dataRoot).root||typeof accounts!=='function')fail('host','自动备份缺少可信的 ST 账户目录',503);
  if(typeof hostDirectory!=='string'||!path.isAbsolute(hostDirectory))fail('host','自动备份缺少可信的 ST 安装目录',503);
  const root=path.resolve(dataRoot),workingDirectory=path.resolve(hostDirectory),limit={...CHAT_BACKUP_LIMITS,...limits};
  if(Object.values(limit).some(value=>!Number.isSafeInteger(value)||value<1))throw TypeError('Invalid backup resource limits');
  let closed=false,started=false,timer=null,running=null,scheduleEpoch=0;
  const tails=new Map(),pending=new Set(),diagnostics=new Map(),retryAfter=new Map();
  const docs=createAccountDocumentFiles({root,filename:'.settings-v1.json',lockname:'.operation.lock',temporaryPrefix:'.settings-write-',bytes:16384,errorFactory:chatBackupError,label:'自动备份',
    validate:validateConfig,empty:context=>empty(context.namespace),io,processStatus});
  const time=()=>{const value=now();if(!number(value))fail('clock','服务器时钟异常，自动备份已暂停',503);return value;};
  const guard=()=>{if(closed)fail('closed','自动备份服务已停止',503);};
  async function hosts() {
    guard();let rows;try{rows=await accounts();}catch{fail('host','当前 ST 无法核对后台账户，自动备份已暂停',503);}
    if(!Array.isArray(rows)||rows.length>1000)fail('host','当前 ST 账户目录无法可靠核对',503);
    const seen=new Set();
    return rows.filter(row=>row?.profile?.enabled!==false).map(row=>{
      const handle=row?.profile?.handle,folder=row?.directories?.root,chats=row?.directories?.chats,characters=row?.directories?.characters;
      if(!name(handle)||seen.has(handle)||typeof folder!=='string'||typeof chats!=='string'||!path.isAbsolute(folder)||!path.isAbsolute(chats))fail('host','当前 ST 账户目录无法可靠核对',503);
      seen.add(handle);const ownerRoot=path.resolve(folder),chatRoot=path.resolve(chats);
      if(!child(root,ownerRoot)||!child(ownerRoot,chatRoot))fail('path','自动备份账户目录超出可信范围',403);
      const characterRoot=characters===undefined?null:typeof characters==='string'&&path.isAbsolute(characters)?path.resolve(characters):null;
      if(characters!==undefined&&(!characterRoot||!child(ownerRoot,characterRoot)))fail('path','角色目录超出可信账户范围',403);
      return {handle,namespace:'st-user:'+handle,ownerRoot,chatRoot,characterRoot};
    });
  }
  function context(owner,request=null) {
    const user=request?.user,originalRoot=user?.directories?.root,originalChats=user?.directories?.chats;
    const value={...owner,folder:path.join(owner.ownerRoot,DIR),roots:new Map(),writeState:'not_started',guard(){
      guard();if(request&&(request.user!==user||user?.profile?.handle!==owner.handle||user.profile.enabled===false||user?.directories?.root!==originalRoot||user?.directories?.chats!==originalChats))fail('account','ST 账户或目录已变化，请重新打开聊天找回',401);
    }};return value;
  }
  async function capture(request,input,extra=[]) {
    if(!object(input)||Object.keys(input).some(key=>!['expectedAccount',...extra].includes(key)))fail('contract','自动备份请求格式无效',400);
    const user=request?.user,handle=user?.profile?.handle;
    if(!name(handle)||user.profile.enabled===false||input.expectedAccount!=='st-user:'+handle)fail('account','ST 账户已变化，请重新打开聊天找回',401);
    const owner=(await hosts()).find(row=>row.handle===handle);
    if(!owner||typeof user?.directories?.root!=='string'||typeof user?.directories?.chats!=='string'
      ||path.resolve(workingDirectory,user.directories.root)!==owner.ownerRoot||path.resolve(workingDirectory,user.directories.chats)!==owner.chatRoot)fail('account','当前账户不能访问这些聊天备份',403);
    const c=context(owner,request);await directories(c,owner.ownerRoot);c.guard();return c;
  }
  async function authorize(c) {
    c.guard();const owner=(await hosts()).find(row=>row.handle===c.handle);
    if(!owner||owner.ownerRoot!==c.ownerRoot||owner.chatRoot!==c.chatRoot||owner.characterRoot!==c.characterRoot)fail('account','账户已停用或目录已变化，自动备份已停止',403);
    await directories(c,c.ownerRoot);c.guard();
  }
  async function directories(c,target) {
    if(target!==root&&!child(root,target))fail('path','备份目录不在可信范围',403);
    let cursor=root;const folders=[root];for(const part of path.relative(root,target).split(path.sep).filter(Boolean)){cursor=path.join(cursor,part);folders.push(cursor);}
    for(const folder of folders) {
      c.guard();const stat=await io.lstat(folder,{bigint:true}),previous=c.roots.get(folder);
      if(!stat.isDirectory()||stat.isSymbolicLink()||path.resolve(await io.realpath(folder))!==folder||previous&&!sameFile(previous,stat))fail('path','聊天或备份目录为链接或已变化，已停止处理',409);
      c.roots.set(folder,stat);
    }
  }
  async function ensure(c) {
    await authorize(c);
    try{await io.mkdir(c.folder,{mode:0o700});}catch(error){if(error?.code!=='EEXIST')throw error;}
    await directories(c,c.folder);
  }
  async function hasFolder(c) {
    try{await directories(c,c.folder);return true;}catch(error){if(error?.code==='ENOENT')return false;throw error;}
  }
  async function config(c) {return await hasFolder(c)?docs.read(c):{state:empty(c.namespace),fingerprint:null};}
  async function readBytes(c,file,max) {
    await directories(c,path.dirname(file));const before=await io.lstat(file,{bigint:true});
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n)fail('path','文件为链接或非常规文件，已跳过而未改写');
    if(before.size<1n||before.size>BigInt(max))fail('file_limit','文件为空或超过核对上限，未截断备份');
    const handle=await io.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    try {
      const opened=await handle.stat({bigint:true});if(!unchanged(before,opened))fail('changed','聊天读取前发生变化，已跳过本轮');
      const bytes=Buffer.alloc(Number(opened.size)+1);let length=0;
      while(length<bytes.length){c.guard();const part=await handle.read(bytes,length,bytes.length-length,length);if(!part.bytesRead)break;length+=part.bytesRead;}
      const after=await handle.stat({bigint:true}),current=await io.lstat(file,{bigint:true});
      if(BigInt(length)!==opened.size||!unchanged(opened,after)||!unchanged(after,current))fail('changed','聊天读取期间发生变化，已跳过本轮');
      await directories(c,path.dirname(file));return {bytes:bytes.subarray(0,length),stat:current};
    }finally{await handle.close();}
  }
  async function inventory(c) {
    if(!await hasFolder(c))return {entries:[],usedBytes:0};
    const entries=[];let usedBytes=0,count=0;const files=await io.opendir(c.folder),names=new Set();
    try{for await(const item of files){c.guard();if(++count>limit.versions*2+100)fail('capacity','备份数量达到核对上限，未清理或截断旧备份',507);
      const file=path.join(c.folder,item.name),stat=await io.lstat(file,{bigint:true});
      if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n)fail('path','备份目录含链接或异常文件，未继续处理',409);
      usedBytes+=Number(stat.size);if(!Number.isSafeInteger(usedBytes))fail('capacity','备份占用超过安全核对范围',507);
      names.add(item.name);
      if(!/^[a-f0-9-]+\.json$/.test(item.name)||!UUID.test(item.name.slice(0,-5)))continue;
      const id=item.name.slice(0,-5),{bytes}=await readBytes(c,file,8192);let raw;
      try{raw=parseBoundedJson(bytes.toString('utf8'),{maxBytes:8192,maxDepth:4,maxNodes:100,label:'备份索引'});}catch{fail('corrupt','备份索引损坏，已保留原件',503);}
      entries.push(validateEntry(raw,c.namespace,id));
    }}finally{try{await files.close();}catch(error){if(error?.code!=='ERR_DIR_CLOSED')throw error;}}
    if(entries.length>limit.versions)fail('capacity','备份数量达到核对上限，未删除任何旧备份',507);
    for(const entry of entries)if(!names.has(entry.id+'.jsonl'))fail('corrupt','备份正文缺失，未将索引当作完整备份',503);
    entries.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));
    return {entries,usedBytes};
  }
  async function disk(c,needed=0) {
    if(typeof io.statfs!=='function')fail('disk_unknown','无法核实服务器剩余空间，自动备份已暂停',503);
    let stats;try{stats=await io.statfs(c.folder,{bigint:true});}catch{fail('disk_unknown','无法核实服务器剩余空间，自动备份已暂停',503);}
    if(typeof stats.bavail!=='bigint'||typeof stats.bsize!=='bigint'||stats.bavail<0n||stats.bsize<1n)fail('disk_unknown','无法核实服务器剩余空间，自动备份已暂停',503);
    if(stats.bavail*stats.bsize<BigInt(limit.diskReserveBytes+needed))fail('disk_full','服务器剩余空间不足，已暂停新备份并保留全部旧备份',507);
  }
  async function syncFolder(c) {if(process.platform==='win32')return;const handle=await io.open(c.folder,'r');try{await handle.sync();}finally{await handle.close();}}
  async function createFile(c,file,bytes) {
    await directories(c,c.folder);c.guard();const handle=await io.open(file,'wx',0o600);
    try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
    const saved=await readBytes(c,file,bytes.length);if(!saved.bytes.equals(bytes))fail('verify','备份写入尚未确认，已保留文件而未覆盖原件',503);
  }
  const sourceKey=entry=>entry.avatar+'\0'+entry.chatFile;
  async function checkedEntry(c,entry) {
    const metadata=await readBytes(c,path.join(c.folder,entry.id+'.json'),8192);
    let raw;try{raw=parseBoundedJson(metadata.bytes.toString('utf8'),{maxBytes:8192,maxDepth:4,maxNodes:100,label:'备份索引'});}catch{fail('corrupt','备份索引损坏，未轮换旧备份',503);}
    if(JSON.stringify(validateEntry(raw,c.namespace,entry.id))!==JSON.stringify(entry))fail('changed','旧备份索引已变化，未轮换旧备份');
    c.chargeBackupRead?.(entry.sizeBytes);
    const data=await readBytes(c,path.join(c.folder,entry.id+'.jsonl'),limit.fileBytes),parsed=parseChat(data.bytes);
    if(hash(data.bytes)!==entry.sha256||data.bytes.length!==entry.sizeBytes||parsed.messageCount!==entry.messageCount)fail('verify','旧备份内容校验失败，未轮换旧备份',503);
    return {entry,metadata,data,bytes:metadata.bytes.length+data.bytes.length};
  }
  const compactVersion=checked=>({entry:checked.entry,bytes:checked.bytes,
    metadata:{stat:checked.metadata.stat,length:checked.metadata.bytes.length,sha256:hash(checked.metadata.bytes)},
    data:{stat:checked.data.stat,length:checked.data.bytes.length,sha256:hash(checked.data.bytes)}});
  async function stableSource(c,source) {
    await directories(c,path.dirname(source.path));const current=await io.lstat(source.path,{bigint:true});
    if(!unchanged(source.stat,current))fail('changed','聊天在轮换前发生变化，已保留旧备份');
  }
  async function rotationSource(c,entry,source) {
    if(sourceKey(entry)===sourceKey(source))return source;
    const directory=entry.avatar.replace('.png',''),matches=c.avatarMap?.get(directory)||[];
    if(!name(directory)||matches.length>1||matches.length===1&&matches[0]!==entry.avatar||!matches.length&&directory+'.png'!==entry.avatar)return null;
    const file=path.join(c.chatRoot,directory,entry.chatFile);
    try {
      const stat=await io.lstat(file,{bigint:true});c.chargeRotationRead?.(stat.size);
      const saved=await readBytes(c,file,limit.fileBytes);parseChat(saved.bytes);
      return {path:file,avatar:entry.avatar,chatFile:entry.chatFile,stat:saved.stat};
    }catch(error){
      if(['account','closed','path','scan_limit'].some(code=>error?.code==='chat_backup_'+code))throw error;
      // A missing/empty/broken/racing source must not lose its older history just
      // because a different chat needs capacity. Unknown reads are not eligibility.
      return null;
    }
  }
  async function rotationPlan(c,store,keeper,newBytes,state,source) {
    const key=sourceKey(keeper),budget=state.limitMiB*MIB,counts=new Map(),sources=new Map([[key,source]]);
    const entries=store.entries.some(entry=>entry.id===keeper.id)?store.entries:[...store.entries,keeper];
    for(const entry of entries)counts.set(sourceKey(entry),(counts.get(sourceKey(entry))||0)+1);
    const plan=[],selected=new Set(),oldest=[...store.entries].reverse();let projected=store.usedBytes+newBytes+16384;
    async function select(entry) {
      const entryKey=sourceKey(entry);
      if(selected.has(entry.id)||entry.id===keeper.id||counts.get(entryKey)<=1)return false;
      if(!sources.has(entryKey))sources.set(entryKey,await rotationSource(c,entry,source));
      const live=sources.get(entryKey);if(!live)return false;
      const checked=compactVersion(await checkedEntry(c,entry));plan.push({...checked,source:live});selected.add(entry.id);projected-=checked.bytes;counts.set(entryKey,counts.get(entryKey)-1);return true;
    }
    // Time retention is evaluated before the byte/count caps. The oldest
    // verified copy of each source is kept even when it is beyond the window,
    // so a quiet or deleted chat can still be recovered. A source that cannot
    // be matched to its current native chat is not eligible for deletion.
    const cutoff=time()-state.retentionDays*DAY;
    for(const entry of oldest) {
      if(Date.parse(entry.createdAt)>=cutoff)break;
      await select(entry);
    }
    // Count is per exact source, not per character. Only this round's verified
    // source converges its count; unvisited or empty sources keep their history.
    if(state.maxVersionsPerChat>0)for(const entry of oldest) {
      if(counts.get(key)<=state.maxVersionsPerChat)break;
      if(sourceKey(entry)===key)await select(entry);
    }
    // Then satisfy the byte cap, without selecting any count victim twice.
    if(projected>budget)for(const entry of oldest) {
      await select(entry);if(projected<=budget)break;
    }
    if(projected>budget)fail('capacity','保留每份聊天的最新完整备份后仍超过空间上限，请提高上限；旧备份未删除',507);
    return plan;
  }
  async function rotate(c,plan,newEntry,source) {
    if(!plan.length)return;
    await authorize(c);const store=await inventory(c),present=new Map(store.entries.map(entry=>[entry.id,entry]));
    if(!present.has(newEntry.id))fail('verify','新备份尚未确认，旧备份未删除',503);
    await checkedEntry(c,present.get(newEntry.id));
    const removed=new Set(plan.map(row=>row.entry.id)),remaining=store.entries.filter(entry=>!removed.has(entry.id)),sources=new Set(store.entries.map(sourceKey));
    for(const key of sources)if(!remaining.some(entry=>sourceKey(entry)===key))fail('changed','备份保留关系已变化，未轮换旧备份');
    // Verify every planned version and at least one surviving version of every
    // affected source before deleting any. Several index entries are not proof
    // that even one complete readable copy remains.
    for(const key of sources) {
      const survivors=remaining.filter(entry=>sourceKey(entry)===key);
      let healthy=false;
      for(const survivor of survivors){try{await checkedEntry(c,survivor);healthy=true;break;}catch(error){if(['chat_backup_account','chat_backup_closed','chat_backup_path','chat_backup_scan_limit'].includes(error?.code))throw error;}}
      if(!healthy)fail('verify','无法确认每份聊天仍有完整备份，未轮换旧备份',503);
    }
    const verified=[];
    for(const prior of plan) {
      const entry=present.get(prior.entry.id);
      if(!entry||JSON.stringify(entry)!==JSON.stringify(prior.entry))fail('changed','备份列表已变化，未轮换旧备份');
      const current=compactVersion(await checkedEntry(c,entry));
      if(!unchanged(prior.metadata.stat,current.metadata.stat)||!unchanged(prior.data.stat,current.data.stat))fail('changed','旧备份文件已变化，未轮换旧备份');
      verified.push(current);
    }
    // Reserve the complete quarantine read-back budget before moving/deleting
    // even the first file; do not discover a budget limit halfway through cleanup.
    c.chargeBackupRead?.(verified.reduce((bytes,row)=>bytes+row.bytes,0));
    await authorize(c);await directories(c,c.folder);
    const sourcesToCheck=new Map([[sourceKey(source),source]]);for(const row of plan)sourcesToCheck.set(sourceKey(row.source),row.source);
    for(const live of sourcesToCheck.values())await stableSource(c,live);
    for(const row of verified) {
      // Move only our exact UUID files into a unique quarantine name first. A late
      // replacement is preserved there, never deleted on the strength of old stats.
      for(const [extension,expected] of [['json',row.metadata],['jsonl',row.data]]) {
        c.guard();await authorize(c);for(const live of sourcesToCheck.values())await stableSource(c,live);
        const source=path.join(c.folder,row.entry.id+'.'+extension);
        const current=await io.lstat(source,{bigint:true});if(!unchanged(expected.stat,current))fail('changed','轮换前文件已变化，已停止清理并保留新旧备份');
        const quarantine=path.join(c.folder,'.retired-'+row.entry.id+'-'+randomUUID()+'.'+extension);
        await io.rename(source,quarantine);
        const moved=await readBytes(c,quarantine,expected.length);
        if(!sameFile(expected.stat,moved.stat)||moved.bytes.length!==expected.length||hash(moved.bytes)!==expected.sha256)fail('changed','轮换期间文件已变化，已保留隔离文件而未删除');
        await authorize(c);await directories(c,c.folder);const final=await io.lstat(quarantine,{bigint:true});
        if(!unchanged(moved.stat,final))fail('changed','待清理文件已变化，已保留隔离文件');
        await io.unlink(quarantine);
      }
    }
    await syncFolder(c);
  }
  async function snapshot(c,source,state,store) {
    const {bytes,stat}=await readBytes(c,source.path,limit.fileBytes),digest=hash(bytes),parsed=parseChat(bytes);
    const live={...source,stat};
    const previous=store.entries.find(entry=>entry.avatar===source.avatar&&entry.chatFile===source.chatFile);
    if(previous?.sha256===digest){
      await checkedEntry(c,previous);
      const plan=await rotationPlan(c,store,previous,0,state,live);
      await rotate(c,plan,previous,live);
      if(plan.length){const refreshed=await inventory(c);store.entries=refreshed.entries;store.usedBytes=refreshed.usedBytes;}
      return {unchanged:true,bytes:bytes.length};
    }
    if(store.entries.length>=limit.versions)fail('capacity','备份数量达到安全上限，已停止新增，未清理旧备份',507);
    const id=randomUUID(),entry={id,avatar:source.avatar,chatFile:source.chatFile,createdAt:new Date(time()).toISOString(),messageCount:parsed.messageCount,sizeBytes:bytes.length,sha256:digest};
    const metadata=Buffer.from(JSON.stringify({version:1,expectedAccount:c.namespace,...entry}));
    const plan=await rotationPlan(c,store,entry,bytes.length+metadata.length,state,live);
    await disk(c,bytes.length+metadata.length+16384);await authorize(c);await directories(c,path.dirname(source.path));
    const latest=await io.lstat(source.path,{bigint:true});if(!unchanged(stat,latest))fail('changed','聊天在备份前发生变化，已跳过本轮');
    await createFile(c,path.join(c.folder,id+'.jsonl'),bytes);
    await authorize(c);
    // The small immutable descriptor is the commit marker. An interrupted raw copy
    // remains on disk and counts toward capacity, but is never presented as verified.
    await createFile(c,path.join(c.folder,id+'.json'),metadata);await syncFolder(c);
    await checkedEntry(c,entry);await rotate(c,plan,entry,live);
    if(plan.length){const refreshed=await inventory(c);store.entries=refreshed.entries;store.usedBytes=refreshed.usedBytes;}
    else{store.entries.unshift(entry);store.usedBytes+=bytes.length+metadata.length;}
    return {unchanged:false,bytes:bytes.length};
  }
  async function avatars(c) {
    const map=new Map();if(!c.characterRoot)return map;
    await directories(c,c.characterRoot);const files=await io.opendir(c.characterRoot);let count=0;
    try{for await(const file of files){
      c.guard();if(++count>limit.folders)fail('scan_limit','角色文件数量超过本轮扫描上限，部分聊天未检查');
      if(!file.name.endsWith('.png')||!name(file.name)||!file.isFile()||file.isSymbolicLink())continue;
      const key=file.name.replace('.png',''),matches=map.get(key)||[];matches.push(file.name);map.set(key,matches);
    }}finally{try{await files.close();}catch(error){if(error?.code!=='ERR_DIR_CLOSED')throw error;}}
    await directories(c,c.characterRoot);return map;
  }
  async function perform(c,at) {
    await authorize(c);if(!await hasFolder(c))return;
    return docs.exclusive(c,async()=>{
      const prior=await docs.read(c),state=prior.state;if(!state.enabled||state.nextRunAt!==null&&state.nextRunAt>at)return;
      const outcome=result(),startedAt=time();let store,readCount=0,folderCount=0,bytes=0;
      try {
        store=await inventory(c);await disk(c);await directories(c,c.chatRoot);const aliases=await avatars(c);c.avatarMap=aliases;
        c.chargeRotationRead=size=>{
          if(++readCount>limit.files||size>BigInt(limit.roundBytes-bytes)||time()-startedAt>=limit.roundMs)fail('scan_limit','本轮轮换核对达到安全上限，未截断或删除未核对的备份');
          bytes+=Number(size);
        };
        c.chargeBackupRead=size=>{
          if(size>limit.roundBytes-bytes||time()-startedAt>=limit.roundMs)fail('scan_limit','本轮备份校验达到安全上限，未轮换未完成核对的旧备份');
          bytes+=size;
        };
        const folders=await io.opendir(c.chatRoot);
        try{for await(const directory of folders){
          c.guard();if(++folderCount>limit.folders)fail('scan_limit','角色数量超过本轮扫描上限，部分聊天未检查');
          const folder=path.join(c.chatRoot,directory.name),stat=await io.lstat(folder,{bigint:true});
          if(!stat.isDirectory()||stat.isSymbolicLink()||!name(directory.name)){outcome.skipped++;outcome.error||='有无法安全核对的角色目录，已跳过';continue;}
          const matches=aliases.get(directory.name)||[],fallback=directory.name+'.png';
          if(matches.length>1||!matches.length&&fallback.replace('.png','')!==directory.name){outcome.skipped++;outcome.error||='有角色文件名对应不唯一或无法核对，已跳过';continue;}
          const avatar=matches[0]||fallback;
          await directories(c,folder);const files=await io.opendir(folder);
          try{for await(const item of files){
            if(!item.name.endsWith('.jsonl'))continue;
            if(++readCount>limit.files||bytes>=limit.roundBytes||time()-startedAt>=limit.roundMs)fail('scan_limit','本轮扫描达到安全上限，部分聊天未检查');
            if(!name(item.name)){outcome.skipped++;continue;}
            try {
              const size=await io.lstat(path.join(folder,item.name),{bigint:true});
              if(size.size>BigInt(limit.roundBytes-bytes))fail('scan_limit','本轮读取达到安全上限，部分聊天未检查');
              bytes+=Number(size.size);
              const saved=await snapshot(c,{path:path.join(folder,item.name),avatar,chatFile:item.name},state,store);
              if(saved.unchanged)outcome.unchanged++;else outcome.created++;
            }catch(error){const failure=known(error);outcome.skipped++;outcome.error||=failure.message;if(['capacity','disk_full','disk_unknown','account','closed','scan_limit'].some(code=>failure.code==='chat_backup_'+code))throw failure;}
          }}finally{try{await files.close();}catch(error){if(error?.code!=='ERR_DIR_CLOSED')throw error;}}
        }}finally{try{await folders.close();}catch(error){if(error?.code!=='ERR_DIR_CLOSED')throw error;}}
      }catch(error){outcome.error=known(error).message;}
      const ended=time(),next={...state,lastRunAt:startedAt,lastSuccessAt:outcome.error||outcome.skipped?state.lastSuccessAt:ended,nextRunAt:ended+state.intervalMinutes*MINUTE,lastResult:outcome};
      await authorize(c);await docs.writeAtomic(c,next,prior.fingerprint);diagnostics.delete(c.namespace);
      return next;
    });
  }
  function serial(namespace,operation) {
    if(pending.size>=64)return Promise.reject(chatBackupError('busy','备份请求较多，请稍后再试',429));
    const task=(tails.get(namespace)||Promise.resolve()).catch(()=>{}).then(operation);tails.set(namespace,task);pending.add(task);
    void task.finally(()=>{pending.delete(task);if(tails.get(namespace)===task)tails.delete(namespace);}).catch(()=>{});return task;
  }
  function clearTimer(){if(timer!==null){timers.clearTimeout(timer);timer=null;}}
  async function schedule() {
    if(closed||!started)return;const epoch=++scheduleEpoch;clearTimer();let due=Infinity;
    try{for(const owner of await hosts()){const c=context(owner);try{const {state}=await config(c);if(state.enabled)due=Math.min(due,Math.max(state.nextRunAt??time(),retryAfter.get(owner.namespace)||0));}catch(error){diagnostics.set(owner.namespace,known(error).message);due=Math.min(due,Math.max(retryAfter.get(owner.namespace)||0,time()+MINUTE));}}}catch{due=time()+MINUTE;}
    if(closed||epoch!==scheduleEpoch||!Number.isFinite(due))return;
    timer=timers.setTimeout(()=>{timer=null;void run().catch(()=>{});},Math.max(0,Math.min(due-time(),2147483647)));timer?.unref?.();
  }
  async function run(at=time()) {
    guard();if(!number(at))fail('clock','备份调度时钟无效',503);if(running)return running;
    const task=(async()=>{try{for(const owner of await hosts()){if(closed)break;if((retryAfter.get(owner.namespace)||0)>at)continue;
      await serial(owner.namespace,()=>perform(context(owner),at)).then(()=>retryAfter.delete(owner.namespace)).catch(error=>{diagnostics.set(owner.namespace,known(error).message);retryAfter.set(owner.namespace,time()+MINUTE);});}}
      finally{await schedule();}})();
    running=task;try{return await task;}finally{if(running===task)running=null;}
  }
  async function start(){guard();if(started)return;started=true;await schedule();}
  async function statusFor(c) {
    const [{state},store]=await Promise.all([config(c),inventory(c)]);await authorize(c);
    const {expectedAccount,...response}=state;return {ok:true,...response,retention:'rotate-oldest-keep-one',usedBytes:store.usedBytes,lastResult:diagnostics.has(c.namespace)?{...state.lastResult,error:diagnostics.get(c.namespace)}:state.lastResult};
  }
  async function status(req,input){const c=await capture(req,input);return serial(c.namespace,()=>statusFor(c));}
  async function configure(req,input) {
    const c=await capture(req,input,['enabled','intervalMinutes','limitMiB','maxVersionsPerChat','retentionDays']);
    const hasCount=Object.hasOwn(input,'maxVersionsPerChat');
    const hasRetention=Object.hasOwn(input,'retentionDays');
    if(typeof input.enabled!=='boolean'||!Number.isInteger(input.intervalMinutes)||input.intervalMinutes<15||input.intervalMinutes>1440
      ||!Number.isInteger(input.limitMiB)||input.limitMiB<256||input.limitMiB>10240
      ||hasCount&&(!Number.isInteger(input.maxVersionsPerChat)||input.maxVersionsPerChat<0||input.maxVersionsPerChat>20000)
      ||hasRetention&&!CHAT_BACKUP_RETENTION_DAYS.includes(input.retentionDays))fail('contract','备份间隔须为 15–1440 整数分钟，空间上限须为 256–10240 MiB，每份聊天保留份数须为 0–20000 的整数（0 为不限），保留周期须为 3、7、15 或 30 天',400);
    const response=await serial(c.namespace,async()=>{
      await ensure(c);if(input.enabled)await disk(c,16384);
      await docs.exclusive(c,async()=>{const prior=await docs.read(c),state=prior.state;
        const maxVersionsPerChat=hasCount?input.maxVersionsPerChat:state.maxVersionsPerChat;
        const retentionDays=hasRetention?input.retentionDays:state.retentionDays;
        const changed=state.enabled!==input.enabled||state.intervalMinutes!==input.intervalMinutes||state.limitMiB!==input.limitMiB||state.maxVersionsPerChat!==maxVersionsPerChat||state.retentionDays!==retentionDays;
        if(!changed)return;
        const next={...state,enabled:input.enabled,intervalMinutes:input.intervalMinutes,limitMiB:input.limitMiB,maxVersionsPerChat,retentionDays,
          nextRunAt:input.enabled?state.enabled&&state.intervalMinutes===input.intervalMinutes?(state.nextRunAt??time()):time():null};
        await authorize(c);await docs.writeAtomic(c,next,prior.fingerprint);diagnostics.delete(c.namespace);retryAfter.delete(c.namespace);
      });return statusFor(c);
    });
    started=true;await schedule();return response;
  }
  async function list(req,input){const c=await capture(req,input);return serial(c.namespace,async()=>{const data=await inventory(c);await authorize(c);return {ok:true,version:1,entries:data.entries};});}
  async function read(req,input){const c=await capture(req,input,['id']);if(!UUID.test(input.id||''))fail('contract','备份编号无效',400);
    return serial(c.namespace,async()=>{const store=await inventory(c),entry=store.entries.find(row=>row.id===input.id);if(!entry)fail('missing','这份备份不存在于当前账户',404);
      const {bytes}=await readBytes(c,path.join(c.folder,entry.id+'.jsonl'),limit.fileBytes),parsed=parseChat(bytes);
      if(bytes.length!==entry.sizeBytes||hash(bytes)!==entry.sha256||parsed.messageCount!==entry.messageCount)fail('verify','备份正文与索引不一致，未用于找回',503);
      await authorize(c);return {text:parsed.text};
    });
  }
  async function close(){closed=true;scheduleEpoch++;clearTimer();await Promise.allSettled([...pending,...(running?[running]:[])]);}
  return Object.freeze({start,status,configure,list,read,run,close});
}

export function installChatBackupRoutes(router,{dataRoot,hostDirectory,register=()=>{},serviceOptions={}}={}) {
  let service,closing=false;
  const ready=(async()=>{
    const accounts=serviceOptions.accounts||await createChatBackupHost({hostDirectory});
    if(closing)throw chatBackupError('closed','自动备份服务已停止',503);
    service=createChatBackupService({...serviceOptions,dataRoot:typeof dataRoot==='function'?dataRoot():dataRoot,hostDirectory:hostDirectory||serviceOptions.hostDirectory||process.cwd(),accounts});
    await service.start();return service;
  })();
  // Readiness failure is isolated from all unrelated enhanced-service routes.
  void ready.catch(()=>{});register({async close(){closing=true;try{await ready;}catch{}await service?.close();}});
  for(const method of ['status','configure','list','read'])router.post('/chat-backups/'+method,async(req,res)=>{
    res.set('Cache-Control','no-store');res.set('X-Content-Type-Options','nosniff');
    try{const current=await ready,value=await current[method](req,req.body);if(res.destroyed||res.writableEnded)return;
      if(method==='read'){res.type('text/plain; charset=utf-8');return res.send(value.text);}return res.json(value);
    }catch(error){const failure=known(error);if(!res.destroyed&&!res.writableEnded)return res.status(failure.status).json({ok:false,version:1,code:failure.code,message:failure.message});}
  });
  return ready;
}
