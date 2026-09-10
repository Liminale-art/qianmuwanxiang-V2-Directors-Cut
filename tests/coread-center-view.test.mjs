import test from 'node:test';
import assert from 'node:assert/strict';
import {createCoreadCenterFixture} from './helpers/coread-center-fixture.mjs';

test('book status preserves read-boundary precedence and passes the original memory policy to filtering',()=>{
  const {c,trace}=createCoreadCenterFixture(),memory=Object.freeze({spoilerProtection:true}),before=JSON.stringify(c.readerDialog);
  const html=c.renderCoreadCenterStatus(memory);
  assert.deepEqual(trace.map(x=>x[0]),['meta','safe']);assert.equal(trace[1][1],c.readerDialog.slices);
  assert.equal(trace[1][2],c.readerDialog.readBoundary);assert.equal(trace[1][3],memory);
  assert.match(html,/Book&lt;&amp;/);assert.match(html,/已读 12.5% · 3 条记忆 · 2 条进度外隔离/);
  assert.doesNotMatch(html,/sd-reader-spoiler-filter/);assert.equal(JSON.stringify(c.readerDialog),before);
});

test('status fallback and progress formatting remain bounded without fabricating an open book',()=>{
  const {c,trace,inputs}=createCoreadCenterFixture();c.readerDialog.readBoundary=null;
  assert.match(c.renderCoreadCenterStatus({}),/已读 40%/);assert.deepEqual(trace.map(x=>x[0]),['meta','boundary','safe']);
  for(const [progress,expected]of [[-1,0],[150,100],['7.25',7.25],['bad',0],[undefined,60]]){
    c.readerDialog.readBoundary={progress};assert.match(c.renderCoreadCenterStatus({}),new RegExp(`已读 ${String(expected).replace('.','\\.')}%`));
  }
  inputs.meta=null;c.readerDialog.slices=null;c.readerDialog.readBoundary={};inputs.safe=[];
  const empty=c.renderCoreadCenterStatus({});assert.match(empty,/尚未打开书籍/);assert.match(empty,/已读 0% · 0 条记忆/);assert.doesNotMatch(empty,/进度外隔离/);
  inputs.meta={title:'',progress:0};assert.match(c.renderCoreadCenterStatus({}),/《未命名》/);
});

test('spoiler protection remains enabled by default and uses the existing switch markup',()=>{
  const {c}=createCoreadCenterFixture();
  for(const value of [undefined,true,false]){
    const memory=Object.freeze({spoilerProtection:value}),html=c.renderCoreadSpoilerGuard(memory);
    assert.match(html,/防全知剧透/);assert.match(html,/type="checkbox" class="sd-reader-spoiler-filter"/);assert.doesNotMatch(html,/<small>/);
    assert.equal(html.includes('is-protected'),value!==false);assert.equal(html.includes(' checked'),value!==false);
  }
});

test('guided steps respect the memory gate, first/last controls and absent-step state without advancing it',()=>{
  const {c}=createCoreadCenterFixture();assert.equal(c.renderCoreadGuide(),'');
  const all=c.coreadGuideSteps();c.COREAD_MEMORY_ENABLED=false;const visible=c.coreadGuideSteps();
  assert.ok(visible.length<all.length);assert.ok(visible.every(x=>!['records','inject'].includes(x.tab)));
  c.coreadGuideStep=0;const first=c.renderCoreadGuide();assert.match(first,/sd-reader-tour-prev" title="上一步" disabled/);assert.match(first,/title="下一步"/);
  c.coreadGuideStep=visible.length-1;assert.match(c.renderCoreadGuide(),/title="完成"/);assert.equal(c.coreadGuideStep,visible.length-1);
  c.coreadGuideStep=999;assert.equal(c.renderCoreadGuide(),'');
  c.coreadGuideStep=0;c.coreadGuideCurrent=()=>({title:'<title"',text:'<text&',icon:'fa-book'});
  const html=c.renderCoreadGuide();assert.match(html,/&lt;title&quot;/);assert.match(html,/&lt;text&amp;/);
});

test('transfer entry keeps the iOS native file input and tour highlighting without initiating data work',()=>{
  const {c}=createCoreadCenterFixture();const normal=c.renderCoreadPackBar();
  assert.match(normal,/<label class="sd-reader-pack-import"[^>]*>[\s\S]*<input type="file" class="sd-reader-pack-import-input sd-reader-native-file" accept="application\/json,\.json"><\/label>/);
  assert.match(normal,/不含 API 密钥/);assert.doesNotMatch(normal,/sd-reader-tour-target/);
  c.coreadGuideStep=c.coreadGuideSteps().findIndex(x=>x.target==='transfer');assert.match(c.renderCoreadPackBar(),/sd-reader-packbar sd-reader-tour-target/);
});
