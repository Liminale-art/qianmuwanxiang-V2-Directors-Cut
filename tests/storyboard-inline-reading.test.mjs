import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {buildStoryboardReadingShots,storyboardInlineShotKey} from '../qianmu-storyboard-inline-reading.js';
import {migrateQianmuChatStoreV2} from '../qianmu-data-migrations.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

const record=(id,shot='A1',extra={})=>({id,variantRootId:shot,planShotId:shot,chatKey:'chat',floor:4,swipeId:0,messageHash:'text',
  inline:true,url:`/${id}.png`,taskId:`job-${id}`,createdAt:1,imageIndex:0,...extra});
const build=(rows,options={})=>buildStoryboardReadingShots(rows,{chatKey:'chat',...options});

test('one single shot and three continuous shots produce four reading slots, not a group carousel',()=>{
  const rows=[record('a'),record('b1','B1'),record('b2','B2'),record('b3','B3')];
  const before=JSON.stringify(rows),shots=build(rows);
  assert.equal(shots.length,4);assert.deepEqual(shots.map(shot=>shot.record.id),['a','b1','b2','b3']);
  assert.equal(JSON.stringify(rows),before);
});

test('three workflow candidates share a shot and default to imageIndex zero despite completion order',()=>{
  const rows=[2,1,0].map(imageIndex=>record(`b${imageIndex}`,'B2',{taskId:'request-1',imageIndex}));
  const shots=build(rows);assert.equal(shots.length,1);assert.deepEqual(shots[0].records.map(item=>item.id),['b0','b1','b2']);
  assert.equal(shots[0].record.id,'b0');
});

test('redrawing one shot selects the new first candidate and preserves prior candidates and other shots',()=>{
  const rows=[record('old'),record('other','B1'),record('new2','A1',{taskId:'new',createdAt:10,imageIndex:1}),record('new1','A1',{taskId:'new',createdAt:11})];
  const result=build(rows);assert.equal(result.length,2);assert.equal(result[0].record.id,'new1');assert.equal(result[1].record.id,'other');
  assert.deepEqual(result[0].records.map(item=>item.id),['old','new1','new2']);
});

test('user choice survives reopen but a genuinely new request supersedes that default choice',()=>{
  const old=record('old'),latest=record('latest','A1',{createdAt:10}),key=storyboardInlineShotKey(old,'chat');
  const choices={[key]:{recordId:'old',latestRequestId:'job-latest'}};
  assert.equal(build([old,latest],{choices})[0].record.id,'old');
  assert.equal(build([old,latest,record('new','A1',{createdAt:20})],{choices})[0].record.id,'new');
  assert.equal(build([latest],{choices})[0].record.id,'latest');
});

test('late delivery of an older request never displaces a later requested version, even after log pruning',()=>{
  const late=record('late','A1',{createdAt:90,requestQueuedAt:10}),newer=record('newer','A1',{createdAt:50,requestQueuedAt:20});
  assert.equal(build([newer,late])[0].record.id,'newer');
  delete late.requestQueuedAt;delete newer.requestQueuedAt;
  assert.equal(build([newer,late],{requestTimes:new Map([['late',10],['newer',20]])})[0].record.id,'newer');
});

test('same imported ids stay isolated by chat, floor, swipe and message',()=>{
  const base=record('base'),rows=[base,record('floor','A1',{floor:5}),record('swipe','A1',{swipeId:1}),
    record('message','A1',{messageHash:'another'}),record('foreign','A1',{chatKey:'other'})];
  assert.equal(build(rows).length,4);
  const choices={[storyboardInlineShotKey(base,'chat')]:{recordId:'foreign',latestRequestId:'job-base'}};
  assert.equal(build(rows,{choices})[0].record.id,'base');
});

test('a single-shot redraw drops whole-floor receipt but remains a version of the original shot',()=>{
  const old=record('old','A1',{floorTake:{id:'take-1'},createdAt:1});
  const fresh=record('fresh','A1',{createdAt:5});
  const slots=build([old,fresh]);assert.equal(slots.length,1);assert.equal(slots[0].record.id,'fresh');
  assert.deepEqual(slots[0].records.map(item=>item.id),['old','fresh']);
  old.inline=false;assert.deepEqual(build([old,fresh])[0].records.map(item=>item.id),['fresh']);
});

test('detached and superseded records are never revived by a remembered selection',()=>{
  const removed=record('removed','A1',{inline:false}),visible=record('visible');
  const choices={[storyboardInlineShotKey(visible,'chat')]:{recordId:'removed',latestRequestId:'job-visible'}};
  assert.deepEqual(build([removed,visible],{choices})[0].records.map(item=>item.id),['visible']);
  assert.equal(build([removed]).length,0);
});

