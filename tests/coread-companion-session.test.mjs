import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

function fixture(){
  const host={chatId:'old-chat',characterId:0,characters:[{name:'同名',avatar:'a.png',description:'A {{char}}'},{name:'同名',avatar:'b.png',description:'B {{char}}'}]};
  const books=[{id:'book',title:'Book',lastChapterIndex:1,lastScrollRatio:.2},{id:'other',title:'Other'}],state={books};
  const legacy={coreadCompanionWb:{worldBooks:['A world'],worldItems:{}}},notices=[],writes=[],frames=[];
  const context=vm.createContext({ctx:()=>host,coread:()=>state,getChatKey:()=>host.chatId||String(host.characterId??'default'),getChatStore:()=>legacy,
    clone:structuredClone,isPlainObject:x=>!!x&&typeof x==='object'&&!Array.isArray(x),coreadBookMeta:id=>books.find(b=>b.id===id),
    getPersonaName:()=>host.name1 || 'User',getPersonaDescription:()=>host.persona_description || 'User desc',coreadPersonaAvatarRaw:'',URL,
    htmlEscape:x=>String(x??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),
    coreadDistilling:false,coreadAutoTextInFlight:false,readerView:null,readerContentCache:null,coreadOpenRequestId:0,activeTab:'coread',readerAssistant:{},readerDialog:{bucket:'',loaded:false},readerAssistantSessions:new Map(),
    reader:{COREAD_SLICE_SCHEMA_VERSION:3},coreadVectorStates:new Map(),coreadVecCache:null,
    toast:text=>notices.push(text),saveSettings:()=>{},coreadInvalidatePool:()=>{},renderModal:()=>{},refreshReaderPortal:()=>{},nowMs:()=>1,
    coreadStopDialog:()=>{},coreadStopAssistant:()=>{},ttsStopPlayback:()=>{},coreadPendingChatImages:()=>[],coreadSaveProgress:()=>{},coreadShowRefillChooser:id=>notices.push('refill:'+id),
    coreadLoadDialog:()=>{},document:{querySelector:()=>null},applyQianmuIcons:()=>{},scrollDialogToBottom:()=>{},coreadRefreshAssistantPanel:()=>{},coreadSyncDialogButtons:()=>{},coreadSweepOrphanLore:()=>{},
    coreadCurrentReadBoundarySync:()=>({}),coreadAssistantConfig:()=>({historyMode:'session'}),repairLegacyCoreadDialogMessages:messages=>({messages,changed:false}),
    coreadNormalizeSlices:rows=>rows,coreadSummaryProgressFromRecord:()=>({cursor:0,summaryFloor:0,migrated:false}),
    blobStore:{getBook:async()=>({chapters:[{content:'one'},{content:'two'},{content:'three'}]}),getReaderChat:async()=>null,putReaderChat:async(...args)=>writes.push(args)},
    requestAnimationFrame:cb=>frames.push(cb),console,
  });
  const names=['coreadPersonaChoices','coreadHostPersona','coreadPersona','coreadUserName','coreadApplyIdentityChoice','renderCoreadIdentityChoices',
    'coreadCompanionChoices','coreadCompanionCharacter','coreadCompanionSession','coreadEnsureCompanionSession','coreadSelectCompanion',
    'coreadCompanionMatchesChat','coreadResolveCompanionMacro','companionCharName','coreadDialogBucket','renderCoreadSessionBar','coreadContinueLast','coreadOpenBook','coreadRememberReading','coreadSaveDialog'];
  vm.runInContext(names.map(section).join('\n'),context);
  return {context,host,state,books,legacy,notices,writes,dialog:()=>vm.runInContext('readerDialog',context)};
}

test('first current companion preserves the exact legacy bucket without renaming or merging records',()=>{
  const e=fixture();const session=e.context.coreadEnsureCompanionSession('a.png');
  assert.equal(session.scope,'old-chat');assert.equal(e.context.coreadDialogBucket('book'),'old-chat::book');
  assert.deepEqual(session.worldBooks,['A world']);session.worldBooks.push('extra');assert.deepEqual(e.legacy.coreadCompanionWb.worldBooks,['A world']);
});

