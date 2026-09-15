import test from 'node:test';
import assert from 'node:assert/strict';
import * as draft from '../qianmu-character-chat-draft.js';
import {createStoryboardMessageReference} from '../qianmu-storyboard.js';
import {QIANMU_NARRATIVE_CONTEXT_SCHEMA} from '../qianmu-narrative-context.js';

const owner={namespace:'st-user:alice',chatKey:'chat-a'},id='12345678-1234-4234-8234-123456789abc';
const reference=createStoryboardMessageReference({chatKey:owner.chatKey,message:{mes:'A stranger appears.',name:'Narrator',send_date:1},floor:2,now:1});
const source={kind:'body',chatKey:owner.chatKey,messageKey:reference.messageKey,revisionId:reference.revisionId,characterId:'C1'};
const character={id:'C1',name:'Stranger',identity:['silver hair'],outfit:['red coat'],action:['runs'],ageStatus:'adult',sensitiveAppearance:'PRIVATE',subjectKey:'user:fake',negative:'not a positive trait'};
const create=options=>draft.createChatCharacterDraft({owner,id,source,character,...options});
const edit=(row,patch)=>draft.editChatCharacterDraft(row,patch,{owner,expectedRevision:row.revision});
const status=(row,action)=>draft.setChatCharacterDraftStatus(row,action,{owner,expectedRevision:row.revision});
const observation=row=>({source:{...source,revisionId:'next-revision',characterId:row.subjectId},character:{id:row.subjectId,name:'Renamed',identity:['black hair']}});

