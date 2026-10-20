import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {createChatBackupService,installChatBackupRoutes} from '../qianmu-chat-backup-service.js';
import {createChatBackupHost} from '../qianmu-chat-backup-host.js';

const MIB=1024*1024;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const input=(name='alice',patch={})=>({expectedAccount:'st-user:'+name,...patch});
const configure=(patch={})=>input('alice',{enabled:true,intervalMinutes:30,limitMiB:1024,...patch});
const chat=(text='original',extra={})=>'\uFEFF'+[
  {user_name:'unused',character_name:'unused',chat_metadata:{integrity:'untouched',unknownPlugin:{nested:[1,'保全']},story_director_liminale:{keep:true},...extra}},
  {name:'角色',mes:text,is_user:false,swipes:['one','two'],extra:{unknown:'keep'}},
].map(row=>JSON.stringify(row)).join('\r\n')+'\r\n';
function clock() {
  let value=1900000000000,sequence=0;const scheduled=new Map();
  return {now:()=>value,set:value0=>{value=value0;},scheduled,timers:{setTimeout(fn,ms){const id=++sequence;scheduled.set(id,{fn,at:value+ms});return id;},clearTimeout(id){scheduled.delete(id);}},
    async fire(){const next=[...scheduled].sort((a,b)=>a[1].at-b[1].at)[0];if(!next)return;value=next[1].at;scheduled.delete(next[0]);next[1].fn();await new Promise(resolve=>setImmediate(resolve));}};
}
async function fixture(t,options={}) {
  const parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'qianmu-chat-backup-test-')),users=[],services=[],time=clock();
  async function add(handle){const owner=path.join(root,handle),chats=path.join(owner,'chats'),native=path.join(owner,'backups');await fs.mkdir(chats,{recursive:true});await fs.mkdir(native);
    const user={profile:{handle,enabled:true},directories:{root:owner,chats}};users.push(user);return {user,req:{user},owner,chats,native,backup:path.join(owner,'qianmu-chat-backups')};}
  const alice=await add('alice'),accounts=async()=>users.filter(user=>user.profile.enabled);
  const make=extra=>{const service=createChatBackupService({dataRoot:root,accounts,now:time.now,timers:time.timers,...options,...extra});services.push(service);return service;};
  const service=make();
  const write=async(text=chat(),character='角色1',filename='session.jsonl',person=alice)=>{const directory=path.join(person.chats,character);await fs.mkdir(directory,{recursive:true});const file=path.join(directory,filename);await fs.writeFile(file,text);return file;};
  t.after(async()=>{await Promise.all(services.map(service=>service.close()));const real=await fs.realpath(root);assert.equal(path.dirname(real),parent);assert.match(path.basename(real),/^qianmu-chat-backup-test-/);await fs.rm(real,{recursive:true});});
  return {...alice,root,users,service,make,add,write,time};
}
async function first(f,text=chat()){const file=await f.write(text);await f.service.configure(f.req,configure());await f.service.run();return file;}
async function next(f,text,filename='session.jsonl'){await f.write(text,'角色1',filename);f.time.set(f.time.now()+31*60000);await f.service.run();}

