import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createNativeProseAssistantHistoryStore as create,openNativeProseAssistantHistory as open,copyRenamedProseAssistantHistory} from '../qianmu-prose-assistant-native.js';
import {emptyProseAssistantHistory,createProseAssistantThreadKey} from '../qianmu-prose-assistant-history-contract.js';
import {openProseAssistantConversations} from '../qianmu-prose-assistant-conversations.js';

const raw='st-user:alice',account='st-user:'+createHash('sha256').update('alice').digest('hex');
const key=JSON.stringify(['qianmu-prose-assistant-v2',account,'char:A.png',{kind:'character',chatId:'A',avatar:'A.png'},null]);
const row=(text='回答')=>({id:1,user:'问题',assistant:text,status:'complete',reference:{floor:0,replyId:'swipe:0',mode:'floor',range:{start:0,end:2}}});
const history=(revision=1,rows=[row()])=>({version:1,namespace:key,revision,updatedAt:revision?20:0,rows});
function fixture(local=emptyProseAssistantHistory(key),scopeKey=key){
 const f={files:new Map(),writes:0,localReads:0,localClosed:0,closed:0,live:true,lost:false,nativeAccount:raw,local};
 const check=async options=>{if(options?.guard&&await options.guard()!==true)throw Error('scope');};
 f.options={source:{key:scopeKey,scope:{namespace:account},assertCurrent:()=>f.live,guard:async()=>f.live},isCurrent:()=>f.live,now:()=>30,
  legacyFactory:()=>({async read(ns,k){assert.equal(ns,account);assert.equal(k,scopeKey);f.localReads++;return structuredClone(f.local);},close(){f.localClosed++;}}),
  storageFactory:async()=>({namespace:f.nativeAccount,
   async read(slot,options){await check(options);const found=f.files.get(slot);return found?{exists:true,value:structuredClone(found.value),fingerprint:found.fingerprint}:{exists:false,value:null,fingerprint:null};},
   async write(slot,value,{expectedFingerprint,...options}){await check(options);if(f.race){f.files.set(slot,{value:history(4,[row('其他设备')]),fingerprint:'race'});f.race=false;}
    if((f.files.get(slot)?.fingerprint??null)!==expectedFingerprint)throw Object.assign(Error('private conflict'),{code:'st_account_storage_conflict'});
    const result={value:structuredClone(value),fingerprint:'v'+(++f.writes)};f.files.set(slot,result);if(f.lost){f.lost=false;throw Error('private acknowledgement lost');}return structuredClone(result);
   },close(){f.closed++;}})};
 return f;
}

test('native history migrates only exact account/chat local records when remote is absent and never deletes old data',async()=>{
 const f=fixture(history(2)),before=structuredClone(f.local),store=await create(f.options),result=await store.read(account,key);
 assert.deepEqual(result,before);assert.equal(f.writes,1);assert.equal(f.localReads,1);assert.equal(f.localClosed,1);assert.deepEqual(f.local,before);
 assert.match([...f.files.keys()][0],/^assistant-[a-f0-9]{64}$/);assert.equal(store.persistence,'st-account-file');assert.equal(store.concurrency,'optimistic-non-cas');store.close();
 const second=await create(f.options);assert.deepEqual(await second.read(account,key),before);assert.equal(f.localReads,1);second.close();
});

test('two devices see native edits and clear tombstones prevent resurrection from an old local browser',async()=>{
 const f=fixture(history()),first=await create(f.options);await first.read(account,key);await first.write(account,key,1,[]);first.close();
 const second=await create(f.options),loaded=await second.read(account,key);assert.equal(loaded.revision,2);assert.deepEqual(loaded.rows,[]);assert.equal(f.localReads,1);assert.equal(f.local.rows.length,1);
 await second.write(account,key,2,[row('新回答')]);assert.equal((await second.read(account,key)).rows[0].assistant,'新回答');second.close();
});

test('empty local state does not upload a needless history while explicit local clear revision is retained',async()=>{
 const f=fixture(),store=await create(f.options);assert.deepEqual(await store.read(account,key),emptyProseAssistantHistory(key));assert.equal(f.writes,0);store.close();
 const cleared=fixture(history(3,[])),another=await create(cleared.options);assert.equal((await another.read(account,key)).revision,3);assert.equal(cleared.writes,1);another.close();
});

