import test from 'node:test';
import assert from 'node:assert/strict';
import {galleryLocationFixture as fixture,locationGate as gate} from './helpers/gallery-location-fixture.mjs';
import {revealGalleryLocation as reveal} from '../qianmu-gallery-location-view.js';

function dom(){let rendered=true,duplicates=false,scrolls=[],loaded=[],closed=0;
  const paragraph={isConnected:true,textContent:'Alice reaches for the bowl.',getBoundingClientRect:()=>({top:400,height:60})};
  const row={isConnected:true,getAttribute:key=>key==='mesid'?'0':null,querySelector:()=>({querySelectorAll:()=>[paragraph]}),getBoundingClientRect:()=>({top:350,height:200})};
  const chat={scrollTop:10,clientHeight:200,getBoundingClientRect:()=>({top:100}),scrollTo:value=>scrolls.push(value),contains:node=>node===row||node===paragraph,
    querySelectorAll:selector=>selector==='.mes'?rendered?[row]:[]:rendered?duplicates?[row,row]:[row]:[]};
  const document={getElementById:()=>chat};return {document,row,paragraph,chat,scrolls,loaded,get closed(){return closed;},set rendered(v){rendered=v;},set duplicates(v){duplicates=v;},
    options:{document,frame:async()=>{},beforeReveal:()=>closed++,loadHost:async()=>({showMoreMessages:async count=>{loaded.push(count);rendered=true;}}),confirmLarge:async()=>true}};
}
test('only exact chat scroller moves, paragraph centers and no global scrollIntoView is used',async t=>{
  const f=fixture(t),d=dom(),before=JSON.stringify(f.context);const result=await reveal(f.input,d.options);
  assert.deepEqual(result,{status:'located',floor:0,paragraph:true,kind:'exact',readOnly:true});assert.deepEqual(d.scrolls,[{top:240,behavior:'auto'}]);assert.equal(d.closed,1);assert.equal(d.loaded.length,0);assert.equal(JSON.stringify(f.context),before);
});
test('unrendered source loads through ST then rechecks instead of closing the preview early',async t=>{
  const f=fixture(t),d=dom();d.rendered=false;const result=await reveal(f.input,d.options);assert.equal(result.status,'located');assert.deepEqual(d.loaded,[1]);assert.equal(d.closed,1);
});
test('large history can be declined without loading or closing the preview',async t=>{
  const f=fixture(t),d=dom();d.rendered=false;for(let i=0;i<400;i++)f.context.chat.push({is_user:true,mes:'other'});let asked=0;
  const result=await reveal(f.input,{...d.options,confirmLarge:async n=>{asked=n;return false;}});assert.equal(result.status,'cancelled');assert.equal(asked,401);assert.equal(d.loaded.length,0);assert.equal(d.closed,0);
});
for(const kind of ['changed','account','missing','duplicate','cancelled'])test(`load ${kind} leaves preview and never scrolls stale source`,async t=>{
  const f=fixture(t),d=dom(),controller=new AbortController();d.rendered=false;
  const options={...d.options,signal:controller.signal,loadHost:async()=>({showMoreMessages:async()=>{
    d.rendered=true;if(kind==='changed')f.message.mes+=' edited';if(kind==='account')f.account='st-user:bob';if(kind==='missing')d.rendered=false;if(kind==='duplicate')d.duplicates=true;if(kind==='cancelled')controller.abort();
  }})};await assert.rejects(reveal(f.input,options));assert.equal(d.closed,0);assert.equal(d.scrolls.length,0);
});
test('missing or repeated DOM paragraph falls back to exact floor, not the first similar paragraph',async t=>{
  const f=fixture(t),d=dom();d.row.querySelector=()=>({querySelectorAll:()=>[d.paragraph,d.paragraph]});const result=await reveal(f.input,d.options);assert.equal(result.paragraph,false);assert.equal(result.floor,0);assert.equal(d.closed,1);
});
test('post-close frame rechecks source before scroll and does not schedule late scrolling',async t=>{
  const f=fixture(t),d=dom();await assert.rejects(reveal(f.input,{...d.options,frame:async()=>{f.message.mes+=' changed';}}));assert.equal(d.closed,1);assert.equal(d.scrolls.length,0);
});
test('timeout releases lease and late host load cannot close or scroll',async t=>{
  const f=fixture(t),d=dom(),held=gate();d.rendered=false;const work=reveal(f.input,{...d.options,timeoutMs:15,loadHost:()=>held.promise});await assert.rejects(work,/超时/);
  held.resolve({showMoreMessages:async()=>assert.fail('late load')});await new Promise(done=>setTimeout(done,10));assert.equal(d.closed,0);assert.equal(d.scrolls.length,0);assert.equal(f.context.eventSource.eventNames().length,0);
});
test('account or DOM identity changing during the final frame cannot scroll a reused row',async t=>{
  for(const kind of ['account','row']){const f=fixture(t),d=dom();await assert.rejects(reveal(f.input,{...d.options,frame:async()=>{
    if(kind==='account')f.account='st-user:bob';else d.chat.querySelectorAll=()=>[{...d.row}];
  }}));assert.equal(d.scrolls.length,0);assert.equal(f.context.eventSource.eventNames().length,0);}
});
test('outer cancellation and deadline release a source still waiting on account resolution immediately',async t=>{
  for(const timed of [true,false]){const f=fixture(t),d=dom(),held=gate(),entered=gate(),controller=new AbortController();
    const work=reveal({...f.input,account:()=>{entered.resolve();return held.promise;}},{...d.options,signal:controller.signal,timeoutMs:timed?30:1000});
    await entered.promise;if(!timed)controller.abort();await assert.rejects(work,/取消|超时/);assert.equal(f.context.eventSource.eventNames().length,0);
    held.resolve(f.scope.namespace);await new Promise(done=>setTimeout(done,10));assert.equal(d.closed,0);assert.equal(d.scrolls.length,0);
  }
});