test('disabled status and bootstrap create no folders, no copies, and no browser dependency',async t=>{
  const f=await fixture(t);await f.write();await f.service.start();const state=await f.service.status(f.req,input());
  assert.equal(state.enabled,false);assert.equal(state.intervalMinutes,30);assert.equal(state.limitMiB,1024);assert.equal(state.maxVersionsPerChat,0);assert.equal(state.retention,'rotate-oldest-keep-one');assert.equal(state.usedBytes,0);
  assert.deepEqual(await fs.readdir(f.owner),['backups','chats']);assert.equal(f.time.scheduled.size,0);
});
test('first opt-in snapshots all single chats as byte-identical copies and keeps originals/native backups untouched',async t=>{
  const f=await fixture(t),one=await f.write(chat('one')),two=await f.write(chat('two'),'另一个','second.jsonl');
  await fs.writeFile(path.join(f.native,'chat_existing.jsonl'),'native original');
  const before=[await fs.readFile(one),await fs.readFile(two)];await f.service.configure(f.req,configure());assert.equal(f.time.scheduled.size,1);await f.service.run();
  const list=await f.service.list(f.req,input());assert.equal(list.entries.length,2);assert.equal((await f.service.status(f.req,input())).lastResult.created,2);
  for(const entry of list.entries){const raw=await fs.readFile(path.join(f.backup,entry.id+'.jsonl'));assert.equal(sha(raw),entry.sha256);assert.equal(entry.messageCount,1);assert.equal(Buffer.from((await f.service.read(f.req,input('alice',{id:entry.id}))).text).equals(raw),true);}
  assert.deepEqual(await fs.readFile(one),before[0]);assert.deepEqual(await fs.readFile(two),before[1]);assert.equal(await fs.readFile(path.join(f.native,'chat_existing.jsonl'),'utf8'),'native original');
});
test('only changed bytes create another version and the most recent list sorts by snapshot time',async t=>{
  const f=await fixture(t);await first(f);f.time.set(f.time.now()+31*60000);await f.service.run();assert.equal((await f.service.list(f.req,input())).entries.length,1);assert.equal((await f.service.status(f.req,input())).lastResult.unchanged,1);
  await next(f,chat('new',{anotherUnknown:{content:['untouched']}}));const entries=(await f.service.list(f.req,input())).entries;assert.equal(entries.length,2);assert.ok(entries[0].createdAt>entries[1].createdAt);assert.match((await f.service.read(f.req,input('alice',{id:entries[0].id}))).text,/anotherUnknown/);
});
test('service restart restores opt-in schedule without an HTTP request or open page',async t=>{
  const f=await fixture(t);await first(f);await f.service.close();assert.equal(f.time.scheduled.size,0);await f.write(chat('after restart'));
  const restarted=f.make();await restarted.start();assert.equal(f.time.scheduled.size,1);await f.time.fire();await restarted.run();
  assert.equal((await restarted.list(f.req,input())).entries.length,2);assert.equal((await restarted.status(f.req,input())).lastResult.created,1);
});
test('disable cancels next tick and re-enabling runs once without creating missed-time history',async t=>{
  const f=await fixture(t);await first(f);await f.service.configure(f.req,configure({enabled:false}));assert.equal(f.time.scheduled.size,0);
  f.time.set(f.time.now()+365*24*60*60000);await f.write(chat('long afterward'));await f.service.run();assert.equal((await f.service.list(f.req,input())).entries.length,1);
  await f.service.configure(f.req,configure());await f.service.run();const entries=await f.service.list(f.req,input());assert.equal(entries.entries.length,1);
  assert.match((await f.service.read(f.req,input('alice',{id:entries.entries[0].id}))).text,/long afterward/);
});
test('account boundaries reject forged handles/paths and native account revocation stops the scheduler',async t=>{
  const f=await fixture(t);await first(f);const bob=await f.add('bob');await f.write(chat('bob'),'角色1','session.jsonl',bob);
  await assert.rejects(f.service.status(f.req,input('bob')),{status:401});await assert.rejects(f.service.status(f.req,{...input(),path:f.root}),{status:400});
  assert.deepEqual((await f.service.list(bob.req,input('bob'))).entries,[]);const aliceId=(await f.service.list(f.req,input())).entries[0].id;
  await assert.rejects(f.service.read(bob.req,input('bob',{id:aliceId})),{status:404});f.user.profile.enabled=false;f.time.set(f.time.now()+31*60000);await f.service.run();assert.equal(f.time.scheduled.size,0);
  await assert.rejects(f.service.status(f.req,input()),{status:401});
});
test('invalid interval or capacity never creates storage',async t=>{
  const f=await fixture(t);
  for(const patch of [{intervalMinutes:14},{intervalMinutes:15.5},{intervalMinutes:NaN},{intervalMinutes:1441},{limitMiB:255},{limitMiB:10241},{enabled:'true'},{namespace:'alice'}])await assert.rejects(f.service.configure(f.req,configure(patch)),{status:400});
  assert.deepEqual(await fs.readdir(f.owner),['backups','chats']);await f.service.configure(f.req,configure({intervalMinutes:15,limitMiB:256}));assert.equal((await f.service.status(f.req,input())).intervalMinutes,15);
});

test('invalid count limits are rejected before storage is created, while both inclusive boundaries are accepted',async t=>{
  const f=await fixture(t);
  for(const maxVersionsPerChat of [-1,0.5,20001,NaN,Infinity,'2',null,undefined])await assert.rejects(f.service.configure(f.req,configure({maxVersionsPerChat})),{status:400});
  assert.deepEqual(await fs.readdir(f.owner),['backups','chats']);
  for(const maxVersionsPerChat of [0,20000])assert.equal((await f.service.configure(f.req,configure({maxVersionsPerChat}))).maxVersionsPerChat,maxVersionsPerChat);
});

test('retention policy accepts only fixed day windows and reports the bounded default',async t=>{
  const f=await fixture(t);assert.equal((await f.service.status(f.req,input())).retentionDays,30);
  for(const retentionDays of [0,1,2,4,6,8,14,16,29,31,90,-1,1.5,NaN,Infinity,'7',null,undefined])
    await assert.rejects(f.service.configure(f.req,configure({retentionDays})),{status:400});
  for(const retentionDays of [3,7,15,30])assert.equal((await f.service.configure(f.req,configure({retentionDays}))).retentionDays,retentionDays);
});

