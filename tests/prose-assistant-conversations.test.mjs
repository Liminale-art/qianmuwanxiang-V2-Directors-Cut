import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {openProseAssistantConversations as open,PROSE_ASSISTANT_CONVERSATIONS_LIMITS as LIMIT,canAutoNameProseAssistantConversation as canAutoName} from '../qianmu-prose-assistant-conversations.js';
import {createProseAssistantThreadKey,proseAssistantOwnerKey} from '../qianmu-prose-assistant-history-contract.js';
import {streamCheckpointTransport} from './helpers/stream-checkpoint-fixture.mjs';

const raw='st-user:assistant-conversations-fixture',account='st-user:'+createHash('sha256').update(raw.slice(8)).digest('hex');
const base=(name='A',owner=account)=>JSON.stringify(['qianmu-prose-assistant-v2',owner,'char:A.png',{kind:'character',chatId:name,avatar:'A.png'},null]);
const offstage=JSON.stringify(['qianmu-prose-assistant-offstage-v1',account]);
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const state=()=>({version:1,account,revision:0,entries:[],defaults:[]});
const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const record=value=>({exists:true,value:structuredClone(value),fingerprint:fingerprint(value)});
const absent=()=>({exists:false,value:null,fingerprint:null});
const deferred=()=>{let resolve;return {promise:new Promise(done=>{resolve=done;}),resolve};};
function fixture(initial=null){
 const f={current:initial===null?absent():record(initial),reads:[],writes:[],live:true,closed:0,mode:'ok',now:100,namespace:raw};
 const check=async options=>{if(await options.guard()!==true)throw Error('private scope');};
 f.options={source:{key:base(),scope:{namespace:account},assertCurrent:()=>f.live,guard:async()=>f.live},isCurrent:()=>f.live,now:()=>f.now,
  storageFactory:async options=>{
   assert.equal(options.documentLayout,'snapshot');assert.equal(options.maxBytes,LIMIT.bytes);
   return {namespace:f.namespace,
    async read(slot,options){assert.equal(slot,'assistant-conversations');await check(options);f.reads.push(slot);if(f.readHold)await f.readHold.promise;await check(options);if(f.readError)throw Error('private-key storage error');return structuredClone(f.current);},
    async write(slot,value,{expectedFingerprint,...options}){
     assert.equal(slot,'assistant-conversations');await check(options);f.writes.push({slot,value:structuredClone(value),expectedFingerprint});
     if(f.hold)await f.hold.promise;await check(options);
     if(f.beforeWrite)f.beforeWrite();
     if(f.current.fingerprint!==expectedFingerprint)throw Object.assign(Error('private storage race'),{code:'st_account_storage_conflict'});
     if(f.mode==='fail')throw Error('private-key write rejected');
     f.current=record(value);if(f.mode==='lost')throw Error('private acknowledgement lost');
     if(f.mode==='bad-receipt')return record({...value,revision:value.revision+1});return structuredClone(f.current);
    },close(){f.closed++;},
   };
  },
 };return f;
}
const code=name=>({code:'prose_assistant_conversations_'+name});

test('catalog opens one fixed account snapshot without reading histories or creating an empty directory',async()=>{
 const f=fixture(),catalog=await open(f.options);assert.deepEqual(catalog.view(),state());assert.deepEqual(f.reads,['assistant-conversations']);assert.equal(f.writes.length,0);
 const value=catalog.view();value.entries.push('external edit');assert.deepEqual(catalog.view(),state());catalog.close();assert.equal(f.closed,1);assert.throws(catalog.view,code('scope'));
});

test('legacy registration is explicit, once only, and new conversations keep the original record',async()=>{
 const f=fixture(),catalog=await open(f.options),first=await catalog.ensure({key:base(),title:'角色 A · 2026/9/29',updatedAt:40});
 assert.equal(first.key,base());assert.equal(first.ownerKey,base());assert.equal(first.createdAt,40);assert.equal(first.lastUsedAt,100);assert.equal(f.writes.length,1);
 assert.deepEqual(await catalog.ensure({key:base(),title:'do not replace legacy',updatedAt:99}),first);assert.equal(f.writes.length,1);
 f.now=200;const second=await catalog.create({ownerKey:base(),title:'角色 A · 2026/9/29',id:id(1)});
 assert.equal(second.key,createProseAssistantThreadKey(base(),id(1)));assert.equal(catalog.view().entries.length,2);assert.deepEqual(catalog.view().entries[0],first);
 assert.deepEqual(catalog.view().defaults,[{ownerKey:base(),key:second.key}]);assert.equal(f.reads.length,1,'mutations rely on native fingerprint checks, not history scans');catalog.close();
});

