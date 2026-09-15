import test from 'node:test';
import assert from 'node:assert/strict';
import * as batch from '../qianmu-character-chat-batch.js';
import {editChatCharacterDraft,setChatCharacterDraftStatus} from '../qianmu-character-chat-draft.js';
import {migrateQianmuChatStoreV2} from '../qianmu-data-migrations.js';

const owner={namespace:'st-user:fixture',chatKey:'chat-a'},source={kind:'body',chatKey:'chat-a',messageKey:'message-1',revisionId:'revision-1'};
const person=(id='C1',name='Alice')=>({id,name,identity:['silver hair'],outfit:['red coat']});
const empty=()=>batch.emptyChatCharacterCollection(owner);
const uuid=index=>`12345678-1234-4234-8234-${String(index).padStart(12,'0')}`;
function prepare(collection=empty(),characters=[person()],options={}){
  let count=0;
  return batch.prepareChatCharacterBatch(collection,{source,characters,...options},{owner,expectedRevision:collection.revision,createId:()=>uuid(++count+collection.items.length)});
}
const reject=(collection,id)=>{
  const row=collection.items.find(row=>row.id===id);
  return batch.replaceChatCharacterDraft(collection,setChatCharacterDraftStatus(row,'reject',{owner,expectedRevision:row.revision}),{owner,expectedRevision:collection.revision});
};