test('body extraction becomes a bounded chat-only draft without inventing identity or engine fields',()=>{
  const row=create();assert.equal(row.subjectId,`chat-character:${id}`);assert.equal(row.status,'detected');assert.equal(row.document.category,'other');
  assert.equal(row.document.imagegen.appearance,'silver hair');assert.equal(row.document.ageStatus,'unknown');
  assert.equal(row.document.imagegen.negative,'');assert.equal(row.document.imagegen.sensitiveAppearance,'');assert.equal(row.document.imagegen.reference,null);
  assert.equal(row.hostSubject,null);assert.ok(Object.isFrozen(row.document.imagegen));assert.deepEqual(row.source,source);
  assert.doesNotMatch(JSON.stringify(row),/red coat|runs|PRIVATE|user:fake/);
  const empty=create({character:{id:'C1',name:'Unknown',identity:[]}});assert.equal(empty.document.imagegen.appearance,'');
});
test('same name and recycled local shot IDs never determine a cross-chat or cross-person identity',()=>{
  const first=create(),second=create({id:'12345678-1234-4234-8234-123456789abd'});
  assert.notEqual(first.subjectId,second.subjectId);
  assert.throws(()=>draft.observeChatCharacterDraft(first,{source,character},{owner,expectedRevision:1}),/同名/);
  for(const scope of [{...owner,chatKey:'chat-b'},{...owner,namespace:'st-user:bob'}]){
    assert.throws(()=>draft.normalizeChatCharacterDraft(first,scope),/另一/);
    assert.throws(()=>draft.chatCharacterDraftInput([first],scope),/另一/);
    assert.throws(()=>draft.prepareChatCharacterPromotion(first,{owner:scope,expectedRevision:1,confirmed:true}),/另一/);
  }
});
test('host CHAR and USER categories require explicitly supplied host keys, never model names',()=>{
  for(const target of [{category:'char',subjectKey:'char:Alice.png'},{category:'user',subjectKey:'user:/User%20Avatars/Me.png'}]){
    assert.throws(()=>create({hostSubject:target}),/未确认/);
    const row=create({hostSubject:target,hostSubjects:[target]});assert.equal(row.document.category,target.category);
    if(target.category==='user')assert.equal(row.hostSubject.subjectKey,'user:/User Avatars/Me.png');
  }
  assert.throws(()=>create({hostSubject:{category:'user',subjectKey:'user:Stranger'},hostSubjects:[{category:'user',subjectKey:'user:Stranger'}]}),/USER/);
});
test('present-but-invalid ownership, provenance and versions cannot become legacy unscoped drafts',()=>{
  const row=create();
  for(const patch of [{schema:'future'},{invalid:true},{revision:0},{id:'C1'},{subjectId:'C1'},{owner:null},{source:null},{source:{...source,invalid:true}},{hostSubject:undefined},{status:'promoted'},
    {owner:{...owner,namespace:'st-user:a\n'}},{lastObserved:{...source,chatKey:'chat-b'}},{userEditedFields:['name','name']}]){
    assert.throws(()=>draft.normalizeChatCharacterDraft({...row,...patch},owner));
  }
  assert.throws(()=>create({source:{...source,characterId:'C2'}}));
  assert.throws(()=>create({character:{...character,archiveSnapshot:{archiveId:'known'}}}));
  assert.throws(()=>create({character:{...character,visible:false}}));
  assert.throws(()=>create({character:{...character,identity:['x'.repeat(501)]}}));
});
test('world predictions, parallels and unknown narrative contexts cannot masquerade as body discoveries',()=>{
  const narrativeContext={schema:QIANMU_NARRATIVE_CONTEXT_SCHEMA,chatKey:owner.chatKey,branch:{kind:'mainline',id:'mainline',fork:null},
    claim:'fact',time:{layer:'present',label:''},knowledge:{knownBy:[],hiddenFrom:[]}};
  assert.equal(create({source:{...source,narrativeContext}}).source.narrativeContext.claim,'fact');
  assert.throws(()=>create({source:{...source,kind:'simulation'}}));
  for(const change of [{claim:'prediction'},{claim:'unknown'},{time:{layer:'future',label:''}},
    {branch:{kind:'parallel',id:'other',fork:{branchId:'mainline',recordId:'r',revisionId:'v'}}},{chatKey:'chat-b'},{schema:'future'}]){
    assert.throws(()=>create({source:{...source,narrativeContext:{...narrativeContext,...change}}}));
  }
});
test('editing locks user choices including deliberately emptied appearance against future observations',()=>{
  const original=create(),before=structuredClone(original),edited=edit(original,{name:'User name',appearance:'',negative:'PRIVATE NEGATIVE',ageStatus:'adult',sensitiveAppearance:'PRIVATE FIELD'});
  const next=draft.observeChatCharacterDraft(edited,observation(edited),{owner,expectedRevision:edited.revision});
  assert.equal(next.document.name,'User name');assert.equal(next.document.imagegen.appearance,'');assert.equal(next.document.imagegen.negative,'PRIVATE NEGATIVE');
  assert.equal(next.document.imagegen.sensitiveAppearance,'PRIVATE FIELD');assert.equal(next.revision,3);assert.deepEqual(original,before);
  const rows=draft.chatCharacterDraftInput([next],owner);assert.equal(rows[0].base_appearance,'');assert.equal(rows[0].provisional,true);
  assert.doesNotMatch(JSON.stringify(rows),/st-user:|chat-a|PRIVATE|negative|sensitive|subjectKey/);
});
test('a model may update an unconfirmed draft only by its stable ID, preserving birth source and old snapshots',()=>{
  const row=create(),saved=JSON.stringify(row),next=draft.observeChatCharacterDraft(row,observation(row),{owner,expectedRevision:1});
  assert.equal(next.document.name,'Renamed');assert.equal(next.document.imagegen.appearance,'black hair');assert.equal(next.revision,2);
  assert.deepEqual(next.source,row.source);assert.equal(next.lastObserved.revisionId,'next-revision');assert.equal(JSON.stringify(row),saved);
  assert.deepEqual(draft.observeChatCharacterDraft(next,observation(next),{owner,expectedRevision:2}),next);
});
test('confirmed and rejected drafts resist automatic rewriting; rejection remains a recoverable tombstone',()=>{
  const row=create(),confirmed=status(row,'confirm'),rejected=status(confirmed,'reject');
  for(const value of [confirmed,rejected])assert.deepEqual(draft.observeChatCharacterDraft(value,observation(value),{owner,expectedRevision:value.revision}),value);
  assert.deepEqual(draft.chatCharacterDraftInput([rejected],owner),[]);assert.equal(draft.chatCharacterDraftInput([confirmed],owner)[0].provisional,false);
  assert.throws(()=>status(rejected,'confirm'));assert.throws(()=>edit(rejected,{name:'No'}));assert.throws(()=>status(row,'restore'));
  const restored=status(rejected,'restore');assert.equal(restored.status,'detected');assert.equal(restored.id,row.id);assert.deepEqual(restored.document,row.document);
});
test('stale revisions, unknown edits and unsafe limits fail before altering any source',()=>{
  const row=create(),before=JSON.stringify(row);
  assert.throws(()=>draft.editChatCharacterDraft(row,{name:'Changed'},{owner,expectedRevision:0}),/最新版本/);
  assert.throws(()=>draft.setChatCharacterDraftStatus(row,'reject',{owner,expectedRevision:0}),/最新版本/);
  for(const patch of [{subjectKey:'user:fake'},{category:'user'},{appearance:'a'.repeat(12001)},{ageStatus:'assumed'},{aliases:Array(25).fill('x')},{}])assert.throws(()=>edit(row,patch));
  assert.throws(()=>edit({...row,revision:Number.MAX_SAFE_INTEGER},{name:'Changed'}),/上限/);assert.equal(JSON.stringify(row),before);
});
test('only explicit fixed-save intent exports the current revision; it never claims a successful write or binds globally',()=>{
  const row=edit(create(),{negative:'personal negative'}),before=JSON.stringify(row);
  assert.throws(()=>draft.prepareChatCharacterPromotion(row,{owner,expectedRevision:row.revision}));
  const plan=draft.prepareChatCharacterPromotion(row,{owner,expectedRevision:row.revision,confirmed:true});
  assert.equal(plan.draftRevision,row.revision);assert.deepEqual(plan.document,row.document);assert.equal(plan.createOnly,true);assert.equal(plan.automaticBinding,false);
  assert.equal(plan.saved,undefined);assert.equal(plan.archiveId,undefined);assert.ok(Object.isFrozen(plan.document));assert.equal(JSON.stringify(row),before);
  assert.throws(()=>draft.prepareChatCharacterPromotion(status(row,'reject'),{owner,expectedRevision:row.revision+1,confirmed:true}));
});
test('catalogues fail on duplicates and size limits instead of merging names or truncating descriptions',()=>{
  const row=create();assert.throws(()=>draft.chatCharacterDraftInput([row,row],owner),/编号重复/);
  assert.throws(()=>draft.chatCharacterDraftInput(Array(65).fill(row),owner),/64 项/);
  const large=Array.from({length:8},(_,i)=>edit(create({id:`12345678-1234-4234-8234-${String(i).padStart(12,'0')}`}),{appearance:'x'.repeat(12000)}));
  assert.throws(()=>draft.chatCharacterDraftInput(large,owner),/64 KB/);
});
