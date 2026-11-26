import test from 'node:test';
import assert from 'node:assert/strict';
import {createCoreadRecordsFixture} from './helpers/coread-center-fixture.mjs';

const overview=html=>html.slice(html.indexOf('<section class="sd-reader-memory-overview'),html.indexOf('</section>')+10);
test('summary tools suppress native collapse but allow delegated save and reorder clicks to reach the page',()=>{
  const {c,m}=createCoreadRecordsFixture();m.summaryPrompts.dialog=[{id:'custom',title:'Title',text:'text',order:1}];
  const html=c.renderMemRecordsTab(m),tools=[...html.matchAll(/<span class="sd-reader-promptblock-acts"[^>]*>/g)].map(x=>x[0]);
  assert.equal(tools.length,1);
  for(const tool of tools){assert.match(tool,/onclick="event.preventDefault\(\)"/);assert.doesNotMatch(tool,/stopPropagation/);}
});

test('records render keeps the safety-read order without altering reader history or reading archive bindings',()=>{
  const {c,m,inputs,trace}=createCoreadRecordsFixture();
  const before=JSON.stringify(c.readerDialog),html=c.renderMemRecordsTab(m),card=overview(html);
  assert.deepEqual(trace.map(x=>x[0]),['meta','safe','guide','guide']);
  const safe=trace.find(x=>x[0]==='safe');assert.equal(safe[2],c.readerDialog.readBoundary);assert.equal(safe[3],m);
  assert.equal(JSON.stringify(c.readerDialog),before);
  assert.match(card,/Book&lt;&amp;/);assert.match(card,/8 条对话 · 已整理 3 条/);
  for(const [n,label]of [[3,'记忆'],[5,'待总结对话'],[0,'待总结字'],[2,'进度外隔离']])assert.ok(card.includes(`<b>${n}</b><small>${label}</small>`),label);
  assert.doesNotMatch(card,/绑定档案|管理档案|sd-reader-arch-/);
  assert.match(card,/sd-reader-tour-target/);
  trace.length=0;c.readerDialog.readBoundary=null;c.renderMemRecordsTab(m);
  assert.deepEqual(trace.map(x=>x[0]),['meta','boundary','safe','guide','guide']);
  assert.equal(trace.find(x=>x[0]==='safe')[2],inputs.fallback);
});

test('the overview carries both automatic switches; a comic drops the text switch and the pending characters',()=>{
  const {c,m,inputs}=createCoreadRecordsFixture();Object.assign(m,{autoDistill:true,autoDistillText:false});
  let card=overview(c.renderMemRecordsTab(m));
  assert.match(card,/自动总结对话<\/span><label class="sd-reader-mtoggle"><input type="checkbox" class="sd-reader-autodistill-en" checked>/);
  assert.match(card,/自动总结正文<\/span><label class="sd-reader-mtoggle"><input type="checkbox" class="sd-reader-autotext-en">/);
  inputs.safe=[{id:1},{id:2},{id:3}];card=overview(c.renderMemRecordsTab(m));
  assert.doesNotMatch(card,/进度外隔离/,'no isolation cell when nothing is isolated');
  inputs.meta={...inputs.meta,mode:'comic'};card=overview(c.renderMemRecordsTab(m));
  assert.doesNotMatch(card,/自动总结正文|待总结字/);assert.match(card,/自动总结对话/);
});

test('a failed stage summary shows its reason in the overview with a retry button',()=>{
  const {c,m}=createCoreadRecordsFixture();
  assert.doesNotMatch(c.renderMemRecordsTab(m),/sd-reader-stage-retry/);
  c.readerDialog.stageFailure={sliceCount:3,reason:'API 鉴权失败<'};
  const card=overview(c.renderMemRecordsTab(m));
  assert.match(card,/阶段总结没有完成：API 鉴权失败&lt;/);assert.match(card,/sd-reader-stage-retry/);
});

