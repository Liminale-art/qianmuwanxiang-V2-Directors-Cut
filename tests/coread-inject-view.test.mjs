import test from 'node:test';
import assert from 'node:assert/strict';
import {createCoreadInjectFixture} from './helpers/coread-center-fixture.mjs';

const actual=html=>html.slice(html.indexOf('<div class="sd-reader-injslices">'),html.indexOf('</details>'));
test('injection display keeps safety filtering before recent exclusion and candidate preview without rewriting history',()=>{
  const {c,m,inputs,trace}=createCoreadInjectFixture();
  const safe=[{id:'recent'},{id:'match'}];inputs.safe=safe;inputs.recent=[{slice:safe[0]}];
  c.readerDialog.messages=[{text:'old'},{text:'one'},{text:'two'}];
  const before=JSON.stringify(c.readerDialog);c.renderMemInjectTab(m);
  assert.deepEqual(trace.map(x=>x[0]),['safe','recent','recall','dict','bound']);
  assert.equal(trace[0][1],c.readerDialog.slices);assert.equal(trace[0][2],c.readerDialog.readBoundary);assert.equal(trace[0][3],m);
  assert.equal(trace[1][1],1);assert.equal(trace[1][2],safe);
  assert.equal(trace[2][1],'one\ntwo');assert.equal(trace[2][2],2);assert.deepEqual(Array.from(trace[2][3]),['recent']);assert.equal(trace[2][4],safe);
  assert.equal(trace[3][1],safe);assert.equal(JSON.stringify(c.readerDialog),before);
  trace.length=0;c.readerDialog.readBoundary=null;c.renderMemInjectTab(m);
  assert.deepEqual(trace.map(x=>x[0]),['boundary','safe','recent','recall','dict','bound']);assert.equal(trace[1][2],inputs.fallback);
});

test('actual injection replays recorded IDs only, omits deleted or progress-blocked rows, and retains latest safe text',()=>{
  const {c,m,inputs}=createCoreadInjectFixture();
  const keep={id:'keep',summary:'edited <safe>',batch:7,src:'book',keywords:['hit']};
  const candidate={id:'candidate',summary:'candidate-only-secret',batch:8,keywords:['other']};
  inputs.safe=[keep,candidate];inputs.recall=[{slice:candidate,hits:['other'],score:2}];
  c.readerDialog.lastInjected={channel:'mainline',items:[{id:'keep',hits:['hit']},{id:'deleted'},{id:'blocked'}]};
  const before=JSON.stringify(c.readerDialog.lastInjected),html=c.renderMemInjectTab(m),card=actual(html);
  assert.match(html,/最近一次·主线联动/);assert.match(card,/#7/);assert.match(card,/edited &lt;safe>/);assert.match(card,/书中内容/);
  assert.equal((card.match(/class="sd-reader-injslice inj"/g)||[]).length,1);
  assert.doesNotMatch(card,/candidate|deleted|blocked/);assert.doesNotMatch(html,/candidate-only-secret/);
  assert.match(html,/当前已隔离 1 条/);assert.equal(JSON.stringify(c.readerDialog.lastInjected),before);
});

test('empty actual history never promotes current candidates and scan fallback remains bounded',()=>{
  const {c,m,inputs,trace}=createCoreadInjectFixture();inputs.safe=[];m.recallScanMessages=0;
  let html=c.renderMemInjectTab(m);assert.match(actual(html),/尚无注入记录/);assert.doesNotMatch(html,/最近一次·/);
  assert.match(html,/最近 8 条对话/);assert.match(html,/（还没有对话）/);assert.equal(trace.find(x=>x[0]==='recall')[2],1);
  c.readerDialog.lastInjected={channel:'companion',items:[]};html=c.renderMemInjectTab(m);
  assert.match(actual(html),/尚无注入记录/);assert.match(html,/最近一次·伴读对话/);
});

test('keyword hits highlight retrieval but not unconditional recent rows, and preview never reveals summary text',()=>{
  const {c,m,inputs}=createCoreadInjectFixture();
  const slice={id:'a',compressed:true,summary:'actual-text',src:'dialog',provenance:{source:'mainline'},keywords:['hit<&','other']};
  inputs.safe=[slice];inputs.recall=[{slice,hits:['hit<&','hit<&'],score:1.234}];
  c.readerDialog.lastInjected={channel:'companion',items:[{id:'a',recent:true,hits:['hit<&']}]};
  let html=c.renderMemInjectTab(m),card=actual(html);
  assert.match(card,/#合并/);assert.match(card,/src-mainline/);assert.match(card,/正文回响/);assert.doesNotMatch(card,/slice-key on/);
  assert.match(html,/命中 2 · 分 1\.23/);assert.match(html,/slice-key on">hit&lt;&amp;/);
  const anchors=html.slice(html.indexOf('<div class="sd-reader-anchorbar">'),html.indexOf('③ 向量召回'));
  assert.equal((anchors.match(/>hit&lt;&amp;<\/span>/g)||[]).length,1);
  const rows=html.slice(html.indexOf('<div class="sd-reader-injrows">'));assert.doesNotMatch(rows,/actual-text/);
  c.readerDialog.lastInjected.items[0].recent=false;html=c.renderMemInjectTab(m);assert.match(actual(html),/slice-key on/);
});

test('dictionary selection fallback and default protection remain owned by the caller while mainline controls follow its switch',()=>{
  const {c,m,inputs}=createCoreadInjectFixture();
  m.dictBooks.push({id:'custom"',name:'Custom<&',pairs:{'canon<&':['alias<&']}});inputs.bound=['custom"'];inputs.dict={a:[],b:[]};
  c.coreadCurrentDictId='missing';let html=c.renderMemInjectTab(m);
  assert.equal(c.coreadCurrentDictId,'default');assert.doesNotMatch(html,/sd-reader-dictbook-delbtn/);
  for(const control of ['recall','recent','depth'])assert.match(html,new RegExp('sd-reader-mainline-'+control+'"[^>]*value="0" disabled'));
  c.coreadCurrentDictId='custom"';m.mainlineFeedback=true;const before=JSON.stringify(m);html=c.renderMemInjectTab(m);
  assert.equal(c.coreadCurrentDictId,'custom"');assert.match(html,/value="custom&quot;" selected/);assert.match(html,/Custom&lt;&amp; ✓/);
  assert.match(html,/data-canon="canon&lt;&amp;"/);assert.match(html,/alias&lt;&amp;/);assert.match(html,/解除绑定/);assert.match(html,/sd-reader-dictbook-delbtn/);
  assert.match(html,/检索词典 <span class="sd-reader-inj-tag">2<\/span>/);
  for(const control of ['recall','recent','depth'])assert.doesNotMatch(html,new RegExp('sd-reader-mainline-'+control+'"[^>]*disabled'));
  assert.equal(JSON.stringify(m),before);
});
