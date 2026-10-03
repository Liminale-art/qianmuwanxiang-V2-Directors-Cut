import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComfyInbox} from '../qianmu-comfy-inbox-view.js';

const turn=()=>new Promise(resolve=>setImmediate(resolve));
const baseRow={attemptId:'attempt-one',model:'合成模型',createdAt:1700000000000,status:'available',imageCount:1,cacheBytes:1024,resultAvailable:true,canDiscard:false};
const capabilities={resultRetrieval:true,resultProviders:['runninghub'],submission:false,cancellation:false};
async function fixture(t,{rows=[baseRow],warning='',catalogError,localError}={}){
  const events={},calls=[],host={isConnected:true,innerHTML:'',contains:()=>true,addEventListener:(name,cb)=>events[name]=cb,removeEventListener:name=>delete events[name]};
  let current=true;
  const service={list:async()=>{calls.push('list');if(localError)throw Error(localError);return {namespace:'account',rows,bytes:1024};},
    catalog:async()=>{calls.push('catalog');if(catalogError)throw Error(catalogError);return {namespace:'account',originals:rows,warning,totals:{imageBytes:1024,metadataBytes:100,temporaryBytes:0,reservedBytes:0},cloudCapabilities:capabilities};},
    discard:async selected=>{calls.push(['discard',selected]);return {removed:selected.length};},removeLocal:async selected=>{calls.push(['removeLocal',selected]);return {removed:selected.length};}};
  const dispose=mountComfyInbox(host,{service,isCurrent:()=>current,receive:async row=>{calls.push(['receive',row]);return {archived:true};}});t.after(dispose);await turn();
  const click=async dataset=>{const button={dataset,disabled:false};await events.click({target:{closest:()=>button}});await turn();};
  const change=(dataset,checked=true)=>events.change({target:{dataset,checked}});
  return {host,calls,click,change,dispose,setCurrent:value=>{current=value;},get html(){return host.innerHTML;}};
}
const visibleText=html=>html.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g,'');
test('receipt rows keep compact identity/status/actions while IDs, capacity and platform details start folded',async t=>{
  const f=await fixture(t,{rows:[{...baseRow,engine:'cloud',task:{provider:'runninghub'},usage:{consumeCoins:'1.2500'}}]}),html=f.html,visible=visibleText(html);
  assert.match(visible,/合成模型/);assert.match(visible,/RunningHub · 待归档 · 1 张/);assert.match(visible,/>领取<\/button>/);
  assert.doesNotMatch(visible,/>attempt-one<|当前账户|平台用量|新任务支持|预留|RH币|原图保留/);
  assert.match(html,/<details class="sd-comfy-inbox-storage"><summary>存储与服务详情/);
  assert.match(html,/<details class="sd-comfy-inbox-row-detail"><summary>详情/);
  assert.match(html,/attempt-one/);assert.match(html,/RH币 1.2500/);assert.match(html,/清理保留已归档图片和防重复记录/);
  assert.doesNotMatch(html,/<details[^>]*\sopen/);assert.deepEqual(f.calls,['list','catalog']);
});
test('uncertain outcomes, in-flight caution and errors remain visible instead of entering a details fold',async t=>{
  const f=await fixture(t,{rows:[{...baseRow,attemptId:'unknown',resultAvailable:false,status:'uncertain'},
    {...baseRow,attemptId:'running',resultAvailable:false,status:'submitting',live:true},
    {...baseRow,attemptId:'failed',resultAvailable:false,status:'failed'}],warning:'读取部分失败 <unsafe>'});
  const visible=visibleText(f.html);
  assert.match(visible,/原任务结果待核查，请勿重复生成，以免重复付费/);assert.match(visible,/任务进行中，请勿重复生成/);
  assert.match(visible,/Comfy · 失败/);assert.match(visible,/role="alert">读取部分失败 &lt;unsafe&gt;/);assert.doesNotMatch(f.html,/<unsafe>/);
});
test('read failure is visible, not treated as an empty successful inbox; late or disposed scopes cannot repaint',async t=>{
  const f=await fixture(t,{catalogError:'目录暂不可读取'});
  assert.match(visibleText(f.html),/role="alert">目录暂不可读取/);assert.doesNotMatch(f.html,/暂无待领取记录/);
  const before=f.html;f.setCurrent(false);await f.click({action:'refresh'});assert.equal(f.html,before);assert.deepEqual(f.calls,['list','catalog']);
});
test('receiving is still explicit, targets the original row, and only refreshes the metadata after completion',async t=>{
  const rows=[{...baseRow,attemptId:'original'}],f=await fixture(t,{rows});
  await f.click({receive:'0'});const received=f.calls.find(call=>Array.isArray(call)&&call[0]==='receive');
  assert.equal(received[1],rows[0]);assert.deepEqual(f.calls.filter(call=>typeof call==='string'),['list','catalog','list','catalog']);
  assert.match(visibleText(f.html),/role="status">原图已归档/);
});
test('simplified view preserves the twenty-item destructive batch cap and excludes protected originals',async t=>{
  const rows=Array.from({length:45},(_,index)=>({...baseRow,attemptId:String(index),canDiscard:index!==0})),f=await fixture(t,{rows});
  f.change({action:'select-page'});await f.click({action:'clear'});
  const selected=f.calls.find(call=>Array.isArray(call)&&call[0]==='discard')[1];
  assert.equal(selected.length,20);assert.equal(selected.some(row=>row.attemptId==='0'),false);
  assert.deepEqual(selected.map(row=>row.attemptId),Array.from({length:20},(_,index)=>String(index+1)));
});
test('empty inbox states are explicit and model/record markup is escaped',async t=>{
  const empty=await fixture(t,{rows:[]});assert.match(visibleText(empty.html),/暂无待领取记录/);
  const f=await fixture(t,{rows:[{...baseRow,model:'<script>bad</script>',attemptId:'<img>'}]});
  assert.doesNotMatch(f.html,/<script>|<img>/);assert.match(f.html,/&lt;script&gt;bad&lt;\/script&gt;/);assert.match(f.html,/&lt;img&gt;/);
});