test('summary item order, escaping and built-in deletion protection do not mutate stored prompts',()=>{
  const {c,m}=createCoreadRecordsFixture();
  m.summaryPrompts=Object.freeze({book:[],stage:[],dialog:Object.freeze([
    Object.freeze({id:'custom"',title:'Title<&',text:'</textarea><script>bad</script>',order:2}),
    Object.freeze({id:'builtin',title:'Built in',text:'fixed',order:1,builtin:true})])});
  const before=JSON.stringify(m),html=c.renderMemRecordsTab(m);
  const items=[...html.matchAll(/<details class="sd-reader-promptblock sd-reader-sumitem"[\s\S]*?<\/details>/g)].map(x=>x[0]);
  assert.equal(items.length,2);assert.match(items[0],/data-id="builtin"/);
  assert.match(items[0],/sd-reader-sumitem-up"[^>]* disabled/);assert.doesNotMatch(items[0],/sd-reader-sumitem-del/);
  assert.match(items[1],/sd-reader-sumitem-down"[^>]* disabled/);assert.match(items[1],/sd-reader-sumitem-del/);
  assert.match(items[1],/data-id="custom&quot;"/);assert.match(items[1],/Title&lt;&amp;/);
  assert.doesNotMatch(items[1],/<script>/);assert.match(items[1],/&lt;\/textarea>/);assert.equal(JSON.stringify(m),before);
});

test('the prompt card shows one group at a time behind 对话总结／正文总结／阶段总结 tabs, with no separate book prompt box',()=>{
  const {c,m}=createCoreadRecordsFixture();
  m.summaryPrompts={dialog:[{id:'d1',title:'对话条',text:'a',order:0}],book:[{id:'b1',title:'正文条',text:'b',order:0}],stage:[{id:'s1',title:'阶段条',text:'c',order:0}]};
  let html=c.renderMemRecordsTab(m);
  const tabs=[...html.matchAll(/<button type="button" class="sd-reader-sumtab( active)?" data-kind="(\w+)" aria-pressed="(\w+)">([^<]+)<\/button>/g)].map(x=>[x[2],!!x[1],x[3],x[4]]);
  assert.deepEqual(tabs,[['dialog',true,'true','对话总结'],['book',false,'false','正文总结'],['stage',false,'false','阶段总结']]);
  assert.match(html,/data-id="d1"/);assert.doesNotMatch(html,/data-id="b1"|data-id="s1"/);
  assert.doesNotMatch(html,/sd-reader-distillprompt|蒸馏书籍提示词/);
  assert.match(html,/<details class="sd-reader-mcard sd-reader-sumcard" data-keep-open="prompts">/,'collapsed until the reader opens it');
  c.coreadPromptTab='stage';c.coreadOpenCards.add('prompts');html=c.renderMemRecordsTab(m);
  assert.match(html,/data-id="s1"/);assert.doesNotMatch(html,/data-id="d1"/);assert.match(html,/sd-reader-sumcard" data-keep-open="prompts" open>/);
  assert.match(html,/class="sd-reader-sumtab active" data-kind="stage"/);
});

test('summary settings gather the frequencies, the length limits, the date switch and the stage numbers in one folded card',()=>{
  const {c,m,inputs}=createCoreadRecordsFixture();
  Object.assign(m,{autoDistill:true,autoDistillText:false,distillEvery:30,distillTextEvery:8000,sliceChars:300,readDateInSummary:false,stageAuto:true,stageTrigger:100,stageKeep:20,stageChars:800});
  let html=c.renderMemRecordsTab(m);
  const card=html.slice(html.indexOf('<details class="sd-reader-mcard sd-reader-setcard"'),html.indexOf('</details>',html.indexOf('sd-reader-setcard')));
  const labels=[...card.matchAll(/<span class="sd-reader-mrow-lab">([^<]+)<\/span>/g)].map(x=>x[1]);
  assert.deepEqual(labels,['对话每多少条总结一次','正文每多少字总结一次','每条切片字数上限','记下日期','自动阶段总结','阶段总结触发（条）','保留最近切片','每条阶段总结字数上限']);
  for(const [key,value]of [['distillEvery',30],['distillTextEvery',8000],['sliceChars',300],['stageTrigger',100],['stageKeep',20],['stageChars',800]])
    assert.match(card,new RegExp(`data-key="${key}"[^>]*value="${value}"`),key);
  assert.match(card,/data-key="distillTextEvery"[^>]*disabled/,'text frequency greys out while automatic text summary is off');
  assert.doesNotMatch(card,/data-key="distillEvery"[^>]*disabled/);
  assert.match(html,/<details class="sd-reader-mcard sd-reader-setcard" data-keep-open="settings">/,'folded until opened');
  m.stageAuto=false;c.coreadOpenCards.add('settings');html=c.renderMemRecordsTab(m);
  assert.match(html,/sd-reader-setcard" data-keep-open="settings" open>/);
  assert.equal((html.match(/data-key="stage\w+"[^>]* disabled>/g)||[]).length,3);
  inputs.meta={...inputs.meta,mode:'comic'};assert.doesNotMatch(c.renderMemRecordsTab(m),/正文每多少字总结一次/);
});

test('the storage-mode control is gone, including for settings saved with an old worldbook mode',()=>{
  const {c,m}=createCoreadRecordsFixture();
  for(const mode of [undefined,'none','dedicated','shared']){
    if(mode)m.worldSyncMode=mode;
    const html=c.renderMemRecordsTab(m);
    assert.doesNotMatch(html,/sd-reader-storagemode|世界书|从主线选择总结|sd-reader-distill-mainline|sd-reader-mainlineprompt/);
  }
});

test('manual summary is one card: a dialogue range and, for text books, 总结已读／总结全书; no batch table or old merge card',()=>{
  const {c,m}=createCoreadRecordsFixture();c.readerDialog.slices=[{id:'first',batch:2,src:'dialog',coveredFrom:0,coveredTo:3},{id:'book',batch:7,src:'text',coveredFrom:1000,coveredTo:5000}];
  const before=JSON.stringify(c.readerDialog.slices),html=c.renderMemRecordsTab(m);
  const card=html.slice(html.indexOf('手动总结'),html.indexOf('sd-reader-setcard'));
  assert.match(card,/对话 第[\s\S]*sd-reader-manual-from[\s\S]*sd-reader-manual-to[\s\S]*>开始<\/button>/);
  assert.match(card,/正文[\s\S]*sd-reader-distill-text">总结已读<\/button><button type="button" class="sd-reader-mbtn sd-reader-distill-fullbook">总结全书<\/button>/);
  assert.doesNotMatch(html,/batchrow|batchtable|最新批次|蒸馏|二次总结|书籍蒸馏|伴读对话·自动总结/);
  assert.equal(JSON.stringify(c.readerDialog.slices),before);
});

test('empty archive keeps management entry points without enabling destructive or impossible operations',()=>{
  const {c,m,inputs}=createCoreadRecordsFixture();inputs.meta=null;inputs.safe=[];
  c.readerDialog.slices=[];c.readerDialog.messages=[];c.readerDialog.cursor=0;
  const html=c.renderMemRecordsTab(m),card=overview(html);
  assert.match(card,/当前伴读档案/);assert.doesNotMatch(card,/sd-reader-arch-manage/);
  assert.match(html,/sd-reader-slice-manage"><i class="fa-solid fa-table-list"><\/i>管理记忆/);
  assert.match(html,/sd-reader-slice-clear" disabled><i class="fa-solid fa-trash-can"><\/i>清空记忆/);
  assert.match(html,/sd-reader-manual-go" disabled/);assert.doesNotMatch(html,/sd-reader-compress|二次总结/);
  assert.doesNotMatch(html,/<b>-\d/);
  inputs.meta={title:''};assert.match(c.renderMemRecordsTab(m),/《未命名》/);
});

test('the 关联伴读 entry appears only while Yimu is attached',()=>{
  const {c,m,inputs}=createCoreadRecordsFixture();
  assert.doesNotMatch(overview(c.renderMemRecordsTab(m)),/sd-reader-yimu-link|关联伴读/);
  inputs.linkAvailable=true;
  const card=overview(c.renderMemRecordsTab(m));
  assert.equal((card.match(/class="sd-reader-mbtn sd-reader-yimu-link"/g)||[]).length,1);assert.match(card,/><\/i>关联伴读<\/button>/);
  assert.match(card,/<b>未关联<\/b><small>关联伴读<\/small>/);
  inputs.linked=true;const linked=overview(c.renderMemRecordsTab(m));
  assert.match(linked,/<b>已关联<\/b><small>关联伴读<\/small>/);assert.match(linked,/更新关联伴读<\/button>/);
});