test('activation and saved metadata keep owner defaults explicit rather than binding foreign chat content',async()=>{
 const f=fixture(),catalog=await open(f.options),a=await catalog.create({ownerKey:base(),title:'A',id:id(1)}),b=await catalog.create({ownerKey:base('B'),title:'B',id:id(2)});
 f.now=300;assert.equal((await catalog.activate(a.key)).lastUsedAt,300);
 assert.deepEqual(catalog.view().defaults,[{ownerKey:base(),key:a.key},{ownerKey:base('B'),key:b.key}]);
 await assert.rejects(catalog.activate(a.key,{defaultForCurrent:base('B')}),code('scope'));assert.equal(catalog.status().dirty,false);
 f.now=400;await catalog.saved(a.key,350);const saved=catalog.view().entries.find(row=>row.key===a.key);assert.equal(saved.updatedAt,350);assert.equal(saved.lastUsedAt,400);
 await catalog.activate(a.key,{defaultForCurrent:base()});catalog.close();
});

test('explicit catalog actions remember unreadmitted history in one atomic snapshot and retry the entire target',async()=>{
 const remember={key:base(),title:'旧对话',updatedAt:40},f=fixture(),catalog=await open(f.options);f.mode='fail';
 await assert.rejects(catalog.create({ownerKey:base(),title:'新对话',id:id(1),remember}),code('storage'));
 assert.equal(catalog.view().entries.length,0);assert.equal(f.writes.length,1);assert.equal(f.writes[0].value.entries.length,2);
 f.mode='ok';await catalog.retry();assert.deepEqual(f.writes[1].value,f.writes[0].value);assert.equal(catalog.view().entries[0].key,base());
 assert.equal(catalog.view().defaults[0].key,createProseAssistantThreadKey(base(),id(1)));catalog.close();
 const g=fixture(),other=await open(g.options),target=await other.create({ownerKey:base('B'),title:'B',id:id(2)}),before=g.writes.length;
 await assert.rejects(other.activate(target.key,{remember:{...remember,title:''}}),code('invalid'));assert.equal(other.status().dirty,false);assert.equal(g.writes.length,before);assert.equal(other.view().entries.length,1);
 await other.activate(target.key,{remember});assert.equal(g.writes.length,before+1);assert.equal(other.view().entries.length,2);
 const ghost={key:base('C'),title:'C',updatedAt:40};await other.delete([ghost.key],{remember:ghost});assert.equal(g.writes.length,before+2);assert.equal(other.view().entries.find(entry=>entry.key===ghost.key).deleted,true);
 await other.activate(target.key,{remember:ghost});assert.equal(other.view().entries.find(entry=>entry.key===ghost.key).deleted,true,'remember must never resurrect a tombstone');other.close();
});

test('ordinary v1 and v2 reads write nothing, while explicit rename registers a ghost and upgrades in one snapshot',async()=>{
 const f=fixture(),catalog=await open(f.options);await catalog.ensure({key:base(),title:'旧角色名'.repeat(30)});const legacy=catalog.view();catalog.close();
 const reopened=await open(f.options),before=f.writes.length;assert.deepEqual(reopened.view(),legacy);assert.equal(reopened.view().version,1);assert.equal(f.writes.length,before);
 const ghost={key:offstage,ownerKey:offstage,title:'独立对话',createdAt:20,updatedAt:40};
 const named=await reopened.rename(offstage,'  岩彩创作笔记  ',{remember:ghost});assert.equal(f.writes.length,before+1);assert.equal(reopened.view().version,2);
 assert.equal(named.title,'岩彩创作笔记');assert.equal(named.titleSource,'manual');assert.equal(named.updatedAt,40);assert.equal(named.createdAt,20);assert.deepEqual(reopened.view().entries[0],legacy.entries[0]);
 await reopened.rename(offstage,named.title);assert.equal(f.writes.length,before+1,'an unchanged manual name requires no second write');const persisted=reopened.view();reopened.close();
 const newest=await open(f.options);assert.deepEqual(newest.view(),persisted);assert.equal(f.writes.length,before+1);assert.equal(canAutoName(newest.view().entries[1]),false);newest.close();
});

