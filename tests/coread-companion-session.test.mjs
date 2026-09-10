import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as reader from '../qianmu-reader.js';
import * as identityView from '../qianmu-reader-identity-view.js';
import {readFile} from 'node:fs/promises';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

function fixture(){
  const host={chatId:'old-chat',characterId:0,characters:[{name:'同名',avatar:'a.png',description:'A {{char}}'},{name:'同名',avatar:'b.png',description:'B {{char}}'}]};
  const books=[{id:'book',title:'Book',lastChapterIndex:1,lastScrollRatio:.2},{id:'other',title:'Other'}],state={books};
  const legacy={coreadCompanionWb:{worldBooks:['A world'],worldItems:{}}},notices=[],writes=[],frames=[];
  const context=vm.createContext({...identityView,ctx:()=>host,coread:()=>state,getChatKey:()=>host.chatId||String(host.characterId??'default'),getChatStore:()=>legacy,
    clone:structuredClone,isPlainObject:x=>!!x&&typeof x==='object'&&!Array.isArray(x),coreadBookMeta:id=>books.find(b=>b.id===id),
    getPersonaName:()=>host.name1 || 'User',getPersonaDescription:()=>host.persona_description || 'User desc',coreadPersonaAvatarRaw:'',URL,
    htmlEscape:x=>String(x??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),
    coreadDistilling:false,coreadAutoTextInFlight:false,coreadMemoryWrites:0,coreadIdentitySwitchBusy:false,coreadWorldSyncBusy:false,readerView:null,readerContentCache:null,coreadOpenRequestId:0,activeTab:'coread',readerAssistant:{},readerDialog:{bucket:'',loaded:false},readerAssistantSessions:new Map(),
    reader,coreadVectorStates:new Map(),coreadVecCache:null,MODULE_NAME:'fixture',coreadMaybeAutoDistillText:()=>{},
    focusClockActiveLock:()=>null,focusClockBlockExit:()=>false,focusClockRememberLockedReader:()=>{},focusClockResumeReading:()=>{},focusClockPauseForReadingExit:()=>{},
    toast:text=>notices.push(text),saveSettings:()=>{},coreadInvalidatePool:()=>{},renderModal:()=>{},refreshReaderPortal:()=>{},nowMs:()=>1,
    coreadStopDialog:()=>{},coreadStopAssistant:()=>{},ttsStopPlayback:()=>{},coreadPendingChatImages:()=>[],coreadSaveProgress:()=>{},coreadShowRefillChooser:id=>notices.push('refill:'+id),
    coreadLoadDialog:()=>{},document:{querySelector:()=>null},applyQianmuIcons:()=>{},scrollDialogToBottom:()=>{},coreadRefreshAssistantPanel:()=>{},coreadSyncDialogButtons:()=>{},coreadSweepOrphanLore:()=>{},
    coreadCurrentReadBoundarySync:bookId=>({bookId,readTo:100,chapterIndex:1,progress:10}),coreadAssistantConfig:()=>({historyMode:'session'}),repairLegacyCoreadDialogMessages:messages=>({messages,changed:false}),
    coreadNormalizeSlices:rows=>rows,coreadSummaryProgressFromRecord:()=>({cursor:0,summaryFloor:0,migrated:false}),
    blobStore:{getBook:async()=>({chapters:[{content:'one'},{content:'two'},{content:'three'}]}),getReaderChat:async()=>null,putReaderChat:async(...args)=>writes.push(args)},
    requestAnimationFrame:cb=>frames.push(cb),console,
  });
  const names=['coreadPersonaChoices','coreadHostPersona','coreadPersona','coreadUserName','coreadApplyIdentityChoice','renderCoreadIdentityChoices',
    'coreadCompanionChoices','coreadCompanionCharacter','coreadCompanionSession','coreadEnsureCompanionSession','coreadSelectCompanion',
    'coreadCompanionMatchesChat','coreadResolveCompanionMacro','companionCharName','coreadDialogBucket','coreadOpenBook','coreadSaveProgress','coreadSaveDialog'];
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
  assert.equal(e.context.coreadCompanionCharacter(),null);await e.context.coreadOpenBook('book');assert.equal(e.context.readerView,null);assert.match(e.notices.at(-1),/书友已不存在/);
  assert.equal(e.state.lastReading.avatar,'b.png','legacy snapshots remain untouched');
});

