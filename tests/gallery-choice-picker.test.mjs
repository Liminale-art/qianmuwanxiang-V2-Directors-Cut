import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {galleryChoiceWindow,renderGalleryChoicePicker,bindGalleryChoicePicker,resetGalleryChoiceSessions} from '../qianmu-gallery-choice-picker.js?v=1.59.440';
import {galleryMembershipIds,galleryMembershipChange,assignGalleryMemberships,applyGalleryCollectionTarget,galleryCollectionChoices} from '../qianmu-gallery-membership.js';
import {renderGalleryBulkCollections,bindGalleryBulkCollections,bindGalleryKeywordChoices} from '../qianmu-gallery-taxonomy.js';
import {createChoiceRoot,ChoiceNode} from './helpers/gallery-choice-fixture.mjs';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

const items=n=>Array.from({length:n},(_,i)=>({id:'c'+i,label:'Collection '+i}));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
test('choice windows traverse every item once with at most 24 rows and never split selected state',()=>{
  const source=items(5001),selected=['c0','c1000','c5000'],seen=[];
  for(let page=0;;page++){const window=galleryChoiceWindow(source,selected,{page});assert.ok(window.items.length<=24);seen.push(...window.items.map(row=>row.id));
    assert.deepEqual([...window.selected],selected);if(page+1===window.pages)break;}
  assert.deepEqual(seen,source.map(row=>row.id));assert.equal(galleryChoiceWindow(source,selected,{onlySelected:true}).total,3);
  assert.equal(galleryChoiceWindow(source,selected,{query:' collection 5000 '}).items[0].id,'c5000');
});
test('empty, duplicate and removed tail choices clamp without inventing a selection',()=>{
  assert.deepEqual(galleryChoiceWindow([],[],{page:99}).items,[]);
  const window=galleryChoiceWindow([...items(2),{id:'c0',label:'Duplicate'}],['unknown'],{page:10});
  assert.equal(window.page,0);assert.equal(window.total,2);assert.deepEqual([...window.selected],['unknown']);
});
test('markup is bounded and escapes names and identifiers for detail, bulk and keywords',()=>{
  const source=[{id:'<id>',label:'<script>'},...items(5001)];
  for(const id of ['detail-collections','keywords']){const html=renderGalleryChoicePicker({id,title:'合集',items:source,selected:['<id>']});
    assert.equal((html.match(/data-choice-id=/g)||[]).length,24);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);assert.ok(html.length<16000);}
  assert.equal((renderGalleryBulkCollections(items(5001).map(row=>({id:row.id,name:row.label}))).match(/data-choice-id=/g)||[]).length,24);
});
function pickerFixture(){
  const f=createChoiceRoot('test'),e={...f,rows:items(100),selected:['c80'],owner:{},active:true,changes:0,errors:[]};
  e.bind=()=>bindGalleryChoicePicker(f.root,{id:'test',readItems:()=>e.rows,readSelected:()=>e.selected,isCurrent:node=>e.active&&node.isConnected,
    scope:()=>[e.owner],onChange:async values=>{e.selected=values;e.changes++;},onError:error=>e.errors.push(error)});
  return e;
}
test('actual picker search and paging preserve off-page selections and do not rewrite them from DOM',async()=>{
  const f=pickerFixture();f.bind();assert.equal(f.list.buttons.length,24);await f.choose('c0');assert.deepEqual(f.selected,['c80','c0']);
  await f.nodes['[data-choice-page="next"]'].fire();await f.choose('c25');assert.deepEqual(f.selected,['c80','c0','c25']);
  await f.search('Collection 80');await f.choose('c80');assert.deepEqual(f.selected,['c0','c25']);assert.equal(f.changes,3);
  await f.search('');await f.nodes['[data-choice-selected]'].fire();assert.deepEqual(f.list.buttons.map(node=>node.dataset.choiceId),['c0','c25']);
});
test('same-source rebind retains query/page, disposes old listeners, and replacement owner starts fresh',async()=>{
  const f=pickerFixture();f.bind();await f.nodes['[data-choice-page="next"]'].fire();f.bind();assert.equal(f.list.buttons[0].dataset.choiceId,'c24');
  await f.choose('c25');assert.equal(f.changes,1);await f.search('99');f.bind();assert.equal(f.nodes['[data-choice-search]'].value,'99');
  f.owner={};f.bind();assert.equal(f.nodes['[data-choice-search]'].value,'');assert.equal(f.list.buttons[0].dataset.choiceId,'c0');
});