test('concurrent revision changes reject rather than merging replies or overwriting another device',async()=>{
 const f=fixture(),a=await create(f.options),b=await create(f.options);await a.read(account,key);await b.read(account,key);await a.write(account,key,0,[row()]);
 await assert.rejects(b.write(account,key,0,[row('过时')]),{code:'prose_assistant_history_conflict'});assert.equal((await a.read(account,key)).rows[0].assistant,'回答');a.close();b.close();
});

test('migration race adopts validated remote state and preserves old local copy without retrying the write',async()=>{
 const f=fixture(history());f.race=true;const store=await create(f.options);assert.equal((await store.read(account,key)).rows[0].assistant,'其他设备');assert.equal(f.writes,0);assert.equal(f.local.rows[0].assistant,'回答');store.close();
});

test('lost native acknowledgement reconciles exact saved revision/content without duplicate writes',async()=>{
 const f=fixture(),runtime=await open(f.options);f.lost=true;
 await assert.rejects(runtime.save({key,busy:false,rows:[row()]}));assert.equal(runtime.status().dirty,true);assert.equal(f.writes,1);
 const result=await runtime.retry();assert.equal(result.persistence,'st-account-file');assert.equal(result.concurrency,'optimistic-non-cas');assert.equal(f.writes,1);runtime.close();assert.equal(f.closed,1);
});

test('wrong account, chat, corrupt remote or scope invalidation never overwrites native data',async()=>{
 const wrong=fixture();wrong.nativeAccount='st-user:bob';await assert.rejects(create(wrong.options),{code:'prose_assistant_history_scope'});assert.equal(wrong.closed,1);assert.equal(wrong.writes,0);
 const f=fixture(history()),store=await create(f.options);await store.read(account,key);const before=f.writes;
 await assert.rejects(store.read(account,key.replace('A.png','B.png')),{code:'prose_assistant_history_scope'});
 [...f.files.values()][0].value.rows[0].assistant='';await assert.rejects(store.read(account,key),{code:'prose_assistant_history_invalid'});assert.equal(f.writes,before);
 f.live=false;await assert.rejects(store.write(account,key,1,[]));assert.equal(f.writes,before);store.close();
});

test('account offstage history persists reference-free replies in a different native slot than real chat history',async()=>{
 const offstageKey=JSON.stringify(['qianmu-prose-assistant-offstage-v1',account]);
 const f=fixture(emptyProseAssistantHistory(offstageKey),offstageKey),offstage=await create(f.options);
 await offstage.read(account,offstageKey);await offstage.write(account,offstageKey,0,[{...row('场外回答'),reference:null}]);offstage.close();
 const offstageSlot=[...f.files.keys()][0],chatFixture=fixture();chatFixture.files=f.files;
 const chat=await create(chatFixture.options);assert.deepEqual((await chat.read(account,key)).rows,[]);await chat.write(account,key,0,[row('聊天回答')]);chat.close();
 assert.equal(f.files.size,2);assert.equal(f.files.get(offstageSlot).value.rows[0].assistant,'场外回答');
 const reopened=await open(f.options);assert.equal(reopened.initialHistory().rows[0].assistant,'场外回答');reopened.close();
 const guarded=await create(f.options);await assert.rejects(guarded.read(account,key),{code:'prose_assistant_history_scope'});guarded.close();
});

test('a new thread with no native history never opens the retired IndexedDB store, including its first save',async()=>{
 const thread=createProseAssistantThreadKey(key,'b5d8f920-ecbd-42cc-a5e0-4870e8b629e1'),f=fixture(history(2),thread),priorLocal=structuredClone(f.local);
 const options={...f.options,legacyFactory:()=>assert.fail('independent threads never existed in the retired browser store')};
 const store=await create(options);assert.deepEqual(await store.read(account,thread),emptyProseAssistantHistory(thread));assert.equal(f.writes,0);
 await store.write(account,thread,0,[{...row('独立新对话'),reference:null}]);assert.equal(f.writes,1);assert.equal(f.files.size,1);assert.equal(f.localReads,0);assert.deepEqual(f.local,priorLocal);store.close();
 const reopened=await open(options);assert.equal(reopened.initialHistory().namespace,thread);assert.equal(reopened.initialHistory().version,1);assert.equal(reopened.initialHistory().rows[0].assistant,'独立新对话');assert.equal(f.writes,1);reopened.close();
});

