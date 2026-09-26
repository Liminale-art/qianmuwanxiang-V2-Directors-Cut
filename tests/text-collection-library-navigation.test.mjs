import test from 'node:test';
import assert from 'node:assert/strict';
import {collectionLibraryFixture} from './helpers/collection-library-fixture.mjs';
import {createTextCollection} from '../qianmu-text-collection.js';

const account='st-user:'+'a'.repeat(64);
const record=()=>createTextCollection({id:'item-0000',mode:'full',createdAt:10,source:{account,chatId:'fixture-chat',messageId:0,replyId:'fixture-reply',charName:'CHAR',userName:'USER',text:'完整收藏正文'}});

test('same verified page keeps its row DOM and scroll during explicit refresh',async t=>{
  const f=await collectionLibraryFixture(t,{initialCount:1}),row=f.rows[0];f.scroller.scrollTop=214;
  await f.click('refresh');
  assert.equal(f.calls.length,2,'refresh still reads through the session');
  assert.equal(f.rows[0],row);assert.equal(f.list.replacements,1);assert.equal(f.scroller.scrollTop,214);
});

test('detail starts at the top and returning reuses the unchanged rows and list scroll',async t=>{
  const f=await collectionLibraryFixture(t,{initialCount:1,sessionOverrides:{get:async()=>({record:record()})}}),row=f.rows[0];
  f.scroller.scrollTop=214;f.detail.scrollTop=59;await f.choose('item-0000');assert.equal(f.detail.scrollTop,0);
  f.detail.scrollTop=59;await f.click('back');
  assert.equal(f.rows[0],row);assert.equal(f.list.replacements,1);assert.equal(f.scroller.scrollTop,214);
  assert.equal(f.calls.length,2,'back still obtains a guarded current browsing page');
});

test('a changed page replaces the rows when returning from detail',async t=>{
  let revision=1;
  const f=await collectionLibraryFixture(t,{sessionOverrides:{get:async()=>({record:record()}),list:async()=>({items:[{id:'item-0000',revision,charName:'CHAR',userName:'USER',createdAt:10,preview:revision===1?'原片段':'远端修改'}],total:1,nextCursor:null})}}),row=f.rows[0];
  await f.choose('item-0000');revision=2;await f.click('back');
  assert.notEqual(f.rows[0],row);assert.equal(f.rows[0].dataset.collectionRevision,'2');assert.equal(f.rows[0].children[1].textContent,'远端修改');assert.equal(f.list.replacements,2);
});

test('changing search resets list position even when the visible result happens to match',async t=>{
  const f=await collectionLibraryFixture(t,{initialCount:1}),row=f.rows[0];f.scroller.scrollTop=214;
  await f.input('片段');await f.tick();f.calls.at(-1).resolve(1);await f.settle();
  assert.notEqual(f.rows[0],row);assert.equal(f.scroller.scrollTop,0);assert.equal(f.list.replacements,2);
});