test('legacy schema-1 configuration validates its original checksum and restarts as unlimited without a browser',async t=>{
  const f=await fixture(t);await first(f);await f.service.close();
  const file=path.join(f.backup,'.settings-v1.json'),current=JSON.parse(await fs.readFile(file,'utf8'));
  const legacy={lastResult:current.lastResult,nextRunAt:current.nextRunAt,expectedAccount:current.expectedAccount,version:1,
    lastSuccessAt:current.lastSuccessAt,lastRunAt:current.lastRunAt,limitMiB:current.limitMiB,intervalMinutes:current.intervalMinutes,enabled:true};
  await fs.writeFile(file,JSON.stringify({...legacy,checksum:sha(JSON.stringify(legacy))}));
  await f.write(chat('changed while closed'));const restarted=f.make();await restarted.start();assert.equal(f.time.scheduled.size,1);
  assert.equal((await restarted.status(f.req,input())).maxVersionsPerChat,0);await f.time.fire();await restarted.run();
  assert.equal((await restarted.list(f.req,input())).entries.length,2);
  const {checksum,...upgraded}=JSON.parse(await fs.readFile(file,'utf8'));assert.equal(upgraded.maxVersionsPerChat,0);assert.equal(checksum,sha(JSON.stringify(upgraded)));
  assert.equal(upgraded.retentionDays,30);
  await restarted.close();const again=f.make();await again.start();assert.equal((await again.status(f.req,input())).maxVersionsPerChat,0);
});

test('old configure requests preserve a count setting across changes, disable/re-enable, and process restart',async t=>{
  const f=await fixture(t);await f.write();await f.service.configure(f.req,configure({maxVersionsPerChat:3}));await f.service.run();
  for(const patch of [{intervalMinutes:60},{enabled:false},{enabled:true,limitMiB:512}])assert.equal((await f.service.configure(f.req,configure(patch))).maxVersionsPerChat,3);
  await f.service.close();const restarted=f.make();await restarted.start();assert.equal((await restarted.status(f.req,input())).maxVersionsPerChat,3);
  assert.equal((await restarted.configure(f.req,configure({intervalMinutes:15}))).maxVersionsPerChat,3);
});

test('unlimited, one-version, and multi-version retention keep precisely the latest valid versions',async t=>{
  for(const maximum of [0,1,2])await t.test(String(maximum),async t0=>{
    const f=await fixture(t0);await f.write(chat('v1'));await f.service.configure(f.req,configure({maxVersionsPerChat:maximum}));await f.service.run();
    for(const version of ['v2','v3','v4'])await next(f,chat(version));
    const entries=(await f.service.list(f.req,input())).entries;assert.equal(entries.length,maximum||4);
    for(let index=0;index<entries.length;index++)assert.equal((await f.service.read(f.req,input('alice',{id:entries[index].id}))).text,chat('v'+(4-index)));
    assert.equal((await f.service.status(f.req,input())).lastResult.error,undefined);
  });
});

test('reducing the count setting does not delete during configure and converges on the next unchanged round',async t=>{
  const f=await fixture(t);await first(f,chat('v1'));await next(f,chat('v2'));await next(f,chat('v3'));await next(f,chat('v4'));
  const before=(await f.service.list(f.req,input())).entries;await f.service.configure(f.req,configure({maxVersionsPerChat:2}));
  assert.deepEqual((await f.service.list(f.req,input())).entries,before);await f.service.run();assert.equal((await f.service.list(f.req,input())).entries.length,4);
  f.time.set(f.time.now()+31*60000);await f.service.run();const after=(await f.service.list(f.req,input())).entries;
  assert.deepEqual(after,before.slice(0,2));const status=await f.service.status(f.req,input());assert.equal(status.lastResult.created,0);assert.equal(status.lastResult.unchanged,1);assert.equal(status.lastResult.error,undefined);
});

test('different chat files under one avatar have independent count limits',async t=>{
  const f=await fixture(t);await f.service.configure(f.req,configure({maxVersionsPerChat:2}));
  for(const version of [1,2,3]){
    await f.write(chat('a'+version),'角色1','a.jsonl');await f.write(chat('b'+version),'角色1','b.jsonl');await f.service.run();f.time.set(f.time.now()+31*60000);
  }
  const entries=(await f.service.list(f.req,input())).entries;assert.equal(entries.length,4);
  for(const file of ['a.jsonl','b.jsonl'])assert.equal(entries.filter(entry=>entry.chatFile===file&&entry.avatar==='角色1.png').length,2);
});

