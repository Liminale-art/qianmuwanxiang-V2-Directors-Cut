import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createStoryboardWorldbookController} from '../qianmu-storyboard-worldbooks.js';
import {stWorldBookEntries} from '../qianmu-st-context-sources.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const row=(uid,content=`text-${uid}`,extra={})=>({uid,content,...extra});
const saved=(kind,owner,book,entryIds,enabled=true)=>({kind,owner,book,entryIds,enabled});
function fixture({charBook='',userBook='',books={Book:[row(1),row(2)]},compiler={}}={}) {
  const events=new EventEmitter(),types=Object.fromEntries(['PERSONA_CHANGED','CHAT_CHANGED','CHARACTER_EDITED','WORLDINFO_UPDATED','WORLDINFO_SETTINGS_UPDATED','PERSONA_UPDATED'].map(name=>[name,name]));
  const e={chat:'chat-a',epoch:0,books,entryCalls:[],nameCalls:0,saves:0,renders:0,toasts:[],entryHook:null,namesHook:null,
    context:{characters:[{avatar:'char-a.png',name:'Same',data:{extensions:{world:charBook}}}],characterId:0,powerUserSettings:{persona_description:'',persona_description_lorebook:userBook},chatMetadata:{},eventSource:events,eventTypes:types},
    main:{user_avatar:'user-a.png'},worldInfo:{charLore:[]},
    state:{promptCompiler:{worldBookNames:[],worldEntryIds:[],worldBookInitializedNames:[],worldBookView:'',personaWorldSelections:[],...compiler},collapsedCards:{}}};
  const host={state:()=>e.state,context:()=>e.context,chatKey:()=>e.chat,epoch:()=>e.epoch,
    loadModules:async()=>({main:e.main,world:{getWorldInfoSettings:()=>({world_info:e.worldInfo})}}),
    names:async()=>{e.nameCalls++;return e.namesHook?await e.namesHook():Object.keys(e.books);},
    entries:async book=>{e.entryCalls.push(book);if(e.entryHook)await e.entryHook(book);return Object.hasOwn(e.books,book)?structuredClone(e.books[book]):null;},
    resolve:async text=>text.replace('{{user}}','USER'),clean:text=>String(text),save:()=>{e.saves++;},render:()=>{e.renders++;},toast:text=>e.toasts.push(text),
    format:{htmlEscape:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),badge:text=>`<small>${text}</small>`,hashText:text=>String(text),cleanContextText:text=>text}};
  e.controller=createStoryboardWorldbookController(host);e.host=host;e.guard=()=>({assertCurrent(){this.worldbooks?.assertCurrent();}});
  e.read=async()=>{const guard=e.guard();try{await e.controller.prepare(e.state,guard);return await e.controller.read(e.state,guard);}finally{guard.worldbooks?.close();}};
  return e;
}

test('warm shows exact bound labels and a pending choice without creating consent or saving automatic selections',async()=>{
  const e=fixture({charBook:'Book',userBook:'Book'});await e.controller.warm();
  assert.deepEqual(e.controller.view(e.state).books,[{name:'Book',labels:['角色绑定','USER绑定'],selected:false,manual:false,pending:true}]);
  assert.deepEqual(e.state.promptCompiler.personaWorldSelections,[]);assert.equal(e.saves,0);
  await assert.rejects(e.read(),{code:'storyboard_context_unavailable'});assert.deepEqual(e.entryCalls,[]);
});

test('bound edit is an unsaved enabled-entry draft and cancelling does not authorize its proposed defaults',async()=>{
  const e=fixture({userBook:'Book',books:{Book:[row(1),row(2,'disabled',{disable:true}),row(3,'disabled',{enabled:false})]}});
  await e.controller.edit('Book');assert.deepEqual(e.controller.view(e.state).entries.map(item=>[item.id,item.checked]),[['Book::1',true]]);
  assert.equal(e.saves,0);assert.deepEqual(e.state.promptCompiler.personaWorldSelections,[]);
  e.controller.cancel();assert.equal(e.controller.view(e.state).editing,false);await assert.rejects(e.read(),{code:'storyboard_context_unavailable'});
});

