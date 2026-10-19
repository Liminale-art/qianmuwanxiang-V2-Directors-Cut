import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {installChatBackupRoutes} from '../qianmu-chat-backup-service.js';
import {createChatRecovery,inspectChatRecoveryJsonl} from '../qianmu-chat-recovery.js';

const sha=value=>createHash('sha256').update(value).digest('hex');
const immediate=()=>new Promise(resolve=>setImmediate(resolve));
const rows=()=>[
  {user_name:'unused',character_name:'unused',create_date:'2026-10-19',unknownHeader:{nested:[false,0,null]},chat_metadata:{integrity:'source-original',story_director_liminale:{history:[{text:'原有推演'}]},otherPlugin:{keep:'完整'}}},
  {name:'用户',is_user:true,mes:'第一条正文',send_date:'2026-10-19T01:00:00Z',extra:{keep:['all']}},
  {name:'角色',is_user:false,mes:'第二条正文',send_date:'2026-10-19T01:01:00Z',swipe_id:1,swipes:['候选一','第二条正文'],swipe_info:[{extra:{keep:1}},{extra:{keep:2}}]},
];
const jsonl=value=>'\uFEFF'+value.map(item=>JSON.stringify(item)).join('\r\n')+'\r\n';

test('real routes and disk service integrate with the real recovery controller, preserving metadata and browser-independent restart',async t=>{
  const temporary=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(temporary,'qianmu-chat-backup-flow-')),owner=path.join(root,'default-user'),chats=path.join(owner,'chats'),role=path.join(chats,'角色1');
  await fs.mkdir(role,{recursive:true});await fs.mkdir(path.join(owner,'backups'));
  const original=Buffer.from(jsonl(rows())),originalPath=path.join(role,'原聊天.jsonl');await fs.writeFile(originalPath,original);
  const user={profile:{handle:'default-user',enabled:true},directories:{root:owner,chats}},calls=[],registered=[];
  let now=1900000000000,timerId=0,routes=new Map();const pendingTimers=new Map();
  const timers={setTimeout(fn,delay){const id=++timerId;pendingTimers.set(id,{fn,at:now+delay});return id;},clearTimeout(id){pendingTimers.delete(id);}};
  const boot=()=>{routes=new Map();return installChatBackupRoutes({post:(route,handler)=>routes.set(route,handler)},{dataRoot:()=>root,serviceOptions:{accounts:async()=>[user],now:()=>now,timers},register:service=>registered.push(service)});};
  const route=async(method,body)=>{
    const headers=new Headers(),response={code:200,value:'',set(name,value){headers.set(name,value);},type(value){headers.set('content-type',value);return this;},status(code){this.code=code;return this;},json(value){headers.set('content-type','application/json');this.value=JSON.stringify(value);},send(value){this.value=value;}};
    await routes.get('/chat-backups/'+method)({user,body},response);return new Response(response.value,{status:response.code,headers});
  };
  const respond=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
  const request=async(url,options)=>{
    calls.push({url,options});assert.equal(options.method,'POST');assert.equal(options.credentials,'same-origin');assert.equal(options.redirect,'error');
    if(url.startsWith('/api/plugins/qianmu-tts/chat-backups/'))return route(url.split('/').at(-1),JSON.parse(options.body));
    if(url==='/api/backups/chat/get')return respond([]);
    if(url==='/api/characters/chats')return respond((await fs.readdir(role)).filter(name=>name.endsWith('.jsonl')).map(file_name=>({file_name})));
    if(url==='/api/chats/import'){
      const form=options.body;assert.ok(form instanceof FormData);assert.equal(form.get('avatar_url'),'角色1.png');assert.equal(form.get('file_type'),'jsonl');
      const fileName=form.get('character_name')+' - synthetic imported.jsonl';await fs.writeFile(path.join(role,fileName),await form.get('file').text(),{flag:'wx'});return respond({res:true,fileNames:[fileName]});
    }
    if(url==='/api/chats/export'){const body=JSON.parse(options.body);assert.equal(body.avatar_url,'角色1.png');assert.equal(body.is_group,false);return respond({result:await fs.readFile(path.join(role,body.file),'utf8')});}
    assert.fail('No native save or other live network is permitted: '+url);
  };
  const controller=createChatRecovery({fetch:request,origin:'https://st.invalid',getRequestHeaders:()=>({'X-CSRF-Token':'isolated-only'}),resolveAccount:async()=>'st-user:default-user',getCharacters:()=>[{avatar:'角色1.png',name:'角色'}],crypto:{randomUUID}});
  t.after(async()=>{controller.dispose();await Promise.all(registered.map(service=>service.close()));const resolved=await fs.realpath(root);assert.equal(path.dirname(resolved),temporary);assert.match(path.basename(resolved),/^qianmu-chat-backup-flow-/);await fs.rm(resolved,{recursive:true});});
  await boot();await controller.inspectAutomaticBackup();assert.equal(controller.snapshot().automaticBackup.status.enabled,false);assert.equal(controller.snapshot().automaticBackup.status.maxVersionsPerChat,0);
  await controller.configureAutomaticBackup({enabled:true,intervalMinutes:15,limitMiB:256,maxVersionsPerChat:2});
  assert.equal(controller.snapshot().automaticBackup.status.retention,'rotate-oldest-keep-one');assert.equal(controller.snapshot().automaticBackup.status.maxVersionsPerChat,2);assert.equal(pendingTimers.size,1);
  assert.equal(JSON.parse(calls.find(call=>call.url.endsWith('/chat-backups/configure')).options.body).maxVersionsPerChat,2);
  const timer=[...pendingTimers.entries()][0];pendingTimers.delete(timer[0]);timer[1].fn();await immediate();
  // A request may wait for the in-flight run, but does not start the backup.
  for(let index=0;index<100;index++){await controller.inspectAutomaticBackup();if(controller.snapshot().automaticBackup.status.lastRunAt!==null)break;await immediate();}
  assert.equal(controller.snapshot().automaticBackup.status.lastResult.created,1);await controller.load();const entry=controller.snapshot().backups[0];assert.equal(entry.source,'qianmu');
  const read=await route('read',{expectedAccount:'st-user:default-user',id:entry.id}),bytes=Buffer.from(await read.arrayBuffer());
  assert.equal(read.headers.get('content-type'),'text/plain; charset=utf-8');assert.deepEqual(bytes,original,'BOM, CRLF and full original bytes are served unchanged');
  const list=await(await route('list',{expectedAccount:'st-user:default-user'})).json();assert.equal(list.entries[0].sha256,sha(original));assert.equal(list.entries[0].sizeBytes,original.length);
  await controller.preview(entry.name);assert.equal(controller.snapshot().preview.messageCount,2);assert.match(controller.snapshot().preview.text,/第二条正文/);
  const result=await controller.recover('角色1.png');assert.equal(result.result.status,'verified');const restored=inspectChatRecoveryJsonl(await fs.readFile(path.join(role,result.result.fileName),'utf8')).rows;
  assert.notEqual(restored[0].chat_metadata.integrity,rows()[0].chat_metadata.integrity);restored[0].chat_metadata.integrity=rows()[0].chat_metadata.integrity;assert.deepEqual(restored,rows());
  assert.deepEqual(await fs.readFile(originalPath),original);assert.equal(calls.filter(call=>call.url==='/api/chats/import').length,1);assert.equal(calls.filter(call=>call.url==='/api/chats/save').length,0);await controller.verify();assert.equal(calls.filter(call=>call.url==='/api/chats/import').length,1);
  controller.dispose();await registered[0].close();assert.equal(pendingTimers.size,0);const networkBefore=calls.length;
  const updated=rows();updated[2].mes='停页之后的已保存正文';await fs.writeFile(originalPath,jsonl(updated));const restarted=await boot();
  assert.equal(pendingTimers.size,1,'startup restores the persisted schedule before any HTTP call');
  const tick=[...pendingTimers.entries()][0];pendingTimers.delete(tick[0]);now=tick[1].at;tick[1].fn();
  // Observe disk only. No controller or HTTP request is needed to make progress.
  await immediate();await restarted.run();let found=false;
  const files=await fs.readdir(path.join(owner,'qianmu-chat-backups'));
  for(const file of files.filter(file=>/^[a-f0-9-]{36}\.json$/.test(file))){const metadata=JSON.parse(await fs.readFile(path.join(owner,'qianmu-chat-backups',file),'utf8'));if(metadata.chatFile==='原聊天.jsonl'&&metadata.sha256===sha(Buffer.from(jsonl(updated))))found=true;}
  assert.equal(found,true);assert.equal(calls.length,networkBefore,'server timer progressed with zero browser traffic');
  assert.equal(JSON.parse(await fs.readFile(path.join(owner,'qianmu-chat-backups','.settings-v1.json'),'utf8')).maxVersionsPerChat,2);
});
