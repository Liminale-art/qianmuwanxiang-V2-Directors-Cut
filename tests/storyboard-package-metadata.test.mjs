import test from 'node:test';
import assert from 'node:assert/strict';
import * as board from '../qianmu-storyboard.js';
import * as mutation from '../qianmu-storyboard-package-mutation.js';
import {prepareStoryboardPackageDraft as draft,mergeStoryboardPackageRows} from '../qianmu-storyboard-package-draft.js';
import {createPackageImportFixture} from './helpers/storyboard-package-fixture.mjs';
import {inspectStoryboardPackageFile} from '../qianmu-storyboard-package-input.js';
import vm from 'node:vm';
import {storyboardFunctionSource as fn} from './helpers/storyboard-form-fixture.mjs';
const image='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';
const blob=settings=>new Blob([JSON.stringify({type:'qianmu-storyboard',version:6,credentialsIncluded:false,settings,chat:{images:[],collections:[]},media:[]})]);
const request=settings=>({settings,chat:{},incoming:{},images:[],collections:[],chatKey:'chat'});
const artist=(id,value='artist tags')=>({id,name:id,value});

test('detached combined libraries resolve references against local assets without mutating either input',()=>{
  const state=board.createStoryboardDefaults();state.artistPresets=[artist('local')];const args=request(state);args.incoming={artistPools:[{id:'pool',name:'Pool',members:[{artistId:'local',weight:1}]}]};const before=JSON.stringify(args);
  const result=draft(args);assert.equal(result.settings.artistPools[0].members[0].artistId,'local');assert.equal(JSON.stringify(args),before);assert.equal(result.settings.artistPresets,undefined,'untouched local fields are not replaced');
});
test('merge caps, duplicates, filtered entries and missing archive bodies are refused rather than clipped',()=>{
  assert.throws(()=>mergeStoryboardPackageRows([{id:'a'}],[{id:'b'}],1,'test'),/超过/);assert.throws(()=>mergeStoryboardPackageRows([],[{id:'a'},{id:'a'}],3,'test'),/重复/);
  const args=request(board.createStoryboardDefaults());args.incoming.artistPresets=[artist('empty','')];assert.throws(()=>draft(args),/完整保留/);
  args.incoming={shotPlans:[{id:'plan',archiveRef:'other-device',shots:[]}]};assert.throws(()=>draft(args),/缺少原文/);
  args.incoming={shotPlans:[{id:'plan',shots:Array.from({length:21},(_,n)=>({id:`shot${n}`}))}]};assert.throws(()=>draft(args),/20/);
});
test('connection credentials are local, preserved for unchanged endpoints only, with draft and selection untouched',()=>{
  const state=board.createStoryboardDefaults(),connection=board.normalizeStoryboardConnectionProfile({id:'connection',baseUrl:'https://local.test',credentialId:'local-secret-id'},'novel');state.connections.novel.presets=[connection];state.connections.novel.activePresetId=connection.id;
  const original=structuredClone(state.connections.novel.draft),args=request(state);args.incoming={connections:{novel:{presets:[{...connection,credentialId:'foreign'}],draft:{baseUrl:'https://foreign.test',credentialId:'foreign'}}}};
  let result=draft(args).settings.connections.novel;assert.equal(result.presets[0].credentialId,'local-secret-id');assert.deepEqual(result.draft,original);assert.equal(result.activePresetId,connection.id);
  args.incoming.connections.novel.presets[0].baseUrl='https://changed.test';result=draft(args).settings.connections.novel;assert.equal(result.presets[0].credentialId,'');assert.deepEqual(state.connections.novel.draft,original);
});
test('imported unfinished plans, shots, tasks and logs become manual history without replaying fees',()=>{
  const args=request(board.createStoryboardDefaults());args.incoming={shotPlans:[{id:'plan',status:'generating',autoGenerate:true,shots:[{id:'shot',status:'queued',prompt:'one'}]}],taskStates:[{id:'task',status:'generating'}],logs:[{id:'log',source:'novel',status:'generating',submissionState:'unknown'}]};
  const result=draft(args).settings;assert.equal(result.shotPlans[0].status,'cancelled');assert.equal(result.shotPlans[0].autoGenerate,false);assert.equal(result.shotPlans[0].manualReviewRequired,true);assert.equal(result.shotPlans[0].shots[0].requiresManualConfirmation,true);
  assert.equal(result.taskStates[0].status,'cancelled');assert.equal(result.logs[0].status,'cancelled');assert.equal(result.logs[0].submissionState,'unknown');assert.equal(args.incoming.logs[0].status,'generating');
});
test('mutation records distinguish missing fields, reject conflicts before any assignment, and preserve unrelated data',async()=>{
  const targets={settings:{promptMode:'manual',custom:'old'},chat:{theater:'keep'}},row=await mutation.createStoryboardMutation({namespace:'st-user:test',chatKey:'chat',fileHash:'a'.repeat(64),...targets,draft:{settings:{promptMode:'combined'},chat:{storyboardImages:[]}}});
  assert.equal(mutation.inspectStoryboardMutation(row,targets).before,2);targets.settings.custom='new';mutation.applyStoryboardMutation(row,targets);assert.equal(targets.settings.custom,'new');assert.equal(targets.chat.theater,'keep');assert.equal(mutation.inspectStoryboardMutation(row,targets).after,2);
  mutation.applyStoryboardMutation(row,targets,'before');assert.equal(Object.hasOwn(targets.chat,'storyboardImages'),false);targets.settings.promptMode='positive';assert.throws(()=>mutation.applyStoryboardMutation(row,targets),/已被修改/);assert.equal(Object.hasOwn(targets.chat,'storyboardImages'),false);
});
test('actual legacy import applies only after durable preparation and retains a recovery record for debounced settings',async()=>{
  const f=createPackageImportFixture();f.e.store.theater={unchanged:true};await f.import(blob({promptMode:'combined',artistPresets:[artist('one')]}));
  assert.equal(f.e.state.promptMode,'combined');assert.equal(f.e.state.artistPresets[0].id,'one');assert.deepEqual(f.e.events,['journal','settings','metadata','applied']);assert.equal(f.e.pending.phase,'applied');assert.deepEqual(f.e.store.theater,{unchanged:true});assert.equal(f.e.notices.at(-1)[1],'info');assert.match(f.e.notices.at(-1)[0],/刷新/);
});
test('actual importer aborts complete merge before confirmation and before saving media when limits exceed',async()=>{
  const f=createPackageImportFixture();f.e.state.artistPresets=Array.from({length:200},(_,n)=>artist(`old${n}`));const before=JSON.stringify(f.e.state);let confirmed=0;f.e.confirm=()=>{confirmed++;return true;};await f.import(blob({artistPresets:[artist('new')]}));
  assert.equal(confirmed,0);assert.equal(JSON.stringify(f.e.state),before);assert.equal(f.e.pending,null);assert.deepEqual(f.e.events,[]);assert.match(f.e.notices.at(-1)[0],/超过/);
});
test('cancel, wrong version, invalid media and interrupted media upload leave live settings and old archives alone',async()=>{
  const f=createPackageImportFixture(),before=JSON.stringify(f.e.state);f.e.confirm=false;await f.import(blob({promptMode:'combined'}));assert.equal(JSON.stringify(f.e.state),before);
  const value=JSON.parse(await blob({promptMode:'combined'}).text());value.version=7;await f.import(new Blob([JSON.stringify(value)]));assert.match(f.e.notices.at(-1)[0],/无效/);value.version=6;value.chat.images=[{id:'image',source:'novel'}];value.media=[{id:'image',mime:'image/png',b64:'bad'}];await f.import(new Blob([JSON.stringify(value)]));assert.equal(f.e.pending,null);
  value.media[0].b64=image;f.e.confirm=true;f.e.upload=async()=>{throw Error('disk full');};await f.import(new Blob([JSON.stringify(value)]));assert.equal(JSON.stringify(f.e.state),before);assert.equal(f.e.pending,null);assert.deepEqual(f.e.events,['media']);
});
test('editing settings during confirmation or switching chat during media upload cannot overwrite current data',async()=>{
  const f=createPackageImportFixture();f.e.confirm=()=>{f.e.state.promptMode='negative';return true;};await f.import(blob({promptMode:'combined'}));assert.equal(f.e.state.promptMode,'negative');assert.equal(f.e.pending,null);assert.match(f.e.notices.at(-1)[0],/已变化/);
  const value=JSON.parse(await blob({promptMode:'combined'}).text());value.chat.images=[{id:'image',source:'novel'}];value.media=[{id:'image',mime:'image/png',b64:image}];f.e.confirm=true;f.e.upload=async()=>{f.e.chatKey='chat-b';f.e.store={other:true};return '/new.png';};await f.import(new Blob([JSON.stringify(value)]));assert.equal(f.e.pending,null);assert.deepEqual(f.e.store,{other:true});
});
test('failed metadata acknowledgement retains recovery, supports explicit revert and never deletes old archives',async()=>{
  const f=createPackageImportFixture();f.e.state.shotPlans=[{id:'old',status:'completed',archiveRef:'preserve-old',shots:[]}];f.e.persist=()=>{throw Error('lost acknowledgement');};await f.import(blob({promptMode:'combined'}));assert.equal(f.e.pending.phase,'uncertain');assert.equal(f.e.state.promptMode,'combined');assert.equal(f.e.state.shotPlans[0].archiveRef,'preserve-old');
  f.e.persist=null;f.e.choice='2';await f.recover();assert.equal(f.e.state.promptMode,'manual');assert.equal(f.e.pending.phase,'applied');assert.equal(f.e.state.shotPlans[0].archiveRef,'preserve-old');
  f.e.choice='3';await f.recover();assert.equal(f.e.pending,null);assert.match(f.e.notices.at(-1)[0],/仅移除本次配置恢复记录/);
});
test('recovery refuses another chat, conflicts and cancelled dismissal, while explicit retain-current is available',async()=>{
  const f=createPackageImportFixture();await f.import(blob({promptMode:'combined'}));f.e.chatKey='chat-b';await f.recover();assert.match(f.e.notices.at(-1)[0],/原聊天/);f.e.chatKey='chat-a';f.e.state.promptMode='negative';f.e.choice='1';await f.recover();assert.equal(f.e.state.promptMode,'negative');assert.match(f.e.notices.at(-1)[0],/未自动覆盖/);
  f.e.choice='3';f.e.confirm=false;await f.recover();assert.ok(f.e.pending);f.e.confirm=true;await f.recover();assert.equal(f.e.pending,null);assert.equal(f.e.state.promptMode,'negative');
});
test('active jobs and missing cross-page locks reject before any settings writes',async()=>{
  const f=createPackageImportFixture();f.context.storyboardActiveJobs.set('job',{});await f.import(blob({promptMode:'combined'}));assert.match(f.e.notices.at(-1)[0],/正在工作/);assert.deepEqual(f.e.events,[]);
  f.context.storyboardActiveJobs.clear();f.context.navigator.locks=null;await f.import(blob({promptMode:'combined'}));assert.match(f.e.notices.at(-1)[0],/导入锁/);assert.deepEqual(f.e.events,[]);
});