test('confirmation stores exact current persona, while a deliberately empty selection remains empty',async()=>{
  const e=fixture({userBook:'Book'});await e.controller.edit('Book');
  e.controller.toggleEntry('Book::1',false);e.controller.toggleEntry('Book::2',false);e.controller.confirm();
  assert.deepEqual(e.state.promptCompiler.personaWorldSelections,[saved('user','user-a.png','Book',[])]);
  assert.equal((await e.read()).text,'');assert.equal(e.controller.view(e.state).books[0].pending,false);
});

test('skip is a retained disabled decision, not an unconfirmed book or a blanket future selection',async()=>{
  const e=fixture({userBook:'Book'});await e.controller.edit('Book');e.controller.confirm(true);
  assert.deepEqual(e.state.promptCompiler.personaWorldSelections,[saved('user','user-a.png','Book',[],false)]);
  assert.equal(e.controller.view(e.state).books[0].pending,false);assert.equal((await e.read()).text,'');
});

test('confirmed reads include selected enabled content without keyword-trigger scanning and deduplicate shared char/user scope',async()=>{
  const e=fixture({charBook:'Book',userBook:'Book',books:{Book:[row(1,'hello {{user}}',{key:['not-triggered'],constant:false}),row(2)]}});
  await e.controller.edit('Book');e.controller.toggleEntry('Book::2',false);e.controller.confirm();
  assert.equal(e.state.promptCompiler.personaWorldSelections.length,2);
  const result=await e.read();assert.equal(result.rows.length,1);assert.match(result.text,/hello USER/);assert.doesNotMatch(result.text,/text-2/);
});

test('later additions do not join confirmed entries; disabled entries are excluded and missing selected entries stop complete sending',async()=>{
  const e=fixture({userBook:'Book'});await e.controller.edit('Book');e.controller.confirm();
  e.books.Book.push(row(3,'new private'));e.books.Book[1].disable=true;
  const result=await e.read();assert.deepEqual(result.rows.map(item=>item.id),['Book::1']);assert.doesNotMatch(result.text,/new private/);
  e.books.Book=e.books.Book.filter(item=>item.uid!==1);await assert.rejects(e.read(),{code:'storyboard_context_unavailable'});
});

test('same-name empty personas bound to the same book never reuse each other confirmation',async()=>{
  const e=fixture({userBook:'Book'});await e.controller.edit('Book');e.controller.confirm();
  e.main.user_avatar='user-b.png';assert.equal(e.controller.view(e.state).books[0].pending,true);
  await assert.rejects(e.read(),{code:'storyboard_context_unavailable'});
  e.main.user_avatar='user-a.png';assert.equal((await e.read()).rows.length,2);
});

test('same-name characters bound to the same book remain exact-avatar scoped without sweeping group members',async()=>{
  const e=fixture({charBook:'Book'});await e.controller.edit('Book');e.controller.confirm();
  e.context.groupId='group';e.context.characters.push({avatar:'char-b.png',name:'Same',data:{extensions:{world:'Book'}}});e.context.characterId=1;
  await assert.rejects(e.read(),{code:'storyboard_context_unavailable'});
  e.context.characterId=0;assert.equal((await e.read()).rows.length,2);
});

test('selection edits and world/persona/chat events invalidate prepared reads and all listeners are released',async()=>{
  for(const event of ['WORLDINFO_UPDATED','WORLDINFO_SETTINGS_UPDATED','PERSONA_CHANGED','CHARACTER_EDITED','CHAT_CHANGED']) {
    const e=fixture({compiler:{worldBookNames:['Book'],worldEntryIds:['Book::1']}}),guard=e.guard();
    await e.controller.prepare(e.state,guard);e.context.eventSource.emit(event);
    await assert.rejects(()=>e.controller.read(e.state,guard),{code:'storyboard_input_changed'});
    guard.worldbooks.close();assert.equal(e.context.eventSource.eventNames().length,0);
  }
  const e=fixture({compiler:{worldBookNames:['Book'],worldEntryIds:['Book::1']}}),guard=e.guard();
  await e.controller.prepare(e.state,guard);e.state.promptCompiler.worldEntryIds=['Book::2'];
  await assert.rejects(()=>e.controller.read(e.state,guard),{code:'storyboard_input_changed'});guard.worldbooks.close();
});

