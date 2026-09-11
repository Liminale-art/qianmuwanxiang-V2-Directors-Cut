import test from 'node:test';
import assert from 'node:assert/strict';
import {createConfigUndoSlot} from '../qianmu-config-undo.js';
import {createConfigUndoAction} from '../qianmu-config-undo-action.js';

function fixture() {
  const undo=createConfigUndoSlot(),host={slot:{theme:'imported'}},notes=[],state={raw:'after',saves:0,busy:false};
  let live=host.slot;
  const storage={getItem:()=>state.raw,setItem:(_key,value)=>{state.raw=value;},removeItem:()=>{state.raw=null;}};
  const arm=()=>undo.remember({settings:{theme:'before'},layout:{available:true,raw:null},layoutAfter:{available:true,raw:'after'}},live);
  arm();
  const options={host,slot:'slot',setCurrent:value=>{live=value;},save:()=>{state.saves++;},layoutStorage:()=>storage,layoutKey:'layout',afterApply:()=>{},inject:()=>{},render:()=>{}};
  const run=createConfigUndoAction({undo,current:()=>live,activity:()=>({image:state.busy}),confirm:()=>state.confirm?.()??true,notify:(...args)=>notes.push(args),applyOptions:()=>options});
  return {undo,host,state,notes,options,run,arm,current:()=>live};
}

test('undo restores exact prior configuration and absent cache without creating redo',async()=>{
  const f=fixture();assert.equal((await f.run()).status,'applied');
  assert.equal(f.current().theme,'before');assert.equal(f.host.slot,f.current());assert.equal(f.state.raw,null);assert.equal(f.state.saves,1);
  assert.equal(f.undo.available(f.current()),false);assert.deepEqual(f.notes,[['已撤回本次配置恢复。','success']]);
});
test('cancellation retains recovery and does not touch settings or cache',async()=>{
  const f=fixture();f.state.confirm=()=>false;
  assert.equal((await f.run()).status,'cancelled');assert.equal(f.state.saves,0);assert.equal(f.state.raw,'after');assert.equal(f.undo.available(f.current()),true);
});
test('user edits, another tab cache writes and replaced records during confirmation cannot be overwritten',async()=>{
  for(const change of [f=>{f.current().theme='user';},f=>{f.state.raw='other tab';},f=>f.arm()]){
    const f=fixture();f.state.confirm=()=>{change(f);return true;};
    assert.equal((await f.run()).status,'stale');assert.equal(f.state.saves,0);
  }
});
test('running tasks block before and after confirmation, and missing storage fails closed',async()=>{
  for(const when of ['before','after','storage']){
    const f=fixture();let confirmed=0;
    f.state.confirm=()=>{confirmed++;f.state.busy=true;return true;};
    if(when==='before')f.state.busy=true;
    if(when==='storage')f.options.layoutStorage=()=>{throw Error('private fixture');};
    assert.equal((await f.run()).status,when==='storage'?'stale':'blocked');assert.equal(f.state.saves,0);assert.equal(confirmed,when==='after'?1:0);
  }
});
test('failed handoff compensates and retains retryable recovery',async()=>{
  const f=fixture();f.options.save=()=>{throw Error('private fixture');};
  assert.equal((await f.run()).status,'incomplete');assert.equal(f.current().theme,'imported');assert.equal(f.state.raw,'after');assert.equal(f.undo.available(f.current()),true);
  f.options.save=()=>{f.state.saves++;};assert.equal((await f.run()).status,'applied');
});
test('duplicate clicks do not open concurrent confirmations',async()=>{
  const f=fixture();let resolve;f.state.confirm=()=>new Promise(done=>{resolve=done;});
  const first=f.run();assert.equal((await f.run()).status,'busy');resolve(false);assert.equal((await first).status,'cancelled');
});
test('old completion cannot clear a newer recovery record created during asynchronous view work',async()=>{
  const f=fixture();f.options.inject=async()=>{f.arm();};
  assert.equal((await f.run()).status,'applied');assert.equal(f.undo.available(f.current()),true);
});