test('removing the last visible selected choice returns keyboard focus to a visible control',async()=>{
  const f=pickerFixture();f.rows=items(1);f.selected=['c0'];f.bind();await f.nodes['[data-choice-selected]'].fire();await f.choose('c0');
  assert.equal(f.list.buttons.length,0);assert.equal(f.nodes['[data-choice-search]'].hidden,true);assert.equal(f.nodes['[data-choice-selected]'].focused,1);
});

test('chat cleanup invalidates retained controls and releases saved queries even for reused source objects',async()=>{
  const f=pickerFixture();f.bind();await f.search('80');resetGalleryChoiceSessions();await f.choose('c80');assert.equal(f.changes,0);
  f.bind();assert.equal(f.nodes['[data-choice-search]'].value,'');assert.equal(f.list.buttons[0].dataset.choiceId,'c0');
});
for(const mode of ['owner','detached','inactive'])test(`stale ${mode} picker cannot change selection or paginate`,async()=>{
  const f=pickerFixture();f.bind();if(mode==='owner')f.owner={};else if(mode==='detached')f.frame.isConnected=false;else f.active=false;
  await f.choose('c0');await f.nodes['[data-choice-page="next"]'].fire();assert.deepEqual(f.selected,['c80']);assert.equal(f.changes,0);
});
test('pending choice admits one action, remains navigable locally, and late failure cannot notify a new owner',async()=>{
  const f=createChoiceRoot('test'),wait=deferred();let owner={},calls=0,errors=0;
  bindGalleryChoicePicker(f.root,{id:'test',readItems:()=>items(80),readSelected:()=>[],scope:()=>[owner],isCurrent:()=>true,
    onChange:async(_,{verify})=>{calls++;await wait.promise;verify();},onError:()=>errors++});
  const pending=f.choose('c0');assert.equal(f.list.buttons.every(button=>button.disabled),true);await f.choose('c1');assert.equal(calls,1);
  await f.nodes['[data-choice-page="next"]'].fire();assert.equal(f.list.buttons[0].dataset.choiceId,'c24');owner={};wait.resolve();await pending;assert.equal(errors,0);
});
test('removed or forged choice cannot be submitted from a retained old row',async()=>{
  const f=pickerFixture();f.bind();f.rows=[];await f.choose('c0');assert.equal(f.changes,0);
  const forged=new ChoiceNode({choiceId:'foreign'});await f.frame.fire('click',forged);assert.equal(f.changes,0);
});
test('legacy memberships beyond 30 and unknown collections stay visible and survive an unrelated removal',()=>{
  const record={collectionIds:Array.from({length:40},(_,i)=>'c'+i),collectionId:'legacy',future:'keep'};
  assert.equal(galleryMembershipIds(record).length,41);const next=galleryMembershipChange(record,'c0',false);assignGalleryMemberships(record,next);
  assert.equal(record.collectionIds.length,40);assert.ok(record.collectionIds.includes('legacy'));assert.equal(record.future,'keep');
  const choices=galleryCollectionChoices([{id:'c1',name:'One'}],galleryMembershipIds(record));assert.ok(choices.some(item=>item.id==='legacy'));
  assert.throws(()=>galleryMembershipChange(record,'new',true),/最多归入 30/);assert.equal(record.collectionIds.length,40);
});
test('batch add validates every image before mutation, retains existing membership, and explicit clear is distinct',()=>{
  const a={id:'a',collectionIds:['existing']},b={id:'b',collectionIds:items(30).map(row=>row.id)},rows=[a,b],before=JSON.stringify(rows);
  assert.throws(()=>applyGalleryCollectionTarget(rows,new Set(['a','b']),'new'),/本次未修改/);assert.equal(JSON.stringify(rows),before);
  assert.equal(applyGalleryCollectionTarget(rows,new Set(['a']),'new'),1);assert.deepEqual(a.collectionIds,['existing','new']);
  applyGalleryCollectionTarget(rows,new Set(['b']),'c0');assert.equal(b.collectionIds.length,30);
  applyGalleryCollectionTarget(rows,new Set(['a']),'');assert.deepEqual(a.collectionIds,[]);assert.equal(b.collectionIds.length,30);
});
function bulkFixture(){
  const e=compactBulkFixture();e.saves=0;e.save=async()=>e.saves++;return e;
}
test('actual bulk picker requires an explicit target and persists additions only after valid selection',async()=>{
  const f=bulkFixture();f.bind();assert.equal(f.saves,0);
  await f.choose('a');assert.equal(f.saves,1);assert.equal(f.changes,1);
  assert.deepEqual(f.records[0].collectionIds,['old','a']);assert.equal(f.selection.size,0);
});
test('actual bulk picker distinguishes explicit remove-all and checks a removed target before writing',async()=>{
  const f=bulkFixture();f.bind();f.collections=[];await f.choose('a');assert.equal(f.saves,0);
  await f.remove.fire();assert.deepEqual(f.records[0].collectionIds,[]);assert.equal(f.saves,1);
});
test('actual stale bulk actions and post-save completion cannot mutate replacement selection or notify it',async()=>{
  const f=bulkFixture();f.bind();f.active=false;await f.choose('a');assert.equal(f.saves,0);
  const g=bulkFixture(),wait=deferred();g.save=()=>wait.promise;
  g.bind();const pending=g.choose('a');g.active=false;g.selection=new Set(['foreign']);wait.resolve();await pending;
  assert.deepEqual([...g.selection],['foreign']);assert.equal(g.changes,0);assert.equal(g.errors.length,0);
});
test('actual keywords preserve multi-select intersection state and bound 5001 choices across parent rerenders',async()=>{
  const f=createChoiceRoot('keywords'),state={galleryTagFilters:['word5000']};let reads=0,saves=0,changes=0;
  const bind=()=>bindGalleryKeywordChoices(f.root,state,{readWords:()=>{reads++;return items(5001).map((_,i)=>'word'+i);},scope:()=>[state],isCurrent:()=>true,save:()=>saves++,changed:()=>changes++,onError:error=>assert.fail(error.message)});
  bind();assert.equal(f.list.buttons.length,24);await f.choose('word0');assert.deepEqual(state.galleryTagFilters,['word5000','word0']);
  await f.search('word5000');bind();await f.choose('word5000');assert.deepEqual(state.galleryTagFilters,['word0']);assert.equal(reads,2);assert.equal(saves,2);assert.equal(changes,2);
});