test('official persona lorebook edit-and-restore events invalidate preparation even when the final binding matches',async()=>{
  const e=fixture({userBook:'Book'});await e.controller.edit('Book');e.controller.confirm();const guard=e.guard();
  await e.controller.prepare(e.state,guard);
  e.context.powerUserSettings.persona_description_lorebook='Other';e.context.eventSource.emit('PERSONA_UPDATED','user-a.png');
  e.context.powerUserSettings.persona_description_lorebook='Book';e.context.eventSource.emit('PERSONA_UPDATED','user-a.png');
  try{await assert.rejects(()=>e.controller.read(e.state,guard),{code:'storyboard_input_changed'});}finally{guard.worldbooks.close();}
});

test('switching persona while official modules first load cannot silently adopt the other persona confirmation',async()=>{
  const e=fixture({userBook:'Book',compiler:{personaWorldSelections:[saved('user','user-a.png','Book',['Book::1']),saved('user','user-b.png','Book',['Book::2'])]}});
  const started=deferred(),release=deferred(),original=e.host.loadModules;e.host.loadModules=async()=>{started.resolve();await release.promise;return original();};
  const guard=e.guard(),work=e.controller.prepare(e.state,guard);await started.promise;
  e.main.user_avatar='user-b.png';e.context.eventSource.emit('PERSONA_CHANGED','user-b.png');release.resolve();
  try{await assert.rejects(work,{code:'storyboard_input_changed'});}finally{guard.worldbooks?.close();}
});

test('late entry reads from another chat, epoch, state or persona never write into the new owner',async()=>{
  for(const switchOwner of [e=>{e.chat='chat-b';},e=>{e.epoch++;},e=>{e.state=structuredClone(e.state);},e=>{e.main.user_avatar='user-b.png';}]) {
    const e=fixture({userBook:'Book'}),started=deferred(),release=deferred();await e.controller.warm();
    e.entryHook=async()=>{started.resolve();await release.promise;};const work=e.controller.edit('Book');await started.promise;
    switchOwner(e);release.resolve();await assert.rejects(work,{code:'storyboard_input_changed'});
    assert.deepEqual(e.state.promptCompiler.personaWorldSelections,[]);assert.equal(e.saves,0);
  }
});

test('manual legacy choices stay unchanged on cancel, then explicit confirm converts only this book to owner scope',async()=>{
  const e=fixture({userBook:'Book',books:{Book:[row(1),row(2)],Other:[row(1)]},compiler:{worldBookNames:['Book','Other'],worldEntryIds:['Book::2','Other::1'],worldBookInitializedNames:['Book','Other']}});
  await e.controller.edit('Book');assert.deepEqual(e.controller.view(e.state).entries.map(item=>[item.id,item.checked]),[['Book::1',false],['Book::2',true]]);
  e.controller.cancel();assert.deepEqual(e.state.promptCompiler.worldBookNames,['Book','Other']);
  await e.controller.edit('Book');e.controller.confirm();
  assert.deepEqual(e.state.promptCompiler.worldBookNames,['Other']);assert.deepEqual(e.state.promptCompiler.worldEntryIds,['Other::1']);
  assert.deepEqual(e.state.promptCompiler.personaWorldSelections,[saved('user','user-a.png','Book',['Book::2'])]);
});

test('a late first edit cannot replace a newer selected book and its draft',async()=>{
  const e=fixture({charBook:'A',userBook:'B',books:{A:[row(1)],B:[row(2)]}}),started=deferred(),release=deferred();await e.controller.warm();
  e.entryHook=async book=>{if(book==='A'){started.resolve();await release.promise;}};
  const first=e.controller.edit('A').catch(error=>error);await started.promise;await e.controller.edit('B');release.resolve();await first;
  assert.equal(e.state.promptCompiler.worldBookView,'B');assert.deepEqual(e.controller.view(e.state).entries.map(item=>item.id),['B::2']);
  e.controller.confirm();assert.deepEqual(e.state.promptCompiler.personaWorldSelections,[saved('user','user-a.png','B',['B::2'])]);
});