test('first automatic title shares the saved metadata write, is applied only once and never replaces a manual name',async()=>{
 const f=fixture(),catalog=await open(f.options),entry=await catalog.create({ownerKey:offstage,title:'独立对话',id:id(1)});assert.equal(canAutoName(entry),true);assert.equal(catalog.canAutoName(entry.key),true);assert.equal(catalog.canAutoName(offstage),false);
 f.now=200;const before=f.writes.length,automatic=await catalog.saved(entry.key,190,{title:'  水墨与岩彩  '});
 assert.equal(f.writes.length,before+1);assert.equal(catalog.view().version,2);assert.equal(automatic.updatedAt,190);assert.equal(automatic.lastUsedAt,200);assert.equal(automatic.title,'水墨与岩彩');assert.equal(automatic.titleSource,'auto');assert.equal(canAutoName(automatic),false);assert.equal(catalog.canAutoName(entry.key),false);
 f.now=300;const again=await catalog.saved(entry.key,290,{title:'后来模型的新标题'});assert.equal(again.title,'水墨与岩彩');assert.equal(again.titleSource,'auto');
 const manual=await catalog.rename(entry.key,'独立对话');assert.equal(manual.titleSource,'manual');assert.equal(canAutoName(manual),false);
 f.now=400;assert.equal((await catalog.saved(entry.key,390,{title:'不能替换手动名称'})).title,'独立对话');catalog.close();
});

test('automatic names leave character and group titles untouched and ignore invalid model suggestions without failing saved metadata',async()=>{
 const group=JSON.stringify(['qianmu-prose-assistant-v2',account,'group:12',{kind:'group',chatId:'group-chat'},null]);
 const f=fixture(),catalog=await open(f.options);
 for(const owner of [base(),group]){const entry=await catalog.ensure({key:owner,title:'特助对话'});assert.equal(canAutoName(entry),false);assert.equal((await catalog.saved(owner,101,{title:'模型标题'})).title,'特助对话');}
 const entry=await catalog.ensure({key:offstage,title:'独立对话'});assert.equal(canAutoName({...entry,deleted:true}),false);assert.equal(canAutoName({...entry,title:'已有旧名称'}),false);assert.equal(canAutoName({...entry,ownerKey:'not-a-key'}),false);
 for(const title of ['',null,123,'x'.repeat(41),'a\nb','a\u0085b','<b>名字</b>','\ud800']){f.now++;const writes=f.writes.length,saved=await catalog.saved(offstage,f.now,{title});assert.equal(saved.title,'独立对话');assert.equal(saved.titleSource,undefined);assert.equal(saved.updatedAt,f.now);assert.equal(f.writes.length,writes+1);}
 assert.equal(catalog.view().version,1,'unsuccessful automatic suggestions never upgrade legacy files');catalog.close();
});

test('manual names reject malformed text before registering a ghost and cannot rename tombstones',async()=>{
 const f=fixture(),catalog=await open(f.options),remember={key:offstage,title:'独立对话'};
 for(const title of ['', '   ',null,123,'x'.repeat(41),'a\nb','a\rb','a\tb','a\u0085b','a\u2028b','a\u202Eb','<img src=x>','\ud800']){
  await assert.rejects(catalog.rename(offstage,title,{remember}),code('title'));assert.equal(catalog.status().dirty,false);assert.equal(f.writes.length,0);assert.deepEqual(catalog.view(),state());
 }
 const emoji='🌙'.repeat(40),named=await catalog.rename(offstage,emoji,{remember});assert.equal(named.title,emoji,'the limit counts Unicode characters, not UTF-16 code units');
 await catalog.delete([offstage]);const before=f.writes.length;await assert.rejects(catalog.rename(offstage,'不能复活',{remember}),code('deleted'));await assert.rejects(catalog.saved(offstage,200,{title:'不能复活'}),code('deleted'));assert.equal(f.writes.length,before);assert.equal(catalog.view().entries[0].deleted,true);catalog.close();
});