test('memory work in progress keeps its original companion and book until stopped or finished',async()=>{
  const e=fixture();e.context.coreadSelectCompanion('a.png');e.context.coreadDistilling=true;
  assert.equal(e.context.coreadSelectCompanion('b.png'),false);await e.context.coreadOpenBook('other');
  assert.equal(e.state.companionOverrideAvatar,'a.png');assert.equal(e.context.readerView,null);
});

test('ordinary opening preserves shared book position with a selected companion and no ST chat open',async()=>{
  const e=fixture();e.context.coreadSelectCompanion('a.png');await e.context.coreadOpenBook('book');
  e.context.readerView.chapterIndex=2;e.context.readerView.scrollRatio=.65;e.context.coreadSaveProgress();e.context.readerView=null;
  e.context.coreadSelectCompanion('b.png');e.host.characterId=undefined;e.host.chatId='';await e.context.coreadOpenBook('book');
  assert.equal(e.context.readerView.companionAvatar,'b.png');assert.equal(e.context.readerView.chapterIndex,2);assert.equal(e.context.readerView.scrollRatio,.65);
  assert.notEqual(e.context.coreadDialogBucket('book'),'old-chat::book');assert.equal(e.host.characterId,undefined);
});

test('one book has one reading position regardless of obsolete companion progress snapshots',async()=>{
  const e=fixture();e.books[0].companionProgress=[{scope:'old-chat',chapterIndex:0,scrollRatio:0}];
  e.context.coreadSelectCompanion('a.png');await e.context.coreadOpenBook('book');e.context.readerView.chapterIndex=2;e.context.readerView.scrollRatio=.7;e.context.coreadSaveProgress();e.context.readerView=null;
  e.context.coreadSelectCompanion('b.png');await e.context.coreadOpenBook('book');assert.equal(e.context.readerView.chapterIndex,2);assert.equal(e.context.readerView.scrollRatio,.7);
  e.context.readerView.scrollRatio=.8;e.context.coreadSaveProgress();e.context.readerView=null;
  e.context.coreadSelectCompanion('a.png');await e.context.coreadOpenBook('book');assert.equal(e.context.readerView.chapterIndex,2);assert.equal(e.context.readerView.scrollRatio,.8);
  assert.equal(e.books[0].companionProgress[0].chapterIndex,0,'legacy snapshots are retained, not rewritten');
});

test('a slower book read cannot reopen the previous book or navigate back from another tab',async()=>{
  const e=fixture(),reads=new Map();e.context.blobStore.getBook=id=>new Promise(resolve=>reads.set(id,resolve));
  const first=e.context.coreadOpenBook('book'),second=e.context.coreadOpenBook('other');reads.get('other')({chapters:[{}]});await second;
  reads.get('book')({chapters:[{}]});await first;assert.equal(e.context.readerView.bookId,'other');
  e.context.readerView=null;const third=e.context.coreadOpenBook('book');e.context.activeTab='plug';reads.get('book')({chapters:[{}]});await third;assert.equal(e.context.readerView,null);
});

test('missing local book content preserves position and enters the existing refill flow',async()=>{
  const e=fixture();e.state.lastReading={bookId:'book',avatar:'a.png',chapterIndex:2,scrollRatio:.5};e.context.blobStore.getBook=async()=>null;
  await e.context.coreadOpenBook('book');assert.equal(e.context.readerView,null);assert.equal(e.books[0].lastScrollRatio,.2);assert.equal(e.state.lastReading.scrollRatio,.5);assert.equal(e.notices.at(-1),'refill:book');
});