test('registered chat rename rebinds live entries and tombstones without copying or modifying any message document',async()=>{
 const f=fixture(history(2)),oldStore=await create(f.options);await oldStore.read(account,key);oldStore.close();
 const thread=createProseAssistantThreadKey(key,'df0e9045-aab8-446d-bb93-d774b97801df');
 const threadOptions={...f.options,source:{...f.options.source,key:thread},legacyFactory:()=>assert.fail('thread history cannot use legacy fallback')};
 const threadStore=await create(threadOptions);await threadStore.write(account,thread,0,[{...row('独立对话原回答'),reference:null}]);threadStore.close();
 const catalog=await openProseAssistantConversations(f.options);await catalog.ensure({key,title:'角色 A',createdAt:10,updatedAt:20});await catalog.ensure({key:thread,title:'角色 A',createdAt:20,updatedAt:30});await catalog.activate(thread,{defaultForCurrent:key});await catalog.delete([key]);catalog.close();
 const messages=new Map([...f.files].filter(([slot])=>slot!=='assistant-conversations').map(([slot,record])=>[slot,structuredClone(record)]));
 const writes=f.writes,localReads=f.localReads,originalLocal=structuredClone(f.local),renamed=JSON.parse(key);renamed[3].chatId='Renamed';const newKey=JSON.stringify(renamed),source={...f.options.source,key:newKey};
 const result=await copyRenamedProseAssistantHistory({...f.options,source,oldChatId:'A',legacyFactory:()=>assert.fail('registered rename must not copy from the browser store')});
 assert.deepEqual(result,{status:'rebound'});assert.equal(f.writes,writes+1,'only the account directory is written');assert.equal(f.localReads,localReads);assert.deepEqual(f.local,originalLocal);
 assert.deepEqual(new Map([...f.files].filter(([slot])=>slot!=='assistant-conversations')),messages);
 const renamedCatalog=await openProseAssistantConversations({...f.options,source}),state=renamedCatalog.view();
 assert.deepEqual(state.entries.map(entry=>entry.key),[key,thread]);assert.ok(state.entries.every(entry=>entry.ownerKey===newKey));assert.equal(state.entries.find(entry=>entry.key===key).deleted,true);assert.equal(state.entries.find(entry=>entry.key===thread).deleted,false);assert.deepEqual(state.defaults,[{ownerKey:newKey,key:thread}]);
 assert.equal(await renamedCatalog.ensure({key,ownerKey:newKey,title:'不能复活'}),null);renamedCatalog.close();assert.equal(f.writes,writes+1);
 const continued=await open({...threadOptions,source:{...source,key:thread}});assert.equal(continued.initialHistory().rows[0].assistant,'独立对话原回答');continued.close();assert.equal(f.writes,writes+1);assert.equal(f.files.size,messages.size+1);
});

test('a registered chat containing only deleted conversations remains deleted after a host rename',async()=>{
 const f=fixture(history(2)),native=await create(f.options);await native.read(account,key);native.close();
 const catalog=await openProseAssistantConversations(f.options);await catalog.ensure({key,title:'角色 A'});await catalog.delete([key]);catalog.close();
 const before=new Map([...f.files].filter(([slot])=>slot!=='assistant-conversations').map(([slot,record])=>[slot,structuredClone(record)])),writes=f.writes,renamed=JSON.parse(key);renamed[3].chatId='Deleted renamed';const newKey=JSON.stringify(renamed),source={...f.options.source,key:newKey};
 assert.deepEqual(await copyRenamedProseAssistantHistory({...f.options,source,oldChatId:'A',legacyFactory:()=>assert.fail('deleted catalog entries must not be rediscovered as live history')}),{status:'rebound'});
 assert.equal(f.writes,writes+1);assert.deepEqual(new Map([...f.files].filter(([slot])=>slot!=='assistant-conversations')),before);
 const after=await openProseAssistantConversations({...f.options,source});assert.equal(after.view().entries.length,1);assert.equal(after.view().entries[0].ownerKey,newKey);assert.equal(after.view().entries[0].deleted,true);assert.deepEqual(after.view().defaults,[]);after.close();
});