test('named snapshots require explicit v2 with a valid title source and canonical safe title',async()=>{
 const entry={key:offstage,ownerKey:offstage,title:'目录名称',createdAt:1,updatedAt:1,lastUsedAt:1,deleted:false,titleSource:'manual'};
 for(const patch of [{version:1},{version:3},{entry:{titleSource:'unknown'}},{entry:{title:'<i>名称</i>'}},{entry:{title:' 名称 '}},{entry:{title:'x'.repeat(41)}},{entry:{extra:true}}]){
  const value={...state(),version:patch.version??2,revision:1,entries:[{...entry,...patch.entry}]},f=fixture(value);await assert.rejects(open(f.options),code('invalid'));assert.equal(f.writes.length,0);
 }
});

test('rename receipt loss and auto-title conflicts preserve exact targets and never overwrite a later manual name',async()=>{
 const f=fixture(),catalog=await open(f.options);f.mode='lost';await assert.rejects(catalog.rename(offstage,'手动标题',{remember:{key:offstage,title:'独立对话'}}),code('storage'));
 assert.equal(catalog.view().version,1);assert.equal(catalog.view().entries.length,0);assert.equal(f.current.value.version,2);f.mode='ok';await catalog.retry();assert.equal(f.writes.length,1);assert.equal(catalog.view().entries[0].titleSource,'manual');catalog.close();
 const g=fixture(),automatic=await open(g.options);await automatic.ensure({key:offstage,title:'独立对话'});const manual=await open(g.options);
 g.mode='fail';await assert.rejects(automatic.saved(offstage,200,{title:'自动标题'}),code('storage'));const target=structuredClone(g.writes.at(-1).value);g.mode='ok';await manual.rename(offstage,'用户已修改');const writes=g.writes.length;
 await assert.rejects(automatic.retry(),code('conflict'));assert.equal(g.writes.length,writes);assert.deepEqual(g.writes.at(-2).value,target);assert.equal(g.current.value.entries[0].title,'用户已修改');assert.equal(g.current.value.entries[0].titleSource,'manual');
 await automatic.refresh();assert.equal(canAutoName(automatic.view().entries[0]),false);automatic.close();manual.close();
});

test('batch removal makes one tombstone write and prevents legacy rediscovery or late metadata saves',async()=>{
 const f=fixture(),catalog=await open(f.options);await catalog.ensure({key:base(),title:'A'});const thread=await catalog.create({ownerKey:base(),title:'A',id:id(1)});await catalog.create({ownerKey:offstage,title:'独立对话',id:id(2)});
 const before=f.writes.length,removed=await catalog.delete([base(),thread.key]);assert.deepEqual(removed.deleted,[base(),thread.key]);assert.equal(f.writes.length,before+1);
 assert.equal(catalog.view().entries.length,3);assert.equal(catalog.view().entries.filter(row=>row.deleted).length,2);assert.deepEqual(catalog.view().defaults.map(row=>row.ownerKey),[offstage]);
 assert.equal(await catalog.ensure({key:base(),title:'old data must stay removed'}),null);await assert.rejects(catalog.saved(thread.key,300),code('deleted'));await assert.rejects(catalog.activate(base()),code('deleted'));
 const after=f.writes.length;assert.deepEqual(await catalog.delete([base(),thread.key]),{deleted:[]});assert.equal(f.writes.length,after);catalog.close();
 const reopened=await open(f.options);assert.equal(await reopened.ensure({key:base(),title:'A'}),null);assert.equal(f.writes.length,after);reopened.close();
});

