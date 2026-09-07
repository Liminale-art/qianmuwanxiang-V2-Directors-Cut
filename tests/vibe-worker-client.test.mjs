import test from 'node:test';
import assert from 'node:assert/strict';
test('worker client is lazy, shared and closes pending calls; stale worker failures cannot close a replacement',async()=>{
  const original=globalThis.Worker,workers=[];
  class Worker extends EventTarget{
    constructor(url,options){super();this.url=url;this.options=options;this.messages=[];this.terminated=false;workers.push(this);}
    postMessage(message){if(this.cloneError)throw new DOMException('Cannot clone','DataCloneError');this.messages.push(message);}
    terminate(){this.terminated=true;}
    finish(index,value){this.dispatchEvent(new MessageEvent('message',{data:{ticket:this.messages[index].ticket,value}}));}
  }
  globalThis.Worker=Worker;const runtime=await import('../qianmu-vibe-assets.js');
  try{
    assert.equal(workers.length,0);const a=runtime.callVibeAsset('head',{id:'a'}),b=runtime.callVibeAsset('preview',{id:'a'});
    assert.equal(workers.length,1);assert.equal(workers[0].options.type,'module');workers[0].finish(1,null);workers[0].finish(0,{id:'a'});assert.deepEqual(await a,{id:'a'});assert.equal(await b,null);
    const pending=runtime.callVibeAsset('list');runtime.closeVibeAssetRuntime();await assert.rejects(pending,{code:'vibe_file_closed'});assert.equal(workers[0].terminated,true);
    const next=runtime.callVibeAsset('head');assert.equal(workers.length,2);workers[0].dispatchEvent(new Event('error'));assert.equal(workers[1].terminated,false);workers[1].finish(0,'new');assert.equal(await next,'new');
    workers[1].cloneError=true;await assert.rejects(()=>runtime.callVibeAsset('import',{file:()=>{}}),{code:'vibe_file_file'});workers[1].cloneError=false;
    const queue=Array.from({length:48},()=>runtime.callVibeAsset('head').catch(error=>error.code));await assert.rejects(()=>runtime.callVibeAsset('head'),{code:'vibe_file_busy'});
    runtime.closeVibeAssetRuntime();assert.deepEqual(await Promise.all(queue),Array(48).fill('vibe_file_closed'));
  }finally{runtime.closeVibeAssetRuntime();if(original===undefined)delete globalThis.Worker;else globalThis.Worker=original;}
});