for(const label of ['record','duplicate','collection'])test(`actual bulk refuses a same-id ${label} replacement instead of applying stale selection`,async()=>{
  const f=bulkFixture();f.bind();
  if(label==='record')f.records[0]={id:'one',collectionIds:['new-owner']};else if(label==='duplicate')f.records.push({id:'one',collectionIds:[]});else f.collections=[{id:'a',name:'Replaced'}];
  const before=JSON.stringify(f.records);await f.choose('a');assert.equal(f.saves,0);assert.equal(JSON.stringify(f.records),before);assert.equal(f.errors.length,1);
});

test('actual entry connects bounded keyword changes to first-page reset and keeps complete read sources',()=>{
  const source=section('bindStoryboardTabEvents'),start=source.indexOf('  const choiceScope='),end=source.indexOf("  root.querySelector('.sd-storyboard-gallery-select-mode')",start);
  let options,renders=0;const state={},owner={};
  const c=vm.createContext({state,root:{},ctx:()=>({chatMetadata:owner}),getChatKey:()=> 'chat',storyboardAdmissionEpoch:4,
    galleryFiltersCurrent:()=>true,bindGalleryKeywordChoices:(_root,_state,args)=>options=args,saveSettings:()=>{},toast:()=>{},renderModal:()=>renders++,storyboardGalleryVisibleCount:80});
  vm.runInContext(source.slice(start,end),c);options.changed();assert.equal(c.storyboardGalleryVisibleCount,40);assert.equal(renders,1);assert.deepEqual(Array.from(options.scope()),[state,owner,'chat',4]);
});