test('confirmed chat rename updates only catalog bindings and defaults while keeping all message keys',async()=>{
 const f=fixture(),catalog=await open(f.options);await catalog.ensure({key:base(),title:'A'});const thread=await catalog.create({ownerKey:base(),title:'A',id:id(1)});await catalog.delete([base()]);
 const before=catalog.view(),result=await catalog.renameOwner(base(),base('renamed'));
 assert.deepEqual(result,{renamed:2});assert.deepEqual(catalog.view().entries.map(row=>row.key),before.entries.map(row=>row.key));assert.equal(proseAssistantOwnerKey(thread.key),base());
 assert.ok(catalog.view().entries.every(row=>row.ownerKey===base('renamed')));assert.deepEqual(catalog.view().defaults,[{ownerKey:base('renamed'),key:thread.key}]);
 const writes=f.writes.length;assert.deepEqual(await catalog.renameOwner(base(),base('renamed')),{renamed:0});assert.equal(f.writes.length,writes);catalog.close();
});

test('rename preserves an existing destination default and never adopts another account',async()=>{
 const f=fixture(),catalog=await open(f.options),a=await catalog.create({ownerKey:base(),title:'A',id:id(1)}),b=await catalog.create({ownerKey:base('B'),title:'B',id:id(2)});
 await catalog.renameOwner(base(),base('B'));assert.equal(catalog.view().entries.find(row=>row.key===a.key).ownerKey,base('B'));assert.deepEqual(catalog.view().defaults,[{ownerKey:base('B'),key:b.key}]);
 const before=f.writes.length;await assert.rejects(catalog.renameOwner(base('B'),base('foreign','st-user:'+'b'.repeat(64))),code('invalid'));assert.equal(f.writes.length,before);catalog.close();
});

test('rename refuses a different character, integrity marker or offstage binding',async()=>{
 const f=fixture(),catalog=await open(f.options);await catalog.ensure({key:base(),title:'A'});const before=f.writes.length;
 const changedCharacter=JSON.parse(base('B'));changedCharacter[2]='char:B.png';changedCharacter[3].avatar='B.png';
 const changedIntegrity=JSON.parse(base('B'));changedIntegrity[4]='different-chat-integrity';
 for(const owner of [JSON.stringify(changedCharacter),JSON.stringify(changedIntegrity),offstage])await assert.rejects(catalog.renameOwner(base(),owner),code('scope'));
 assert.equal(f.writes.length,before);assert.equal(catalog.view().entries[0].ownerKey,base());catalog.close();
});

test('lost directory acknowledgement retries by reading the exact target and never writes twice',async()=>{
 const f=fixture(),catalog=await open(f.options);f.mode='lost';
 await assert.rejects(catalog.create({ownerKey:base(),title:'A',id:id(1)}),cause=>{assert.equal(cause.code,code('storage').code);assert.doesNotMatch(cause.message,/private|key/);return true;});
 assert.equal(catalog.status().dirty,true);assert.equal(catalog.view().entries.length,0);assert.equal(f.current.value.entries.length,1);assert.equal(f.writes.length,1);
 await assert.rejects(catalog.create({ownerKey:base(),title:'B',id:id(2)}),code('pending'));f.mode='ok';const recovered=await catalog.retry();
 assert.equal(recovered.entries.length,1);assert.equal(f.writes.length,1);assert.equal(catalog.status().dirty,false);catalog.close();
});

test('definite failure keeps the same target for manual retry without rebasing on other changes',async()=>{
 const f=fixture(),catalog=await open(f.options);f.mode='fail';await assert.rejects(catalog.create({ownerKey:base(),title:'A',id:id(1)}),code('storage'));
 f.mode='ok';const retried=await catalog.retry();assert.equal(retried.entries[0].key,createProseAssistantThreadKey(base(),id(1)));assert.equal(f.writes.length,2);catalog.close();
 const race=fixture(),stale=await open(race.options);race.mode='fail';await assert.rejects(stale.create({ownerKey:base(),title:'pending',id:id(3)}));
 race.mode='ok';const other=await open(race.options);await other.create({ownerKey:base(),title:'other page',id:id(4)});const before=race.writes.length;
 await assert.rejects(stale.retry(),code('conflict'));assert.equal(race.writes.length,before);assert.equal(stale.status().dirty,true);
 assert.equal((await stale.refresh()).entries[0].title,'other page');assert.equal(stale.status().dirty,false);other.close();stale.close();
});