test('retention removes expired versions while preserving the newest valid copy per chat',async t=>{
  const f=await fixture(t);await f.write(chat('day zero'));await f.service.configure(f.req,configure({retentionDays:3}));await f.service.run();
  f.time.set(f.time.now()+2*24*60*60000);await f.write(chat('day two'));await f.service.run();
  assert.equal((await f.service.list(f.req,input())).entries.length,2);
  f.time.set(f.time.now()+2*24*60*60000+31*60000);await f.write(chat('day four'));await f.service.run();
  const entries=(await f.service.list(f.req,input())).entries;assert.equal(entries.length,2);
  assert.deepEqual(entries.map(entry=>entry.messageCount),[1,1]);
  const texts=await Promise.all(entries.map(entry=>f.service.read(f.req,input('alice',{id:entry.id})).then(value=>value.text)));
  assert.ok(texts.some(text=>text.includes('day two')));assert.ok(texts.some(text=>text.includes('day four')));
});

test('retention never removes the sole copy of an expired chat',async t=>{
  const f=await fixture(t);await f.write(chat('old'));await f.service.configure(f.req,configure({retentionDays:3}));await f.service.run();
  f.time.set(f.time.now()+10*24*60*60000+31*60000);await f.service.run();
  const entries=(await f.service.list(f.req,input())).entries;assert.equal(entries.length,1);
  assert.match((await f.service.read(f.req,input('alice',{id:entries[0].id}))).text,/old/);
});

test('unknown configure-write result retains the count setting and never deletes versions itself',async t=>{
  let failAfter=false;const f=await fixture(t,{io:{...fs,rename:async(from,to)=>{await fs.rename(from,to);if(failAfter&&String(to).endsWith('.settings-v1.json')){failAfter=false;throw Object.assign(Error('ack lost'),{code:'EIO'});}}}});
  await first(f);await next(f,chat('v2'));const before=(await f.service.list(f.req,input())).entries;
  failAfter=true;await assert.rejects(f.service.configure(f.req,configure({maxVersionsPerChat:1})));
  assert.equal((await f.service.status(f.req,input())).maxVersionsPerChat,1);assert.deepEqual((await f.service.list(f.req,input())).entries,before);
});

test('count cleanup stops explicitly before deletion if bounded verification cannot finish the whole plan',async t=>{
  const f=await fixture(t);await first(f,chat('a'.repeat(1000)));await next(f,chat('b'.repeat(1000)));await next(f,chat('c'.repeat(1000)));
  await f.service.configure(f.req,configure({maxVersionsPerChat:1}));const before=(await f.service.list(f.req,input())).entries;await f.service.close();
  const bounded=f.make({limits:{roundBytes:6000}});f.time.set(f.time.now()+31*60000);await bounded.run();
  assert.deepEqual((await bounded.list(f.req,input())).entries,before);assert.match((await bounded.status(f.req,input())).lastResult.error,/上限/);
});

