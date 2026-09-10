import test from 'node:test';
import assert from 'node:assert/strict';
import {createCoreadRecordsFixture} from './helpers/coread-center-fixture.mjs';

const overview=html=>html.slice(html.indexOf('<section class="sd-reader-memory-overview'),html.indexOf('</section>')+10);
test('summary tools suppress native collapse but allow delegated save and reorder clicks to reach the page',()=>{
  const {c,m}=createCoreadRecordsFixture();m.summaryItems=[{id:'custom',title:'Title',text:'text',order:1}];
  const html=c.renderMemRecordsTab(m),tools=[...html.matchAll(/<span class="sd-reader-promptblock-acts"[^>]*>/g)].map(x=>x[0]);
  assert.equal(tools.length,3);
  for(const tool of tools){assert.match(tool,/onclick="event.preventDefault\(\)"/);assert.doesNotMatch(tool,/stopPropagation/);}
});

test('records render preserves binding initialization and safety-read order without altering reader history',()=>{
  const {c,m,inputs,trace}=createCoreadRecordsFixture();delete inputs.store.coreadBound;
  const before=JSON.stringify(c.readerDialog),html=c.renderMemRecordsTab(m),card=overview(html);
  assert.deepEqual(Array.from(inputs.store.coreadBound),[]);
  assert.deepEqual(trace.map(x=>x[0]),['store','meta','safe','guide','guide','guide']);
  const safe=trace.find(x=>x[0]==='safe');assert.equal(safe[2],c.readerDialog.readBoundary);assert.equal(safe[3],m);
  assert.notEqual(safe[1],c.readerDialog.slices,'display sorting must use a copy');
  assert.equal(JSON.stringify(c.readerDialog),before);
  assert.match(card,/Book&lt;&amp;/);assert.match(card,/8 条对话 · 已整理 3 条/);
  for(const [n,label]of [[3,'记忆切片'],[5,'待整理对话'],[0,'绑定档案'],[2,'进度外隔离']])assert.ok(card.includes(`<b>${n}</b><small>${label}</small>`));
  assert.match(card,/sd-reader-tour-target/);
  trace.length=0;c.readerDialog.readBoundary=null;c.renderMemRecordsTab(m);
  assert.deepEqual(trace.map(x=>x[0]),['store','meta','boundary','safe','guide','guide','guide']);
  assert.equal(trace.find(x=>x[0]==='safe')[2],inputs.fallback);
});

test('summary item order, escaping and built-in deletion protection do not mutate stored prompts',()=>{
  const {c,m}=createCoreadRecordsFixture();
  m.summaryItems=Object.freeze([
    Object.freeze({id:'custom"',title:'Title<&',text:'</textarea><script>bad</script>',order:2}),
    Object.freeze({id:'builtin',title:'Built in',text:'fixed',order:1,builtin:true})]);
  const before=JSON.stringify(m),html=c.renderMemRecordsTab(m);
  const items=[...html.matchAll(/<details class="sd-reader-promptblock sd-reader-sumitem"[\s\S]*?<\/details>/g)].map(x=>x[0]);
  assert.equal(items.length,2);assert.match(items[0],/data-id="builtin"/);
  assert.match(items[0],/sd-reader-sumitem-up"[^>]* disabled/);assert.doesNotMatch(items[0],/sd-reader-sumitem-del/);
  assert.match(items[1],/sd-reader-sumitem-down"[^>]* disabled/);assert.match(items[1],/sd-reader-sumitem-del/);
  assert.match(items[1],/data-id="custom&quot;"/);assert.match(items[1],/Title&lt;&amp;/);
  assert.doesNotMatch(items[1],/<script>/);assert.match(items[1],/&lt;\/textarea>/);assert.equal(JSON.stringify(m),before);
});

test('worldbook synchronization shows its actual mode and remains unavailable while syncing',()=>{
  const {c,m}=createCoreadRecordsFixture();
  for(const [mode,label]of [['none','仅存千幕档案'],['dedicated','千幕伴读世界书'],['shared','正文记忆同书']])for(const busy of [false,true]){
    m.worldSyncMode=mode;c.coreadWorldSyncBusy=busy;
    const html=c.renderMemRecordsTab(m),select=html.match(/<select class="sd-reader-minput sd-reader-storagemode"[^>]*>[\s\S]*?<\/select>/)[0];
    assert.ok(html.includes(`>${label}</span>`));assert.equal(select.startsWith('<select class="sd-reader-minput sd-reader-storagemode" disabled>'),busy);
    assert.equal((select.match(/ selected/g)||[]).length,1);assert.ok(select.includes(`value="${mode}" selected`));
  }
});

test('manual batch rows exclude book offsets and archived dialogue while preserving active dialogue order',()=>{
  const {c,m}=createCoreadRecordsFixture();c.readerDialog.slices=[
    {id:'second',batch:3,src:'dialog',coveredFrom:4,coveredTo:6,compressed:true},
    {id:'book',batch:7,src:'text',coveredFrom:1000,coveredTo:5000},
    {id:'archived',batch:8,src:'dialog',coveredFrom:50,coveredTo:99,provenance:{dialogArchived:true}},
    {id:'first',batch:2,src:'dialog',coveredFrom:0,coveredTo:3},
    {id:'mainline',batch:9,src:'dialog',provenance:{source:'mainline'},coveredFrom:9000,coveredTo:9999}];
  const before=JSON.stringify(c.readerDialog.slices),html=c.renderMemRecordsTab(m);
  const rows=[...html.matchAll(/<div class="sd-reader-batchrow">[\s\S]*?<\/div>/g)].map(x=>x[0]);
  assert.equal(rows.length,2);assert.match(rows[0],/>#2</);assert.match(rows[0],/起始 1/);assert.match(rows[0],/>4 条</);
  assert.match(rows[1],/>#合并</);assert.match(rows[1],/起始 5/);assert.match(rows[1],/>3 条</);
  assert.equal(JSON.stringify(c.readerDialog.slices),before);assert.match(html,/最新批次 <b>#9<\/b>/,'overall last batch remains distinct from the dialogue-only table');
});

test('empty archive keeps management entry points without enabling destructive or impossible operations',()=>{
  const {c,m,inputs}=createCoreadRecordsFixture();inputs.meta=null;inputs.safe=[];
  c.readerDialog.slices=[];c.readerDialog.messages=[];c.readerDialog.cursor=0;
  const html=c.renderMemRecordsTab(m),card=overview(html);
  assert.match(card,/当前伴读档案/);assert.match(card,/sd-reader-slice-manage/);assert.match(card,/sd-reader-arch-manage/);
  assert.match(card,/sd-reader-slice-clear" disabled/);assert.match(html,/sd-reader-manual-go" disabled/);assert.match(html,/sd-reader-compress-go" disabled/);
  assert.doesNotMatch(html,/sd-reader-batchrow/);assert.doesNotMatch(html,/<b>-\d/);
  inputs.meta={title:''};assert.match(c.renderMemRecordsTab(m),/《未命名》/);
});