function compactBulkFixture(){
  const f=createChoiceRoot('bulk-collections'),wrapper=new ChoiceNode(),remove=new ChoiceNode(),e={...f,wrapper,remove,collections:[{id:'a',name:'A'}],records:[{id:'one',collectionIds:['old'],collectionId:'old'}],selection:new Set(['one']),active:true,changes:0,errors:[],save:async()=>{}};
  f.root.querySelector=selector=>selector==='.sd-gallery-bulk-target'?wrapper:selector==='.sd-gallery-remove-all-collections'?remove:null;
  e.bind=()=>bindGalleryBulkCollections(f.root,{readCollections:()=>e.collections,readRecords:()=>e.records,readSelection:()=>e.selection,clearSelection:()=>e.selection.clear(),scope:()=>[e.records],isCurrent:node=>e.active&&node.isConnected,save:()=>e.save(),changed:()=>e.changes++,onError:error=>e.errors.push(error)});return e;
}
test('compact collection choice directly saves selection without second submit and remove all is a separate icon action',async()=>{
  const f=compactBulkFixture();f.bind();await f.choose('a');assert.deepEqual(f.records[0].collectionIds,['old','a']);assert.equal(f.selection.size,0);assert.equal(f.changes,1);
  const g=compactBulkFixture();g.bind();await g.remove.fire();assert.deepEqual(g.records[0].collectionIds,[]);assert.equal(g.changes,1);
});
test('compact collection failure after chat switch restores the original object without touching the new chat',async()=>{
  const f=compactBulkFixture(),original=f.records[0],ids=original.collectionIds,foreign={id:'one',collectionIds:['foreign']};
  f.save=async()=>{f.records=[foreign];f.selection=new Set(['foreign']);throw Error('offline');};f.bind();await f.choose('a');
  assert.equal(original.collectionIds,ids);assert.equal(original.collectionId,'old');assert.deepEqual(f.records,[foreign]);assert.deepEqual([...f.selection],['foreign']);assert.equal(f.errors.length,0);assert.equal(f.changes,0);
});
test('compact failed save cannot overwrite a later edit to the same record',async()=>{
  const f=compactBulkFixture(),record=f.records[0],later=['later'];f.save=async()=>{record.collectionIds=later;record.collectionId='later';throw Error('offline');};f.bind();await f.choose('a');
  assert.equal(record.collectionIds,later);assert.equal(record.collectionId,'later');assert.equal(f.selection.has('one'),true);assert.equal(f.changes,0);
});
test('compact bulk fails closed when the selected collection object is replaced',async()=>{
  const f=compactBulkFixture();f.bind();f.collections=[{id:'a',name:'Replaced'}];await f.choose('a');assert.deepEqual(f.records[0].collectionIds,['old']);assert.equal(f.errors.length,1);
});
test('compact keyword list over 24 choices uses pagination without a second search or selected count',async()=>{
  const f=createChoiceRoot('keywords'),state={galleryTagFilters:[]};f.frame.dataset.choiceCompact='true';
  bindGalleryKeywordChoices(f.root,state,{readWords:()=>items(60).map(row=>row.id),isCurrent:()=>true,scope:()=>[state],save:()=>{},changed:()=>{},onError:error=>assert.fail(error.message)});
  assert.equal(f.nodes['[data-choice-search]'].hidden,true);assert.equal(f.nodes['[data-choice-selected]'].hidden,true);assert.equal(f.list.buttons.length,24);
  await f.nodes['[data-choice-page="next"]'].fire();assert.equal(f.list.buttons[0].dataset.choiceId,'c24');await f.choose('c24');assert.deepEqual(state.galleryTagFilters,['c24']);assert.equal(f.nodes['[data-choice-search]'].hidden,true);
});