test('the whole quarantine re-read budget is reserved before the first retirement, not midway through deletion',async t=>{
  const f=await fixture(t);await first(f,chat('a'.repeat(1000)));await next(f,chat('b'.repeat(1000)));await next(f,chat('c'.repeat(1000)));
  await f.service.configure(f.req,configure({maxVersionsPerChat:1}));const before=(await f.service.list(f.req,input())).entries;await f.service.close();let retired=0;
  const bounded=f.make({limits:{roundBytes:8*Buffer.byteLength(chat('a'.repeat(1000)))+1000},io:{...fs,rename:async(from,to)=>{if(String(to).includes('.retired-'))retired++;return fs.rename(from,to);}}});
  f.time.set(f.time.now()+31*60000);await bounded.run();assert.equal(retired,0);
  assert.deepEqual((await bounded.list(f.req,input())).entries,before);assert.match((await bounded.status(f.req,input())).lastResult.error,/上限/);
});
test('empty, malformed, unsupported, and overlarge sources never replace the last nonempty version',async t=>{
  const f=await fixture(t,{limits:{fileBytes:4096}});await first(f);const initial=(await f.service.list(f.req,input())).entries[0];
  for(const value of ['',JSON.stringify({chat_metadata:{}}),'{not json}',chat('x'.repeat(5000)),chat().replace('"mes":"original"','"mes":{}')]){
    await next(f,value);const entries=(await f.service.list(f.req,input())).entries;assert.equal(entries.length,1);assert.equal(entries[0].id,initial.id);assert.ok((await f.service.status(f.req,input())).lastResult.error);
  }
  assert.match((await f.service.read(f.req,input('alice',{id:initial.id}))).text,/original/);
});
test('read-back rejects changed snapshot bytes and damaged metadata',async t=>{
  const f=await fixture(t);await first(f);const entry=(await f.service.list(f.req,input())).entries[0],file=path.join(f.backup,entry.id+'.jsonl'),original=await fs.readFile(file);
  await fs.writeFile(file,chat('modified'));await assert.rejects(f.service.read(f.req,input('alice',{id:entry.id})),{code:'chat_backup_verify'});await fs.writeFile(file,original);
  const metadata=path.join(f.backup,entry.id+'.json');await fs.writeFile(metadata,'{"version":99}');await assert.rejects(f.service.list(f.req,input()),{code:'chat_backup_corrupt'});
});
test('request account mutation during disk I/O aborts without writing a snapshot',async t=>{
  let change=false,fixture0;const f=fixture0=await fixture(t,{io:{...fs,lstat:async(file,...args)=>{const stat=await fs.lstat(file,...args);if(change&&String(file).endsWith('session.jsonl')){change=false;fixture0.user.profile.enabled=false;}return stat;}}});
  await f.write();await f.service.configure(f.req,configure());change=true;await f.service.run();const files=await fs.readdir(f.backup);assert.equal(files.filter(name=>name.endsWith('.jsonl')).length,0);
});
test('hard-linked chat files are not copied and hard-linked saved copies cannot be read',async t=>{
  const f=await fixture(t),file=await f.write();await fs.link(file,path.join(f.root,'linked-original'));await f.service.configure(f.req,configure());await f.service.run();assert.equal((await f.service.list(f.req,input())).entries.length,0);
  await fs.unlink(path.join(f.root,'linked-original'));f.time.set(f.time.now()+31*60000);await f.service.run();const entry=(await f.service.list(f.req,input())).entries[0];await fs.link(path.join(f.backup,entry.id+'.jsonl'),path.join(f.root,'linked-backup'));
  await assert.rejects(f.service.read(f.req,input('alice',{id:entry.id})),{code:'chat_backup_path'});
});
test('symbolic character directories are skipped, never followed',async t=>{
  const f=await fixture(t),outside=path.join(f.root,'unrelated');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'external.jsonl'),chat('external'));
  try{await fs.symlink(outside,path.join(f.chats,'link'),process.platform==='win32'?'junction':'dir');}catch(error){if(error.code==='EPERM'){t.skip('OS does not allow symbolic links');return;}throw error;}
  await f.service.configure(f.req,configure());await f.service.run();assert.equal((await f.service.list(f.req,input())).entries.length,0);assert.equal((await f.service.status(f.req,input())).lastResult.skipped,1);
});
test('a source changed during reading is skipped without publishing a descriptor',async t=>{
  let change=false;const f=await fixture(t,{io:{...fs,open:async(file,...args)=>{const handle=await fs.open(file,...args);if(change&&String(file).endsWith('session.jsonl')){change=false;await fs.writeFile(file,chat('changed during open'));}return handle;}}});
  await f.write();await f.service.configure(f.req,configure());change=true;await f.service.run();assert.equal((await f.service.list(f.req,input())).entries.length,0);assert.ok((await f.service.status(f.req,input())).lastResult.error);
});
test('unverifiable and low disk space do not enable new writes or delete old versions',async t=>{
  const f=await fixture(t);await first(f);const unavailable=f.make({io:{...fs,statfs:undefined}});await assert.rejects(unavailable.configure(f.req,configure({intervalMinutes:15})),{code:'chat_backup_disk_unknown'});
  const low=f.make({io:{...fs,statfs:async()=>({bavail:1n,bsize:4096n})}});f.time.set(f.time.now()+31*60000);await low.run();assert.equal((await low.list(f.req,input())).entries.length,1);assert.match((await low.status(f.req,input())).lastResult.error,/空间不足/);
});
test('bounded file scan reports incomplete coverage rather than claiming success',async t=>{
  const f=await fixture(t,{limits:{files:1}});await f.write();await f.write(chat('second'),'角色1','second.jsonl');await f.service.configure(f.req,configure());await f.service.run();
  const state=await f.service.status(f.req,input());assert.equal(state.lastResult.created,1);assert.match(state.lastResult.error,/扫描/);assert.equal(state.lastSuccessAt,null);
});
test('capacity rotation writes and verifies new content before retiring only replaceable oldest versions',async t=>{
  const f=await fixture(t);await first(f,chat('old'.repeat(40000)));await f.service.configure(f.req,configure({limitMiB:256}));
  const old=(await f.service.list(f.req,input())).entries[0],state=await f.service.status(f.req,input()),filler=await fs.open(path.join(f.backup,'.retained-unknown'),'wx');await filler.truncate(256*MIB-state.usedBytes-1000);await filler.close();
  await next(f,chat('new'.repeat(16000)));const entries=(await f.service.list(f.req,input())).entries;assert.equal(entries.length,1);assert.notEqual(entries[0].id,old.id);assert.match((await f.service.read(f.req,input('alice',{id:entries[0].id}))).text,/newnew/);
  assert.ok((await f.service.status(f.req,input())).usedBytes<=256*MIB);await assert.rejects(fs.stat(path.join(f.backup,old.id+'.jsonl')),{code:'ENOENT'});
});
test('per-chat sole healthy copy cannot be removed just to admit another chat',async t=>{
  const f=await fixture(t);await first(f,chat('protected'));await f.service.configure(f.req,configure({limitMiB:256}));const old=(await f.service.list(f.req,input())).entries[0],state=await f.service.status(f.req,input());
  const filler=await fs.open(path.join(f.backup,'.retained-unknown'),'wx');await filler.truncate(256*MIB-state.usedBytes-1000);await filler.close();await next(f,chat('other'.repeat(4000)),'another.jsonl');
  const entries=(await f.service.list(f.req,input())).entries;assert.equal(entries.length,1);assert.equal(entries[0].id,old.id);assert.match((await f.service.status(f.req,input())).lastResult.error,/提高上限/);
});
test('failed new-copy verification leaves all old versions intact',async t=>{
  let tamper=false;const f=await fixture(t,{io:{...fs,open:async(file,...args)=>{const handle=await fs.open(file,...args);if(tamper&&String(file).endsWith('.jsonl')&&args[0]==='wx'){const sync=handle.sync.bind(handle);handle.sync=async()=>{await sync();await handle.write(Buffer.from('!'),0,1,0);};}return handle;}}});
  await first(f);const old=(await f.service.list(f.req,input())).entries[0];tamper=true;await next(f,chat('new'));assert.equal((await f.service.list(f.req,input())).entries.length,1);assert.match((await f.service.read(f.req,input('alice',{id:old.id}))).text,/original/);
});
test('atomic configuration unknown result is reconciled by status without resetting old settings',async t=>{
  let failAfter=false;const f=await fixture(t,{io:{...fs,rename:async(from,to)=>{await fs.rename(from,to);if(failAfter&&String(to).endsWith('.settings-v1.json')){failAfter=false;throw Object.assign(Error('lost acknowledgment'),{code:'EIO'});}}}});
  await f.service.configure(f.req,configure());failAfter=true;await assert.rejects(f.service.configure(f.req,configure({intervalMinutes:60})));assert.equal((await f.service.status(f.req,input())).intervalMinutes,60);
});
test('host adapter supports default single account and enabled multi-account profiles without exposing secrets',async t=>{
  const f=await fixture(t),src=path.join(f.root,'src');await fs.mkdir(src);for(const name of ['users.js','util.js','constants.js'])await fs.writeFile(path.join(src,name),'// synthetic trusted host');let multi=false;
  const get=await createChatBackupHost({hostDirectory:f.root,importModule:async url=>url.endsWith('/users.js')?{getAllEnabledUsers:async()=>[{handle:'alice',enabled:true,password:'never return'},{handle:'disabled',enabled:false}],getUserDirectories:handle=>({root:path.join(f.root,handle),chats:path.join(f.root,handle,'chats')})}:url.endsWith('/util.js')?{getConfigValue:()=>multi}:{DEFAULT_USER:{handle:'default-user',enabled:true,password:'never return'}}});
  assert.equal((await get())[0].profile.handle,'default-user');multi=true;assert.equal((await get()).length,1);assert.doesNotMatch(JSON.stringify(await get()),/password|never return/);
});
test('routes initialize eagerly and return explicit 503 if host integration is unavailable',async t=>{
  const f=await fixture(t),routes=new Map(),services=[];installChatBackupRoutes({post:(route,fn)=>routes.set(route,fn)},{dataRoot:()=>f.root,hostDirectory:path.join(f.root,'missing'),register:service=>services.push(service)});
  const response={code:200,set(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
  await routes.get('/chat-backups/status')(f.req,response);assert.equal(response.code,503);assert.match(response.body.message,/后台账户目录/);assert.equal(routes.size,4);await Promise.all(services.map(service=>service.close()));
});
test('read route serves complete plain-text JSONL and never accepts browser chat content',async t=>{
  const f=await fixture(t);await first(f);await f.service.close();const routes=new Map(),services=[];installChatBackupRoutes({post:(route,fn)=>routes.set(route,fn)},{dataRoot:()=>f.root,serviceOptions:{accounts:async()=>f.users,now:f.time.now,timers:f.time.timers},register:service=>services.push(service)});
  const entry=(await f.make().list(f.req,input())).entries[0],response={set(){},type(value){this.typeValue=value;},send(value){this.value=value;},json(value){this.value=value;},status(value){this.statusValue=value;return this;}};
  await routes.get('/chat-backups/read')({...f.req,body:input('alice',{id:entry.id})},response);assert.equal(response.typeValue,'text/plain; charset=utf-8');assert.equal(response.value,chat());
  await routes.get('/chat-backups/configure')({...f.req,body:{...configure(),chat:[]}},response);assert.equal(response.statusValue,400);await Promise.all(services.map(service=>service.close()));
});
test('unchanged source does not claim a successful backup when its saved snapshot has been damaged',async t=>{
  const f=await fixture(t);await first(f);const entry=(await f.service.list(f.req,input())).entries[0],previous=(await f.service.status(f.req,input())).lastSuccessAt;
  await fs.writeFile(path.join(f.backup,entry.id+'.jsonl'),chat('corrupt'));f.time.set(f.time.now()+31*60000);await f.service.run();const status=await f.service.status(f.req,input());
  assert.equal(status.lastResult.unchanged,0);assert.equal(status.lastResult.skipped,1);assert.equal(status.lastSuccessAt,previous);assert.match(status.lastResult.error,/校验失败/);
});
test('failed per-account lock receives a bounded retry and does not prevent another account from backing up',async t=>{
  const f=await fixture(t);await first(f);const bob=await f.add('bob');await f.write(chat('bob'),'角色1','session.jsonl',bob);await f.service.configure(bob.req,input('bob',{enabled:true,intervalMinutes:30,limitMiB:1024}));
  await fs.writeFile(path.join(f.backup,'.operation.lock'),'busy');f.time.set(f.time.now()+31*60000);await f.service.run();
  assert.equal((await f.service.list(bob.req,input('bob'))).entries.length,1);const timer=[...f.time.scheduled.values()][0];assert.ok(timer.at>=f.time.now()+60000);
  await fs.unlink(path.join(f.backup,'.operation.lock'));await f.time.fire();await f.service.run();assert.equal((await f.service.status(f.req,input())).lastResult.unchanged,1);
});
test('temporary host failure retries without waiting for a browser request',async t=>{
  let failHost=false;const f=await fixture(t);await first(f);await f.service.close();const service=f.make({accounts:async()=>{if(failHost)throw Error('temporary');return f.users;}});
  await service.start();failHost=true;f.time.set(f.time.now()+31*60000);await assert.rejects(service.run(),{code:'chat_backup_host'});assert.equal(f.time.scheduled.size,1);assert.ok([...f.time.scheduled.values()][0].at>=f.time.now()+60000);
  failHost=false;await f.write(chat('recovered'));await f.time.fire();await service.run();assert.equal((await service.list(f.req,input())).entries.length,2);
});
test('turning off backup is still allowed when free-space reserve cannot be met',async t=>{
  const f=await fixture(t);await first(f);await f.service.close();const low=f.make({io:{...fs,statfs:async()=>({bavail:0n,bsize:4096n})}});
  await low.configure(f.req,configure({enabled:false}));assert.equal((await low.status(f.req,input())).enabled,false);assert.equal(f.time.scheduled.size,0);
});
test('changed account directory is rejected instead of following a replacement',async t=>{
  const f=await fixture(t);await first(f);const elsewhere=path.join(f.root,'elsewhere');await fs.mkdir(elsewhere);const forged={user:{profile:{handle:'alice',enabled:true},directories:{root:elsewhere,chats:path.join(elsewhere,'chats')}}};
  await assert.rejects(f.service.status(forged,input()),{status:403});await assert.rejects(f.service.read(f.req,input('alice',{id:'../outside'})),{status:400});
});
test('a missing raw snapshot is not listed or trusted merely because its descriptor remains',async t=>{
  const f=await fixture(t);await first(f);const entry=(await f.service.list(f.req,input())).entries[0];await fs.unlink(path.join(f.backup,entry.id+'.jsonl'));
  await assert.rejects(f.service.list(f.req,input()),{code:'chat_backup_corrupt'});f.time.set(f.time.now()+31*60000);await f.service.run();assert.equal((await fs.readdir(f.backup)).filter(name=>name.endsWith('.jsonl')).length,0);
});
test('rotation does not delete old versions after a new snapshot descriptor failed to write',async t=>{
  let reject=false;const f=await fixture(t,{io:{...fs,open:async(file,...args)=>{if(reject&&args[0]==='wx'&&/[/\\][a-f0-9-]{36}\.json$/.test(file))throw Object.assign(Error('disk I/O'),{code:'EIO'});return fs.open(file,...args);}}});
  await first(f,chat('old'.repeat(40000)));await f.service.configure(f.req,configure({limitMiB:256}));const old=(await f.service.list(f.req,input())).entries[0],state=await f.service.status(f.req,input());
  const filler=await fs.open(path.join(f.backup,'.retained-unknown'),'wx');await filler.truncate(256*MIB-state.usedBytes-1000);await filler.close();reject=true;await next(f,chat('new'.repeat(16000)));
  assert.equal((await f.service.list(f.req,input())).entries[0].id,old.id);assert.match((await f.service.read(f.req,input('alice',{id:old.id}))).text,/oldold/);assert.ok((await f.service.status(f.req,input())).lastResult.error);
});
test('late replacement at the rotation boundary is preserved in quarantine, not deleted',async t=>{
  let replaceId=null,replaced=false;const f=await fixture(t,{io:{...fs,rename:async(from,to)=>{if(replaceId&&from.endsWith(replaceId+'.json')&&String(to).includes('.retired-')){await fs.unlink(from);await fs.writeFile(from,'unrelated late replacement');replaced=true;}return fs.rename(from,to);}}});
  await first(f,chat('old'.repeat(40000)));await f.service.configure(f.req,configure({limitMiB:256}));const old=(await f.service.list(f.req,input())).entries[0],state=await f.service.status(f.req,input());replaceId=old.id;
  const filler=await fs.open(path.join(f.backup,'.retained-unknown'),'wx');await filler.truncate(256*MIB-state.usedBytes-1000);await filler.close();await next(f,chat('new'.repeat(16000)));assert.equal(replaced,true);
  const files=await fs.readdir(f.backup),retired=files.find(name=>name.startsWith('.retired-'));assert.ok(retired);assert.equal(await fs.readFile(path.join(f.backup,retired),'utf8'),'unrelated late replacement');
  assert.match(await fs.readFile(path.join(f.backup,old.id+'.jsonl'),'utf8'),/oldold/);assert.ok((await f.service.status(f.req,input())).lastResult.error);
});
test('an account lookup failure on the first boot retries before any HTTP request',async t=>{
  const f=await fixture(t);await first(f);await f.service.close();await f.write(chat('post restart'));let available=false;
  const service=f.make({accounts:async()=>{if(!available)throw Error('host warming up');return f.users;}});await service.start();assert.equal(f.time.scheduled.size,1);assert.ok([...f.time.scheduled.values()][0].at>=f.time.now()+60000);
  available=true;await f.time.fire();await service.run();assert.equal(f.time.scheduled.size,1);f.time.set(f.time.now()+31*60000);await f.time.fire();await service.run();assert.equal((await service.list(f.req,input())).entries.length,2);
});
test('native avatar names containing internal .png are mapped through the actual character filenames',async t=>{
  const f=await fixture(t),characters=path.join(f.owner,'characters');await fs.mkdir(characters);f.user.directories.characters=characters;
  await fs.writeFile(path.join(characters,'hero.png.extra.png'),'synthetic card name only');await f.write(chat(),'hero.extra.png');
  await f.service.configure(f.req,configure());await f.service.run();const entries=(await f.service.list(f.req,input())).entries;assert.equal(entries.length,1);assert.equal(entries[0].avatar,'hero.png.extra.png');
  assert.equal((await f.service.status(f.req,input())).lastResult.skipped,0);
});
test('avatar names that collapse into the same native chat folder are not guessed',async t=>{
  const f=await fixture(t),characters=path.join(f.owner,'characters');await fs.mkdir(characters);f.user.directories.characters=characters;
  for(const avatar of ['hero.png.extra.png','hero.extra.png.png'])await fs.writeFile(path.join(characters,avatar),'synthetic');await f.write(chat(),'hero.extra.png');
  await f.service.configure(f.req,configure());await f.service.run();assert.equal((await f.service.list(f.req,input())).entries.length,0);assert.match((await f.service.status(f.req,input())).lastResult.error,/不唯一/);
});
test('trusted host relative data directories resolve against init cwd, not a request-selected location',async t=>{
  const f=await fixture(t),src=path.join(f.root,'src');await fs.mkdir(src);for(const name of ['users.js','util.js','constants.js'])await fs.writeFile(path.join(src,name),'// synthetic');
  const accounts=await createChatBackupHost({hostDirectory:f.root,importModule:async url=>url.endsWith('/users.js')?{getAllEnabledUsers:async()=>[f.user.profile],getUserDirectories:()=>({root:'alice',chats:'alice/chats'})}:url.endsWith('/util.js')?{getConfigValue:()=>true}:{DEFAULT_USER:{handle:'default-user'}}});
  const service=f.make({accounts,hostDirectory:f.root}),request={user:{profile:f.user.profile,directories:{root:'alice',chats:'alice/chats'}}};await f.write();await service.configure(request,configure());await service.run();assert.equal((await service.list(request,input())).entries.length,1);
});