test('the existing additive chat-store migration retains version choices without a second metadata root',()=>{
  const choices={'key':{recordId:'a',latestRequestId:'job-a'}},source={storyboardInlineChoices:choices};
  const migrated=migrateQianmuChatStoreV2(source);
  assert.ok(JSON.stringify(migrated).includes('storyboardInlineChoices'));assert.deepEqual(source.storyboardInlineChoices,choices);
});

test('inline markup exposes only reading, versions, collapse, information and log actions',()=>{
  const context=vm.createContext({storyboardSafeUrl:x=>x,storyboardInlineVideoForRecord:()=>null,htmlEscape:x=>String(x),
    storyboardInlineSlotKey:()=>'',snip:x=>x});
  vm.runInContext(section('storyboardInlineRecordMarkup'),context);
  const one=record('one'),markup=context.storyboardInlineRecordMarkup(one,{key:'a',records:[one,record('two')]});
  assert.deepEqual([...markup.matchAll(/data-storyboard-chat-action="([^"]+)"/g)].map(match=>match[1]),
    ['preview','previous-version','next-version','toggle-actions','collapse','image-info','image-log']);
  assert.match(markup,/sd-storyboard-inline-dots/);assert.doesNotMatch(markup,/fa-ellipsis|task-status|redraw|download/);
  const render=section('storyboardRenderInlineImages');
  assert.doesNotMatch(render,/storyboardInlineTaskMarkup|storyboardInlinePlaceholderMarkup|role="status"|paragraphAnchorFallback =/);
  assert.match(render,/if \(anchor.fallback\) continue/);assert.match(render,/storyboardReadingShots\(sortStoryboardInlineRecords/);
});

test('selection persistence rolls back failures and ignores UI completion after chat/account switch',async()=>{
  for(const failure of [false,true])for(const switched of [false,true]){
    const old=record('old'),next=record('next'),store={},metadata={},calls=[];
    const wrapper={dataset:{storyboardChatKey:'chat',storyboardShotKey:'shot',storyboardOwnerEpoch:'1'}};
    const context=vm.createContext({getChatKey:()=> 'chat',ctx:()=>({chatMetadata:metadata}),storyboardAdmissionEpoch:1,
      storyboardReadingShots:()=>[{key:'shot',record:old,records:[old,next],latestRequestId:'new'}],getChatStore:()=>store,
      saveMetadata:async()=>{calls.push('save');if(switched)context.storyboardAdmissionEpoch++;if(failure)throw Error('save');},
      storyboardRenderInlineImages:floor=>calls.push(['render',floor]),toast:()=>calls.push('warning')});
    vm.runInContext(section('storyboardSelectInlineVersion'),context);
    await context.storyboardSelectInlineVersion(wrapper,1);
    assert.equal(calls.filter(item=>item==='save').length,1);
    assert.equal(store.storyboardInlineChoices.shot?.recordId,failure?undefined:'next');
    assert.equal(calls.some(Array.isArray),!switched);assert.equal(calls.includes('warning'),failure&&!switched);
    assert.equal(wrapper.dataset.versionSaving,undefined);
  }
});

test('stale-owner arrows cannot change the new account and repeated clicks share the pending save',async()=>{
  const old=record('old'),next=record('next'),before={recordId:'old',latestRequestId:'new'},store={storyboardInlineChoices:{shot:before}};
  let release,saves=0;
  const metadata={},wrapper={dataset:{storyboardChatKey:'chat',storyboardShotKey:'shot',storyboardOwnerEpoch:'0'}};
  const context=vm.createContext({getChatKey:()=> 'chat',ctx:()=>({chatMetadata:metadata}),storyboardAdmissionEpoch:1,
    storyboardReadingShots:()=>[{key:'shot',record:old,records:[old,next],latestRequestId:'new'}],getChatStore:()=>store,
    saveMetadata:async()=>{saves++;await new Promise(resolve=>{release=resolve;});throw Error('save failed');},
    storyboardRenderInlineImages(){},toast(){}});
  vm.runInContext(section('storyboardSelectInlineVersion'),context);
  await context.storyboardSelectInlineVersion(wrapper,1);assert.equal(saves,0);assert.equal(store.storyboardInlineChoices.shot,before);
  wrapper.dataset.storyboardOwnerEpoch='1';
  const first=context.storyboardSelectInlineVersion(wrapper,1);
  await context.storyboardSelectInlineVersion(wrapper,1);assert.equal(saves,1);
  release();await first;assert.equal(store.storyboardInlineChoices.shot,before);
});

test('busy breathing is opacity-only and respects reduced motion',async()=>{
  const css=await readFile(new URL('../style.css',import.meta.url),'utf8');
  assert.match(css,/@keyframes qianmu-storyboard-breathe \{ 0%,100% \{ opacity:1; \} 50% \{ opacity:\.35; \} \}/);
  assert.match(css,/@media \(prefers-reduced-motion:reduce\)[^\n]*sd-storyboard-message-action.is-generating[^\n]*animation:none/);
});