test('native fingerprint conflicts do not overwrite concurrent catalog entries',async()=>{
 const f=fixture(),a=await open(f.options),b=await open(f.options);await a.create({ownerKey:base(),title:'first',id:id(1)});
 await assert.rejects(b.create({ownerKey:base(),title:'stale',id:id(2)}),code('conflict'));assert.equal(f.current.value.entries.length,1);assert.equal(f.current.value.entries[0].title,'first');
 await b.refresh();await b.create({ownerKey:base(),title:'after explicit refresh',id:id(2)});assert.equal(f.current.value.entries.length,2);a.close();b.close();
});

test('failed explicit refresh preserves the pending directory operation until an actual read succeeds',async()=>{
 const f=fixture(),catalog=await open(f.options);f.mode='fail';await assert.rejects(catalog.create({ownerKey:base(),title:'A',id:id(1)}));
 f.readError=true;await assert.rejects(catalog.refresh(),code('storage'));assert.equal(catalog.status().dirty,true);assert.equal(catalog.view().revision,0);
 f.readError=false;f.mode='ok';await catalog.retry();assert.equal(catalog.view().entries[0].title,'A');assert.equal(catalog.status().dirty,false);catalog.close();
});

test('one deliberate live-entry read catches deletion from another page before a history save',async()=>{
 const f=fixture(),writer=await open(f.options);const entry=await writer.create({ownerKey:base(),title:'A',id:id(1)}),other=await open(f.options);
 await other.delete([entry.key]);const before=f.reads.length,writes=f.writes.length;await assert.rejects(writer.assertEntryLive(entry.key),code('deleted'));
 assert.equal(f.reads.length,before+1);assert.equal(f.writes.length,writes);assert.equal(writer.view().entries[0].deleted,true);await assert.rejects(writer.saved(entry.key,600),code('deleted'));writer.close();other.close();
});

test('in-flight mutations reject competing operations and closed pages cannot publish a late write',async()=>{
 const f=fixture(),catalog=await open(f.options);f.hold=deferred();const operation=catalog.create({ownerKey:base(),title:'A',id:id(1)});await new Promise(done=>setImmediate(done));
 assert.equal(catalog.status().busy,true);await assert.rejects(catalog.create({ownerKey:base(),title:'B',id:id(2)}),code('busy'));assert.equal(catalog.retry(),operation);
 const rejected=assert.rejects(operation,code('scope'));catalog.close();f.hold.resolve();await rejected;assert.equal(f.current.exists,false);assert.equal(catalog.status().closed,true);
});

test('wrong account, malformed snapshot and forged receipt never become confirmed directory state',async()=>{
 const wrong=fixture();wrong.namespace='st-user:another-account';await assert.rejects(open(wrong.options),code('scope'));assert.equal(wrong.closed,1);assert.equal(wrong.reads.length,0);
 for(const malformed of [{...state(),extra:true},{...state(),account:'st-user:'+'b'.repeat(64)},{...state(),defaults:[{ownerKey:base(),key:base()}]}]){
  const f=fixture(malformed);await assert.rejects(open(f.options),code('invalid'));assert.equal(f.writes.length,0);assert.equal(f.closed,1);
 }
 const f=fixture(),catalog=await open(f.options);f.mode='bad-receipt';await assert.rejects(catalog.create({ownerKey:base(),title:'A',id:id(1)}),code('invalid'));assert.equal(catalog.view().entries.length,0);assert.equal(catalog.status().dirty,true);
 await catalog.retry();assert.equal(catalog.view().entries.length,1);assert.equal(f.writes.length,1);catalog.close();
});

test('title, identity, duplicate and capacity limits reject without truncating or recycling tombstones',async()=>{
 const f=fixture(),catalog=await open(f.options);
 await assert.rejects(catalog.create({ownerKey:base(),title:'x'.repeat(LIMIT.title+1),id:id(1)}),code('invalid'));await assert.rejects(catalog.ensure({key:base(),title:'line\nbreak'}),code('invalid'));
 const entry=await catalog.create({ownerKey:base(),title:'A',id:id(1)});await catalog.delete([entry.key]);await assert.rejects(catalog.create({ownerKey:base(),title:'same UUID',id:id(1)}),code('duplicate'));catalog.close();
 const full=state();full.revision=1;for(let n=1;n<=LIMIT.entries;n++)full.entries.push({key:createProseAssistantThreadKey(base(),id(n)),ownerKey:base(),title:'A',createdAt:1,updatedAt:1,lastUsedAt:1,deleted:true});
 const bounded=fixture(full),instance=await open(bounded.options);await assert.rejects(instance.create({ownerKey:base(),title:'no silent eviction',id:id(LIMIT.entries+1)}),code('capacity'));assert.equal(instance.view().entries.length,LIMIT.entries);assert.equal(bounded.writes.length,0);instance.close();
});