test('multiple shots share one new draft without changing source characters, clothes or the original collection',()=>{
  const original=empty(),characters=[person(),{...person(),outfit:['blue coat']},person('C2','Bob')],saved=JSON.stringify([original,characters]);
  const result=prepare(original,characters);assert.equal(result.collection.items.length,2);assert.equal(result.collection.revision,1);assert.equal(result.assignments.length,2);
  assert.equal(result.warnings.length,0);assert.equal(JSON.stringify([original,characters]),saved);
  const repeat=prepare(result.collection,characters);assert.equal(repeat.changed,false);assert.deepEqual(repeat.collection,result.collection);
});
test('different people with the same name in one batch remain distinct, never joined by aliases',()=>{
  const result=prepare(empty(),[person('C1'),person('C2')]);assert.equal(result.collection.items.length,2);
  assert.notEqual(result.assignments[0].subjectId,result.assignments[1].subjectId);
});
test('recycled local IDs in later body revisions need identity confirmation rather than creating or lending a same-name draft',()=>{
  const first=prepare().collection,result=prepare(first,[person()],{source:{...source,messageKey:'message-2',revisionId:'revision-2'}});
  assert.equal(result.changed,false);assert.equal(result.assignments.length,0);assert.equal(result.warnings[0].reason,'name_needs_confirmation');
  const unknown=prepare(first,[person(`chat-character:${uuid(999)}`)]);assert.equal(unknown.changed,false);assert.equal(unknown.warnings[0].reason,'unknown_identity');
  const swapped=prepare(first,[person('C1','Bob')]);assert.equal(swapped.changed,false);assert.equal(swapped.warnings[0].reason,'identity_conflict');
});
test('known stable IDs update only their provisional draft with a new body source and preserve the old version',()=>{
  const old=prepare().collection,row=old.items[0],saved=JSON.stringify(old);
  const next=prepare(old,[{...person(row.subjectId),identity:['black hair']}],{source:{...source,revisionId:'revision-2'}});
  assert.equal(next.collection.revision,2);assert.equal(next.collection.items[0].revision,2);assert.equal(next.collection.items[0].document.imagegen.appearance,'black hair');
  assert.equal(next.collection.items[0].lastObserved.revisionId,'revision-2');assert.equal(JSON.stringify(old),saved);
});
test('rejection tombstones block exact reruns, supplied stable IDs and same-name automatic rediscovery without deleting anything',()=>{
  const first=prepare().collection,rejected=reject(first,first.items[0].id),saved=JSON.stringify(rejected);
  for(const [characters,options,reason] of [
    [[person()],{},'rejected'],[[person(rejected.items[0].subjectId)],{},'rejected'],
    [[person('C2')],{source:{...source,revisionId:'revision-2'}},'rejected_name_candidate'],
  ]){
    const result=prepare(rejected,characters,options);assert.equal(result.changed,false);assert.equal(result.assignments.length,0);assert.equal(result.warnings[0].reason,reason);
  }
  assert.equal(JSON.stringify(rejected),saved);assert.equal(rejected.items.length,1);
});
test('ambiguous or inconsistent descriptions remain unbound, while other valid people still yield drafts',()=>{
  const result=prepare(empty(),[person(),{...person(),identity:['blond hair']},person('C2','Bob'),{...person('C3','Hidden'),visible:false},
    {...person('archive:bound','Bound'),archiveSnapshot:{archiveId:'bound'}}]);
  assert.equal(result.collection.items.length,1);assert.equal(result.collection.items[0].document.name,'Bob');assert.equal(result.warnings[0].reason,'inconsistent_identity');
  assert.equal(result.assignments[0].characterId,'C2');
});
test('host links use supplied keys and preserve local categories without modifying global bindings',()=>{
  const host={category:'char',subjectKey:'char:Alice.png'};
  assert.throws(()=>prepare(empty(),[person()],{hostLinks:{C1:host}}),/未确认/);
  const result=prepare(empty(),[person()],{hostLinks:{C1:host},hostSubjects:[host]});
  assert.equal(result.collection.items[0].document.category,'char');assert.deepEqual(result.collection.items[0].hostSubject,host);
  assert.equal(result.bindings,undefined);
});
test('metadata preparation preserves every unrelated chat field and does not claim persistence',()=>{
  const store={history:[{id:'history'}],plan:{id:'world'},coreadBound:['book'],ttsVoiceMaps:{voice:'saved'},unrelated:{value:1}},saved=JSON.stringify(store);
  assert.equal(batch.readChatCharacterCollection(store,owner).items.length,0);assert.equal(JSON.stringify(store),saved);
  const first=prepare().collection,result=batch.prepareChatCharacterMetadataWrite(store,first,{owner,expectedRevision:0});
  assert.equal(result.changed,true);assert.equal(result.chatStore.history,store.history);assert.equal(result.chatStore.coreadBound,store.coreadBound);
  assert.equal(JSON.stringify(store),saved);assert.equal(result.saved,undefined);
  const roundtrip=JSON.parse(JSON.stringify(result.chatStore));assert.deepEqual(batch.readChatCharacterCollection(roundtrip,owner),first);
  const migrated=migrateQianmuChatStoreV2(roundtrip);assert.equal(migrated.failed,false);assert.deepEqual(batch.readChatCharacterCollection(migrated.value,owner),first);
  assert.equal(batch.prepareChatCharacterMetadataWrite(result.chatStore,first,{owner,expectedRevision:1}).changed,false);
});
test('malformed or foreign collections and explicit null metadata never become an empty writable record',()=>{
  const first=prepare().collection;
  for(const value of [null,{}, {...first,invalid:true},{...first,schema:'future'},{...first,owner:{...owner,chatKey:'elsewhere'}},
    {...first,items:[first.items[0],first.items[0]]},{...first,items:[first.items[0],{...first.items[0],id:uuid(2),subjectId:`chat-character:${uuid(2)}`}]}]){
    assert.throws(()=>batch.readChatCharacterCollection({characterDrafts:value},owner));
  }
  for(const scope of [{...owner,chatKey:'other'},{...owner,namespace:'st-user:other'}])assert.throws(()=>batch.normalizeChatCharacterCollection(first,scope));
});
test('stale or skipped collection/draft revisions and altered initial identity fail without a partial replacement',()=>{
  const first=prepare().collection,row=first.items[0],updated=editChatCharacterDraft(row,{name:'User name'},{owner,expectedRevision:1});
  const next=batch.replaceChatCharacterDraft(first,updated,{owner,expectedRevision:1});assert.equal(next.revision,2);assert.equal(next.items[0].document.name,'User name');
  for(const replacement of [{...updated,revision:4},{...updated,source:{...updated.source,revisionId:'wrong'}},{...updated,hostSubject:{category:'char',subjectKey:'char:unknown'}}]){
    assert.throws(()=>batch.replaceChatCharacterDraft(first,replacement,{owner,expectedRevision:1}));
  }
  assert.throws(()=>batch.replaceChatCharacterDraft(next,updated,{owner,expectedRevision:1}));
  assert.throws(()=>batch.prepareChatCharacterMetadataWrite({characterDrafts:first},{...next,revision:3},{owner,expectedRevision:1}));
});
test('UUID collisions and size limits fail the entire draft update, never silently evicting earlier people',()=>{
  const original=empty();assert.throws(()=>batch.prepareChatCharacterBatch(original,{source,characters:[person(),person('C2','Bob')]},{owner,expectedRevision:0,createId:()=>uuid(1)}));
  assert.equal(original.items.length,0);
  assert.throws(()=>prepare(original,Array(257).fill(person())),/过大/);
  assert.throws(()=>prepare(original,Array.from({length:110},(_,i)=>({...person(`C${i}`,`Person${i}`),identity:Array(24).fill('x'.repeat(490))}))),/1 MB/);
  assert.equal(original.items.length,0);
});
test('two batch IDs targeting one existing draft or one host subject remain ambiguous instead of overwriting twice',()=>{
  const first=prepare().collection,row=first.items[0],saved=JSON.stringify(first);
  const result=prepare(first,[person(),person(row.subjectId)]);assert.equal(result.changed,false);assert.equal(result.assignments.length,0);
  assert.ok(result.warnings.every(warning=>warning.reason==='duplicate_identity'));assert.equal(JSON.stringify(first),saved);
  const host={category:'char',subjectKey:'char:Alice.png'},duplicate=prepare(empty(),[person(),person('C2','Bob')],{hostLinks:{C1:host,C2:host},hostSubjects:[host]});
  assert.equal(duplicate.collection.items.length,0);assert.equal(duplicate.warnings.length,2);
});
test('explicit host identity survives a renamed character in later prose, while mismatched host links cannot borrow it',()=>{
  const host={category:'char',subjectKey:'char:Alice.png'},options={hostLinks:{C1:host},hostSubjects:[host]},first=prepare(empty(),[person()],options).collection;
  const next=prepare(first,[person('C9','Alicia')],{source:{...source,revisionId:'revision-2'},hostLinks:{C9:host},hostSubjects:[host]});
  assert.equal(next.collection.items.length,1);assert.equal(next.collection.items[0].id,first.items[0].id);assert.equal(next.collection.items[0].document.name,'Alicia');
  const foreign={category:'char',subjectKey:'char:Bob.png'},bad=prepare(first,[person(first.items[0].subjectId)],{hostLinks:{[first.items[0].subjectId]:foreign},hostSubjects:[foreign]});
  assert.equal(bad.changed,false);assert.equal(bad.warnings[0].reason,'identity_conflict');
  const unknownId=`chat-character:${uuid(999)}`,unknown=prepare(first,[person(unknownId)],{hostLinks:{[unknownId]:host},hostSubjects:[host]});
  assert.equal(unknown.changed,false);assert.equal(unknown.warnings[0].reason,'unknown_identity');
});
test('metadata writes cannot drop refusal records or silently remove manual edit locks',()=>{
  const first=prepare().collection,row=first.items[0],edited=editChatCharacterDraft(row,{appearance:'user choice'},{owner,expectedRevision:1});
  const current=batch.replaceChatCharacterDraft(first,edited,{owner,expectedRevision:1}),saved=JSON.stringify(current);
  const next={...current,revision:3,items:[{...edited,revision:3,userEditedFields:[],document:{...edited.document,imagegen:{...edited.document.imagegen,appearance:'model choice'}}}]};
  assert.throws(()=>batch.prepareChatCharacterMetadataWrite({characterDrafts:current},next,{owner,expectedRevision:2}),/编辑选择/);
  assert.throws(()=>batch.replaceChatCharacterDraft(current,next.items[0],{owner,expectedRevision:2}),/编辑选择/);
  assert.throws(()=>batch.prepareChatCharacterMetadataWrite({characterDrafts:current},{...current,revision:3,items:[]},{owner,expectedRevision:2}),/不能删除/);
  assert.equal(JSON.stringify(current),saved);
});
test('malformed candidates cannot reuse a prior origin to bypass input validation, and invalid empty batches still fail',()=>{
  const first=prepare().collection;
  for(const character of [{...person(),identity:{}},{...person(),name:''},null])assert.throws(()=>prepare(first,[character]));
  assert.throws(()=>prepare(first,[],{source:{...source,chatKey:'other'}}));
  assert.throws(()=>batch.prepareChatCharacterMetadataWrite({}, {...first,items:[{...first.items[0],status:'chat_bound'}]}, {owner,expectedRevision:0}),/新识别/);
});
test('summary counts include rejected records and contain no names or private text',()=>{
  const first=prepare().collection,rejected=reject(first,first.items[0].id),summary=batch.summarizeChatCharacterCollection(rejected,owner);
  assert.equal(summary.count,1);assert.equal(summary.rejected,1);assert.equal(summary.mediaIncluded,false);assert.ok(summary.bytes>0);
  assert.doesNotMatch(JSON.stringify(summary),/Alice|silver hair|st-user/);
});