test('cancelling during a delayed edit cannot reopen its draft after the user has left it',async()=>{
  const e=fixture({userBook:'Book'}),started=deferred(),release=deferred();await e.controller.warm();
  e.entryHook=async()=>{started.resolve();await release.promise;};const work=e.controller.edit('Book').catch(error=>error);await started.promise;
  e.controller.cancel();release.resolve();await work;
  assert.equal(e.controller.view(e.state).editing,false);assert.deepEqual(e.state.promptCompiler.personaWorldSelections,[]);
});

test('manual toggle off wins over an earlier delayed toggle on',async()=>{
  const e=fixture(),started=deferred(),release=deferred();await e.controller.warm();
  e.entryHook=async()=>{started.resolve();await release.promise;};const first=e.controller.toggleBook('Book',true).catch(error=>error);await started.promise;
  await e.controller.toggleBook('Book',false);release.resolve();await first;
  assert.deepEqual(e.state.promptCompiler.worldBookNames,[]);assert.deepEqual(e.state.promptCompiler.worldEntryIds,[]);
});

test('refresh that removes an already selected draft entry cannot silently confirm only the surviving subset',async()=>{
  const e=fixture({userBook:'Book'});await e.controller.edit('Book');e.books.Book=[row(2)];await e.controller.warm({force:true});
  assert.throws(()=>e.controller.confirm());assert.deepEqual(e.state.promptCompiler.personaWorldSelections,[]);
});

test('previously initialized manual books still obey the same book-count limit when selected again',async()=>{
  const books=Object.fromEntries(Array.from({length:101},(_,i)=>[`B${i}`,[row(1)]]));
  const e=fixture({books,compiler:{worldBookNames:Object.keys(books).slice(0,100),worldEntryIds:[],worldBookInitializedNames:Object.keys(books)}});
  await e.controller.warm();await assert.rejects(()=>e.controller.toggleBook('B100',true),{code:'storyboard_context_unavailable'});
  assert.equal(e.state.promptCompiler.worldBookNames.length,100);
});

test('duplicate entry identifiers and missing books fail explicitly rather than narrowing the input',async()=>{
  const e=fixture({compiler:{worldBookNames:['Book'],worldEntryIds:['Book::1']},books:{Book:[row(1),row(1)]}});
  await assert.rejects(e.read(),{code:'storyboard_context_unavailable'});
  const absent=fixture({compiler:{worldBookNames:['missing'],worldEntryIds:['missing::1']}});
  await assert.rejects(absent.read(),{code:'storyboard_context_unavailable'});
});

test('the actual strict ST reader distinguishes a valid empty book from failed official data without falling back',async()=>{
  const globals={TavernHelper:{getWorldbook:()=>assert.fail('must not read stale optional helper')},fetch:()=>assert.fail('must not retry official failure'),console:{warn(){}}};
  assert.deepEqual(await stWorldBookEntries({loadWorldInfo:async()=>({entries:{}})},'Book',globals,{strict:true}),[]);
  for(const value of [null,undefined,{},false,'not a worldbook']) {
    await assert.rejects(()=>stWorldBookEntries({loadWorldInfo:async()=>value},'Book',globals,{strict:true}),{code:'storyboard_context_unavailable'});
  }
  await assert.rejects(()=>stWorldBookEntries({loadWorldInfo:async()=>{throw Error('private error');}},'Book',globals,{strict:true}),{code:'storyboard_context_unavailable'});
});

test('malformed selected entry data from the official reader cannot silently disappear or become object text',async()=>{
  for(const bad of [null,'broken entry',{uid:0,content:{private:'not valid text'}}]) {
    const e=fixture({compiler:{worldBookNames:['Book'],worldEntryIds:['Book::0']}});
    e.context.loadWorldInfo=async()=>({entries:{0:bad}});
    e.host.entries=book=>stWorldBookEntries(e.context,book,{console:{warn(){}}},{strict:true});
    await assert.rejects(e.read(),{code:'storyboard_context_unavailable'});
  }
});