test('real native snapshot adapter stores one lightweight catalog and never contacts optional backend or reads messages',async()=>{
 const transport=streamCheckpointTransport(raw),f=fixture(),options={...f.options,storageFactory:transport.createStorage},catalog=await open(options);
 assert.equal(transport.calls.length,1);assert.match(transport.calls[0].path,/-assistant-conversations\.snapshot\.json$/);
 await catalog.create({ownerKey:base(),title:'A · 2026/9/29',id:id(1)});assert.equal(transport.calls.filter(call=>call.options.method==='POST').length,1);assert.equal(transport.calls.filter(call=>call.options.method==='GET').length,3);
 const before=transport.calls.length;catalog.view();catalog.view();assert.equal(transport.calls.length,before);assert.equal(transport.files.size,1);
 const stored=JSON.parse([...transport.files.values()][0]);assert.equal(stored.schema,'qianmu.st-account-snapshot.v1');assert.equal(stored.slot,'assistant-conversations');assert.equal(stored.value.entries.length,1);assert.ok(!Object.hasOwn(stored.value,'rows'));
 for(const call of transport.calls)assert.ok(call.path==='/api/files/upload'||/-assistant-conversations\.snapshot\.json$/.test(call.path));catalog.close();
 const reopened=await open(options);assert.equal(reopened.view().entries[0].title,'A · 2026/9/29');assert.equal(transport.calls.length,before+1);reopened.close();
});

test('real native snapshot lost receipt is reconciled read-only and account changes prevent later writes',async()=>{
 const transport=streamCheckpointTransport(raw),f=fixture(),catalog=await open({...f.options,storageFactory:transport.createStorage});let lost=false;
 transport.hook=({path,options,files,json})=>{
  if(path!=='/api/files/upload'||lost)return;lost=true;const {name,data}=JSON.parse(options.body);files.set(name,Buffer.from(data,'base64').toString('utf8'));return json({},503);
 };
 await assert.rejects(catalog.create({ownerKey:base(),title:'A',id:id(1)}),code('storage'));assert.equal(transport.files.size,1);
 const before=transport.calls.filter(call=>call.options.method==='POST').length;await catalog.retry();assert.equal(catalog.view().entries.length,1);assert.equal(transport.calls.filter(call=>call.options.method==='POST').length,before);
 transport.namespace='st-user:other-account';await assert.rejects(catalog.saved(catalog.view().entries[0].key,500),code('storage'));assert.equal(transport.calls.filter(call=>call.options.method==='POST').length,before);catalog.close();
});

test('real native snapshot saves an automatic name in the existing metadata upload and reads named directories without rewriting',async()=>{
 const transport=streamCheckpointTransport(raw),f=fixture(),options={...f.options,storageFactory:transport.createStorage},catalog=await open(options);
 await catalog.ensure({key:offstage,title:'独立对话'});const before=transport.calls.filter(call=>call.options.method==='POST').length;f.now=200;
 const entry=await catalog.saved(offstage,190,{title:'配色研究'});assert.equal(entry.titleSource,'auto');assert.equal(transport.calls.filter(call=>call.options.method==='POST').length,before+1);
 assert.equal(transport.files.size,1);const stored=JSON.parse([...transport.files.values()][0]).value;assert.equal(stored.version,2);assert.equal(stored.entries[0].title,'配色研究');assert.equal(stored.entries[0].updatedAt,190);catalog.close();
 const calls=transport.calls.length,reopened=await open(options);assert.equal(transport.calls.length,calls+1);assert.equal(transport.calls.at(-1).options.method,'GET');assert.deepEqual(reopened.view(),stored);assert.equal(reopened.canAutoName(offstage),false);reopened.close();
});