test('independent companions use stable avatars, not matching display names or active chat',()=>{
  const e=fixture();e.context.coreadSelectCompanion('b.png');const bucket=e.context.coreadDialogBucket('book');
  assert.equal(e.host.characterId,0);assert.equal(e.host.chatId,'old-chat');assert.notEqual(bucket,'old-chat::book');
  e.host.chatId='another-chat';assert.equal(e.context.coreadDialogBucket('book'),bucket);e.host.characterId=undefined;e.host.chatId='';
  assert.equal(e.context.coreadDialogBucket('book'),bucket);assert.equal(e.context.coreadCompanionCharacter().description,'B {{char}}');
  assert.equal(e.context.coreadCompanionMatchesChat(),false);
});

test('missing saved companion cannot silently fall back to another current character',async()=>{
  const e=fixture();e.context.coreadSelectCompanion('b.png');e.state.lastReading={bookId:'book',avatar:'b.png'};e.host.characters.pop();
  assert.equal(e.context.coreadCompanionCharacter(),null);await e.context.coreadContinueLast();assert.equal(e.context.readerView,null);assert.match(e.notices.at(-1),/书友角色已不存在/);
  assert.equal(e.state.lastReading.avatar,'b.png');assert.match(e.context.renderCoreadSessionBar(),/sd-reader-continue-last/);
});

test('memory work in progress keeps its original companion and book until stopped or finished',async()=>{
  const e=fixture();e.context.coreadSelectCompanion('a.png');e.context.coreadDistilling=true;
  assert.equal(e.context.coreadSelectCompanion('b.png'),false);await e.context.coreadOpenBook('other');
  assert.equal(e.state.companionOverrideAvatar,'a.png');assert.equal(e.context.readerView,null);
});

test('resume restores the previous companion and reading position with no ST chat open',async()=>{
  const e=fixture();e.context.coreadSelectCompanion('a.png');await e.context.coreadOpenBook('book');
  e.context.readerView.chapterIndex=2;e.context.readerView.scrollRatio=.65;e.context.coreadRememberReading();e.context.readerView=null;
  e.context.coreadSelectCompanion('b.png');e.host.characterId=undefined;e.host.chatId='';await e.context.coreadContinueLast();
  assert.equal(e.context.readerView.companionAvatar,'a.png');assert.equal(e.context.readerView.chapterIndex,2);assert.equal(e.context.readerView.scrollRatio,.65);
  assert.equal(e.context.coreadDialogBucket('book'),'old-chat::book');assert.equal(e.host.characterId,undefined);
  assert.equal(e.state.companionOverrideAvatar,'b.png','resume must not rewrite the explicit default companion');
});

test('reading positions remain independent when the same book has two companions',async()=>{
  const e=fixture();e.context.coreadSelectCompanion('a.png');await e.context.coreadOpenBook('book');e.context.readerView.chapterIndex=2;e.context.coreadRememberReading();e.context.readerView=null;
  e.context.coreadSelectCompanion('b.png');await e.context.coreadOpenBook('book');e.context.readerView.chapterIndex=0;e.context.coreadRememberReading();e.context.readerView=null;
  e.context.coreadSelectCompanion('a.png');await e.context.coreadOpenBook('book');assert.equal(e.context.readerView.chapterIndex,2);assert.equal(e.books[0].companionProgress.length,2);
});

test('a slower book read cannot reopen the previous book or navigate back from another tab',async()=>{
  const e=fixture(),reads=new Map();e.context.blobStore.getBook=id=>new Promise(resolve=>reads.set(id,resolve));
  const first=e.context.coreadOpenBook('book'),second=e.context.coreadOpenBook('other');reads.get('other')({chapters:[{}]});await second;
  reads.get('book')({chapters:[{}]});await first;assert.equal(e.context.readerView.bookId,'other');
  e.context.readerView=null;const third=e.context.coreadOpenBook('book');e.context.activeTab='plug';reads.get('book')({chapters:[{}]});await third;assert.equal(e.context.readerView,null);
});