test('body revisions are guarded without cloning unrelated huge chat payloads',async()=>{
  const f=createPackageImportFixture();f.e.messages=[{mes:'old',name:'Character',send_date:'2026-01-01',extra:{large:new Uint8Array(1024)}}];f.e.confirm=()=>{f.e.messages[0].mes='edited';return true;};
  await f.import(blob({promptMode:'combined'}));assert.equal(f.e.state.promptMode,'manual');assert.equal(f.e.pending,null);assert.match(f.e.notices.at(-1)[0],/正文在导入期间/);
});
test('legacy routing migration is retained without implicitly enabling automation on partial imports',()=>{
  const state=board.createStoryboardDefaults(),args=request(state);args.incoming={schemaVersion:2,routing:{mode:'ensemble',maxShotsPerFloor:2}};
  const result=draft(args);assert.equal(result.settings.routing.enabled,true);assert.equal(result.settings.enabled,undefined);assert.equal(result.settings.automation,undefined);
});
test('recovery records reject unexpected settings, forged identity and mismatched slot types',async()=>{
  const row=await mutation.createStoryboardMutation({namespace:'st-user:test',chatKey:'chat',fileHash:'a'.repeat(64),settings:{enabled:false},chat:{},draft:{settings:{enabled:true},chat:{}}});
  for(const change of [r=>r.patch[0].key='__proto__',r=>r.patch[0].key='voiceSettings',r=>r.patch[0].after.value={},r=>r.namespace='invalid',r=>r.patch.push(r.patch[0]),r=>r.extra='unsafe',r=>r.phase='committed']){
    const invalid=structuredClone(row);change(invalid);assert.throws(()=>mutation.validateStoryboardMutation(invalid));
  }
});
test('legacy octet-stream or missing media MIME is inferred from validated image bytes, never from a filename',async()=>{
  const value=JSON.parse(await blob({}).text());value.chat.images=[{id:'image',source:'novel'}];value.media=[{id:'image',b64:image}];
  for(const mime of [undefined,'','application/octet-stream']){value.media[0].mime=mime;const result=await inspectStoryboardPackageFile(new Blob([JSON.stringify(value)]),{legacy:true});assert.equal(result.payload.media[0].mime,'image/png');}
  value.media[0].mime='image/webp';await assert.rejects(()=>inspectStoryboardPackageFile(new Blob([JSON.stringify(value)]),{legacy:true}),/不符/);
});
test('archive admission reads only the pending key, pauses during import and preserves originals until explicit dismissal',async()=>{
  const f=createPackageImportFixture();vm.runInContext(fn('storyboardPackageArchiveAllowed'),f.context);let reads=0;f.journal.hasMutation=async()=>{reads++;return Boolean(f.e.pending);};
  assert.equal(await f.context.storyboardPackageArchiveAllowed(),true);assert.equal(reads,1);f.import.busy=true;assert.equal(await f.context.storyboardPackageArchiveAllowed(),false);assert.equal(reads,1);f.import.busy=false;
  await f.import(blob({promptMode:'combined'}));assert.equal(await f.context.storyboardPackageArchiveAllowed(),false);f.e.choice='3';await f.recover();assert.equal(await f.context.storyboardPackageArchiveAllowed(),true);
  f.journal.hasMutation=async()=>{f.e.namespace='st-user:changed';return false;};assert.equal(await f.context.storyboardPackageArchiveAllowed(),false,'late namespace change refuses archive');
});
test('all real archive writers return before any original-body write while recovery is pending',async()=>{
  const writes=[],pipeline={id:'pipeline',status:'success'},state={logs:[{id:'log',pipelineId:'pipeline'}],pipelineLogs:[pipeline]},record={id:'image',snapshot:{prompt:'old'}};
  const context=vm.createContext({storyboardState:()=>state,storyboardGalleryRecords:()=>[record],storyboardPackageArchiveAllowed:async()=>false,storyboardPipelineArchiveEpoch:1,storyboardPipelineArchiveWrites:new Map(),
    storyboardSnapshotEpoch:1,storyboardPlanArchiveEpoch:1,getChatKey:()=> 'chat',storyboardRecordChatKey:()=> 'chat',storyboardSnapshotKey:()=> 'snapshot',sanitizeStoryboardSnapshot:value=>value,
    storyboardPlanHasHeavyPayload:()=>true,storyboardPlanArchiveKey:()=> 'plan',storyboardPlanArchivePayload:plan=>plan,clone:structuredClone,
    blobStore:{blobStoreAvailable:()=>true,putStoryboardSnapshots:async()=>writes.push('snapshot'),putStoryboardPlanArchives:async()=>writes.push('plan'),putStoryboardPipelineLogs:async()=>writes.push('pipeline')}});
  vm.runInContext(['storyboardPipelineIsTerminal','storyboardArchiveCompletedPipelines','storyboardArchivePipelineLog','storyboardArchiveGallerySnapshots','storyboardArchiveShotPlans'].map(fn).join('\n'),context);
  assert.equal(await context.storyboardArchiveCompletedPipelines(),0);assert.equal(await context.storyboardArchivePipelineLog({pipelineId:'pipeline'}),false);assert.equal(await context.storyboardArchiveGallerySnapshots(),0);assert.equal(await context.storyboardArchiveShotPlans([{id:'plan'}]),0);assert.deepEqual(writes,[]);assert.equal(state.pipelineLogs.length,1);assert.ok(record.snapshot);
});