test('cancelled caller admission cannot paint or refill a book after its asynchronous read',async()=>{
  for(const content of [null,{chapters:[{content:'old'}]}]) {
    const e=fixture(),trace=[];let current=true,resolve,reads=0;
    e.context.blobStore.getBook=()=>{reads++;return new Promise(done=>resolve=done);};
    e.context.renderModal=()=>trace.push('render');e.context.focusClockResumeReading=()=>trace.push('resume');
    const before=JSON.stringify(e.books),run=e.context.coreadOpenBook('book',{isCurrent:()=>current});
    const replacement={bookId:'replacement'};e.context.readerView=replacement;current=false;resolve(content);await run;
    assert.equal(e.context.readerView,replacement);assert.equal(JSON.stringify(e.books),before);
    assert.deepEqual(trace,[]);assert.deepEqual(e.notices,[]);
    await e.context.coreadOpenBook('book',{isCurrent:()=>false});assert.equal(reads,1,'already cancelled calls must not read');
  }
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

test('continue is removed instead of retaining a competing navigation or progress path',async()=>{
  const source=await readFile(new URL('../index.js',import.meta.url),'utf8');
  assert.doesNotMatch(source,/coreadContinueLast|coreadRememberReading|renderCoreadSessionBar|sd-reader-continue-last/);
  assert.doesNotMatch(section('coreadOpenBook'),/companionProgress|lastReading|resume/);
});

test('opening in follow mode does not pin the current role, and v108 implicit selection is only historical',async()=>{
  const e=fixture();e.state.companionAvatar='b.png';await e.context.coreadOpenBook('book');assert.equal(e.context.readerView.companionAvatar,'a.png');
  e.context.readerView=null;e.host.characterId=1;e.host.chatId='b-chat';await e.context.coreadOpenBook('book');
  assert.equal(e.context.readerView.companionAvatar,'b.png');assert.equal(e.state.companionOverrideAvatar,undefined);
  e.context.readerView=null;e.context.coreadSelectCompanion('a.png');e.context.coreadSelectCompanion('');assert.equal(e.context.coreadCompanionCharacter().avatar,'b.png');
});

test('a book can be read before choosing a companion when no chat is open',async()=>{
  const e=fixture();e.host.characterId=undefined;e.host.chatId='';await e.context.coreadOpenBook('book');
  assert.equal(e.context.readerView.bookId,'book');assert.equal(e.context.coreadCompanionCharacter(),null);assert.equal(e.state.lastReading,undefined);
  e.context.readerView=null;e.host.characterId=1;await e.context.coreadOpenBook('book');assert.equal(e.context.coreadCompanionCharacter().avatar,'b.png');
});

test('CHAR and USER avatar choices expose a follow option and escaped ST names',()=>{
  const e=fixture();e.host.powerUserSettings={personas:{'u.png':'<user>'}};
  assert.match(e.context.renderCoreadIdentityChoices('user'),/&lt;user>/);assert.match(e.context.renderCoreadIdentityChoices('char'),/跟随当前聊天/);
  assert.match(e.context.renderCoreadIdentityChoices('char'),/>选择书友</);assert.match(e.context.renderCoreadIdentityChoices('user'),/>选择人设</);
  assert.match(section('renderCompanionSetupBody'),/renderCoreadIdentity\('我', stUser, userAvatar, 'fa-circle-user', 'user'\)/);
  assert.match(identityView.renderCoreadIdentityView.toString(),/data-coread-identity/);
});

test('USER selection changes persona macros and session scope, not the ST persona or the companion',async()=>{
  const e=fixture();e.host.powerUserSettings={personas:{'u2.png':'Second user'},persona_descriptions:{'u2.png':{description:'Second description'}}};
  await e.context.coreadOpenBook('book');Object.assign(e.dialog(),{loaded:true,bucket:e.context.coreadDialogBucket('book')});const originalScope=e.context.readerView.companionScope;
  assert.equal(await e.context.coreadApplyIdentityChoice('user','u2.png'),true);
  assert.equal(e.context.coreadUserName(),'Second user');assert.equal(e.host.name1,undefined);assert.equal(e.context.coreadCompanionCharacter().avatar,'a.png');
  assert.notEqual(e.context.readerView.companionScope,originalScope);assert.equal(e.context.coreadCompanionMatchesChat(),false);
  let args;e.host.substituteParams=(...values)=>{args=values;return 'resolved';};await e.context.coreadResolveCompanionMacro('{{user}} {{persona}}');
  assert.equal(args[1],'Second user');assert.equal(args[6].persona,'Second description');
  e.context.readerView=null;e.host.characterId=undefined;e.host.chatId='';await e.context.coreadOpenBook('book');
  assert.equal(e.context.coreadUserName(),'Second user');assert.equal(e.state.personaOverrideAvatar,'u2.png');
});

test('in-reader switching preserves position, isolates identities, and protects unsubmitted text',async()=>{
  const e=fixture();await e.context.coreadOpenBook('book');Object.assign(e.dialog(),{loaded:true,bucket:e.context.coreadDialogBucket('book')});e.context.readerView.scrollRatio=.6;
  e.context.document.querySelector=()=>({value:'unfinished'});assert.equal(await e.context.coreadApplyIdentityChoice('char','b.png'),false);
  assert.equal(e.context.readerView.companionAvatar,'a.png');e.context.document.querySelector=()=>null;
  assert.equal(await e.context.coreadApplyIdentityChoice('char','b.png'),true);assert.equal(e.context.readerView.scrollRatio,.6);assert.equal(e.host.characterId,0);
});

test('a deleted explicit USER is not replaced by the host default',async()=>{
  const e=fixture();e.state.personaOverrideAvatar='gone.png';
  await e.context.coreadOpenBook('book');assert.equal(e.context.readerView,null);assert.match(e.notices.at(-1),/USER 人设已不存在/);
});

test('a removed explicit companion is not converted into an anonymous reader on normal open',async()=>{
  const e=fixture();e.state.companionOverrideAvatar='gone.png';await e.context.coreadOpenBook('book');
  assert.equal(e.context.readerView,null);assert.match(e.notices.at(-1),/指定的书友已不存在/);
});

test('failed archive save blocks identity switching without discarding the old dialogue',async()=>{
  const e=fixture();await e.context.coreadOpenBook('book');
  Object.assign(e.dialog(),{loaded:true,bucket:e.context.coreadDialogBucket('book'),messages:[{text:'unsaved'}]});
  e.context.blobStore.putReaderChat=async()=>{throw Error('storage unavailable');};
  assert.equal(await e.context.coreadApplyIdentityChoice('char','b.png'),false);
  assert.equal(e.context.readerView.companionAvatar,'a.png');assert.equal(e.dialog().messages[0].text,'unsaved');
  assert.equal(e.context.coreadIdentitySwitchBusy,false);assert.equal(e.state.companionOverrideAvatar,undefined);
});

test('every asynchronous memory mutation blocks identity changes while its owner is being saved',async()=>{
  for(const flag of ['coreadMemoryWrites','coreadIdentitySwitchBusy','coreadWorldSyncBusy','coreadAutoTextInFlight']){
    const e=fixture();vm.runInContext(`${flag}=1`,e.context);
    assert.equal(e.context.coreadSelectCompanion('b.png'),false,flag);
    assert.equal(await e.context.coreadApplyIdentityChoice('user',''),false,flag);
    await e.context.coreadOpenBook('book');assert.equal(e.context.readerView,null,flag);
  }
  for(const name of ['coreadDistillMainline','coreadRegenSlice','coreadSaveSliceEdit','coreadDeleteSlice','coreadClearAllSlices','coreadMigrateFromChat']){
    assert.match(section(name),/coreadMemoryWrites\+\+;\s*try\s*\{/);
    assert.match(section(name),/finally\s*\{ coreadMemoryWrites--; \}/);
  }
});

test('same-book companion archives round-trip separately while the reading position remains shared',async()=>{
  const e=fixture(),records=new Map();
  vm.runInContext(section('coreadLoadDialog'),e.context);
  e.context.blobStore.getReaderChat=async key=>structuredClone(records.get(key));
  e.context.blobStore.putReaderChat=async(key,value)=>records.set(key,structuredClone(value));
  e.context.coreadNormalizeSlices=(rows,bookId,bucket,boundary)=>rows.map(s=>reader.normalizeCoreadSlice(s,{bookId,bucket,boundary}));
  await e.context.coreadOpenBook('book');await e.context.coreadLoadDialog('book');
  const aBucket=e.dialog().bucket;
  e.dialog().messages=[{text:'A chapter one'}];e.dialog().slices=[reader.normalizeCoreadSlice({id:'same-id',summary:'A only',src:'text',coveredTo:100},{bookId:'book',bucket:aBucket,boundary:{readTo:100,chapterIndex:0,progress:10}})];
  e.dialog().readBoundary={bookId:'book',readTo:100,chapterIndex:0,progress:10};await e.context.coreadSaveDialog();
  assert.equal(records.get(aBucket).readBoundary.readTo,100);
  await e.context.coreadApplyIdentityChoice('char','b.png');await e.context.coreadLoadDialog('book');
  assert.equal(e.dialog().slices.length,0);assert.equal(e.dialog().messages.length,0);const bBucket=e.dialog().bucket;
  e.context.readerView.chapterIndex=2;e.context.readerView.scrollRatio=.8;e.context.coreadSaveProgress({summarize:false});
  e.dialog().messages=[{text:'B chapter three'}];e.dialog().slices=[reader.normalizeCoreadSlice({id:'same-id',summary:'B only',src:'text',coveredTo:800},{bookId:'book',bucket:bBucket,boundary:{readTo:800,chapterIndex:2,progress:80}})];
  await e.context.coreadApplyIdentityChoice('char','a.png');await e.context.coreadLoadDialog('book');
  assert.equal(e.context.readerView.chapterIndex,2);assert.equal(e.context.readerView.scrollRatio,.8);
  assert.equal(e.dialog().messages[0].text,'A chapter one');assert.equal(e.dialog().slices[0].summary,'A only');
  assert.equal(e.dialog().slices[0].provenance.readTo,100);assert.equal(e.dialog().slices[0].provenance.bucket,aBucket);
  assert.equal(records.get(bBucket).slices[0].provenance.readTo,800);
  assert.equal(reader.filterCoreadSlicesAtBoundary(records.get(bBucket).slices,{bookId:'book',readTo:200,chapterIndex:0},true).length,0,'future-stage memory must stay hidden when reading backwards');
});

test('legacy slices use the archived boundary instead of another companion latest book progress',async()=>{
  const e=fixture();vm.runInContext(section('coreadLoadDialog'),e.context);
  e.context.coreadCurrentReadBoundarySync=()=>({bookId:'book',readTo:900,chapterIndex:2,progress:90});
  e.context.coreadNormalizeSlices=(rows,bookId,bucket,boundary)=>rows.map(s=>reader.normalizeCoreadSlice(s,{bookId,bucket,boundary}));
  e.context.blobStore.getReaderChat=async()=>({messages:[{text:'old'}],slices:[{id:'legacy',summary:'at 10%',src:'dialog'}],readBoundary:{bookId:'book',readTo:100,chapterIndex:0,progress:10}});
  await e.context.coreadLoadDialog('book');
  assert.equal(e.dialog().slices[0].provenance.readTo,100);assert.equal(e.dialog().readBoundary.readTo,900);
});

test('a memory operation starting during archive save cancels the pending identity switch',async()=>{
  const e=fixture();await e.context.coreadOpenBook('book');Object.assign(e.dialog(),{loaded:true,bucket:e.context.coreadDialogBucket('book')});
  e.context.blobStore.putReaderChat=async()=>{e.context.coreadMemoryWrites=1;};
  assert.equal(await e.context.coreadApplyIdentityChoice('char','b.png'),false);assert.equal(e.context.readerView.companionAvatar,'a.png');
});

test('a memory operation starting during content retrieval keeps the original book open',async()=>{
  const e=fixture();await e.context.coreadOpenBook('book');
  e.context.blobStore.getBook=async()=>{e.context.coreadMemoryWrites=1;return {chapters:[{}]};};
  await e.context.coreadOpenBook('other');assert.equal(e.context.readerView.bookId,'book');
});

test('restoring a reading lock preserves its companion identity without reviving continue-last progress',async()=>{
  const e=fixture();const session=e.context.coreadEnsureCompanionSession('a.png');
  e.books[0].lastChapterIndex=2;e.books[0].lastScrollRatio=.8;
  e.context.focusClockActiveLock=()=>({activity:'reading',bookId:'book',reader:{avatar:'a.png',scope:session.scope,persona:{key:'',name:'User',description:'User desc'}}});
  e.host.characterId=1;e.host.chatId='another';await e.context.coreadOpenBook('book');
  assert.equal(e.context.readerView.companionAvatar,'a.png');assert.equal(e.context.readerView.companionScope,session.scope);
  assert.equal(e.context.readerView.chapterIndex,2);assert.equal(e.context.readerView.scrollRatio,.8);assert.equal(e.host.characterId,1);
  assert.equal(e.state.companionOverrideAvatar,undefined);
});

test('an active reading lock cannot open another book or silently replace a missing companion',async()=>{
  const e=fixture();e.context.focusClockActiveLock=()=>({activity:'reading',bookId:'book',reader:{avatar:'gone',scope:'old-chat',persona:{key:'',name:'User'}}});
  await e.context.coreadOpenBook('other');assert.equal(e.context.readerView,null);
  await e.context.coreadOpenBook('book');assert.equal(e.context.readerView,null);assert.match(e.notices.at(-1),/书友已不存在/);
});