test('missing local book content keeps the resume record and enters the existing refill flow',async()=>{
  const e=fixture();e.state.lastReading={bookId:'book',avatar:'a.png',chapterIndex:2,scrollRatio:.5};e.context.blobStore.getBook=async()=>null;
  await e.context.coreadContinueLast();assert.equal(e.context.readerView,null);assert.equal(e.state.lastReading.scrollRatio,.5);assert.equal(e.notices.at(-1),'refill:book');
});

test('character macros receive the selected card overrides, not the host current role',async()=>{
  const e=fixture();e.context.coreadSelectCompanion('b.png');let argumentsUsed;
  e.host.substituteParams=(...args)=>{argumentsUsed=args;return args[0].replace('{{char}}',args[2]);};
  assert.equal(await e.context.coreadResolveCompanionMacro('Talk {{char}}'),'Talk 同名');
  assert.equal(argumentsUsed[5],false);assert.equal(argumentsUsed[6].description,'B {{char}}');
  assert.match(section('buildCompanionContext'),/cp.chatCtxEnabled && coreadCompanionMatchesChat\(\)/);
  assert.doesNotMatch(section('buildCompanionContext'),/resolveMacro\(getCharacter/);
});

test('out-of-order archive reads cannot overwrite the newly opened companion dialogue',async()=>{
  const e=fixture(),pending=new Map();vm.runInContext(section('coreadLoadDialog'),e.context);
  e.context.blobStore.getReaderChat=key=>new Promise(resolve=>pending.set(key,resolve));
  e.context.coreadSelectCompanion('a.png');e.context.readerView={bookId:'book',companionAvatar:'a.png',companionScope:'old-chat'};
  const first=e.context.coreadLoadDialog('book');e.context.readerView=null;e.context.coreadSelectCompanion('b.png');
  const scope=e.context.coreadCompanionSession().scope;e.context.readerView={bookId:'book',companionAvatar:'b.png',companionScope:scope};const second=e.context.coreadLoadDialog('book');
  pending.get(scope+'::book')({messages:[{text:'B'}],sliceSchemaVersion:3,slices:[]});await second;
  pending.get('old-chat::book')({messages:[{text:'A'}],sliceSchemaVersion:3,slices:[]});await first;
  assert.equal(e.dialog().messages[0].text,'B');assert.equal(e.dialog().bucket,scope+'::book');assert.equal(e.writes.length,0);
});

test('failed or unfinished archive reads cannot save an empty replacement over history',async()=>{
  const e=fixture();vm.runInContext(section('coreadLoadDialog'),e.context);e.context.blobStore.getReaderChat=async()=>{throw Error('offline');};
  await e.context.coreadLoadDialog('book');await e.context.coreadSaveDialog();assert.equal(e.writes.length,0);assert.equal(e.dialog().loaded,false);
});

test('continue is always visible and an empty history neither selects a companion nor opens a book',async()=>{
  const e=fixture();assert.match(e.context.renderCoreadSessionBar(),/sd-reader-continue-last/);
  assert.doesNotMatch(e.context.renderCoreadSessionBar(),/<select/);
  await e.context.coreadContinueLast();assert.match(e.notices.at(-1),/尚无阅读记录/);assert.equal(e.context.readerView,null);assert.equal(e.state.companionOverrideAvatar,undefined);
});

test('opening in follow mode does not pin the current role, and v108 implicit selection is only historical',async()=>{
  const e=fixture();e.state.companionAvatar='b.png';await e.context.coreadOpenBook('book');assert.equal(e.context.readerView.companionAvatar,'a.png');
  e.context.readerView=null;e.host.characterId=1;e.host.chatId='b-chat';await e.context.coreadOpenBook('book');
  assert.equal(e.context.readerView.companionAvatar,'b.png');assert.equal(e.state.companionOverrideAvatar,undefined);
  e.context.readerView=null;e.context.coreadSelectCompanion('a.png');e.context.coreadSelectCompanion('');assert.equal(e.context.coreadCompanionCharacter().avatar,'b.png');
});

test('a book can be read before choosing a companion when no chat is open',async()=>{
  const e=fixture();e.host.characterId=undefined;e.host.chatId='';await e.context.coreadOpenBook('book');
  assert.equal(e.context.readerView.bookId,'book');assert.equal(e.context.coreadCompanionCharacter(),null);assert.equal(e.state.lastReading.avatar,'');
  e.context.readerView=null;e.host.characterId=1;await e.context.coreadContinueLast();assert.equal(e.context.coreadCompanionCharacter(),null,'resume does not invent a previous companion');
});

test('CHAR and USER avatar choices expose a follow option and escaped ST names',()=>{
  const e=fixture();e.host.powerUserSettings={personas:{'u.png':'<user>'}};
  assert.match(e.context.renderCoreadIdentityChoices('user'),/&lt;user>/);assert.match(e.context.renderCoreadIdentityChoices('char'),/跟随当前聊天/);
  assert.match(section('renderCompanionSetupBody'),/renderCoreadIdentity\('我', stUser, userAvatar, 'fa-circle-user', 'user'\)/);
  assert.match(section('renderCoreadIdentity'),/data-coread-identity/);
});

test('USER selection changes persona macros and session scope, not the ST persona or the companion',async()=>{
  const e=fixture();e.host.powerUserSettings={personas:{'u2.png':'Second user'},persona_descriptions:{'u2.png':{description:'Second description'}}};
  await e.context.coreadOpenBook('book');e.dialog().loaded=true;const originalScope=e.context.readerView.companionScope;
  assert.equal(await e.context.coreadApplyIdentityChoice('user','u2.png'),true);
  assert.equal(e.context.coreadUserName(),'Second user');assert.equal(e.host.name1,undefined);assert.equal(e.context.coreadCompanionCharacter().avatar,'a.png');
  assert.notEqual(e.context.readerView.companionScope,originalScope);assert.equal(e.context.coreadCompanionMatchesChat(),false);
  let args;e.host.substituteParams=(...values)=>{args=values;return 'resolved';};await e.context.coreadResolveCompanionMacro('{{user}} {{persona}}');
  assert.equal(args[1],'Second user');assert.equal(args[6].persona,'Second description');
  e.context.readerView=null;e.state.personaOverrideAvatar='';e.host.characterId=undefined;e.host.chatId='';await e.context.coreadContinueLast();
  assert.equal(e.context.coreadUserName(),'Second user');assert.equal(e.state.personaOverrideAvatar,'','resume is not a new USER preference');
});

test('in-reader switching preserves position, isolates identities, and protects unsubmitted text',async()=>{
  const e=fixture();await e.context.coreadOpenBook('book');e.dialog().loaded=true;e.context.readerView.scrollRatio=.6;
  e.context.document.querySelector=()=>({value:'unfinished'});assert.equal(await e.context.coreadApplyIdentityChoice('char','b.png'),false);
  assert.equal(e.context.readerView.companionAvatar,'a.png');e.context.document.querySelector=()=>null;
  assert.equal(await e.context.coreadApplyIdentityChoice('char','b.png'),true);assert.equal(e.context.readerView.scrollRatio,.6);assert.equal(e.host.characterId,0);
});

test('a deleted resumed USER or missing history scope is not replaced by current defaults',async()=>{
  const e=fixture();e.state.lastReading={bookId:'book',avatar:'a.png',userPersona:{key:'gone.png',name:'Gone'}};
  await e.context.coreadContinueLast();assert.equal(e.context.readerView,null);assert.match(e.notices.at(-1),/USER 人设已不存在/);
  e.state.lastReading={bookId:'book',avatar:'a.png',scope:'missing'};await e.context.coreadContinueLast();assert.equal(e.context.readerView,null);assert.equal(e.state.lastReading.scope,'missing');
});

test('a removed explicit companion is not converted into an anonymous reader on normal open',async()=>{
  const e=fixture();e.state.companionOverrideAvatar='gone.png';await e.context.coreadOpenBook('book');
  assert.equal(e.context.readerView,null);assert.match(e.notices.at(-1),/指定的书友已不存在/);
});
