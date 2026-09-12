import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../qianmu-focus-library-runtime.js',import.meta.url),'utf8');
function fixture(){
  const f={allowed:true,live:true,opened:0,loaded:0,released:0,notices:[]},owner={};
  const c=vm.createContext({createFocusLibraryStore:()=>({close(){}}),
    loadLocalChunk:async()=>{f.loaded++;if(f.wait)await f.wait;return {openFocusLibrary:async options=>{f.options=options;f.opened++;return {close:options.onClose};}};}});
  vm.runInContext(source.slice(source.indexOf('export function')).replace('export function','function'),c);
  f.runtime=c.createFocusLibraryRuntime({owner:()=>owner,resolveNamespace:async()=> 'account',ui:{host:()=>({isConnected:true}),changed(){}},notify:message=>f.notices.push(message),
    available:()=>f.allowed,watchView:()=>({check(){if(!f.live)throw Error('page closed');},release(){f.released++;}})});
  return f;
}
test('focus original manager owns activity from loading until close and refuses duplicate or competing work',async()=>{
  const f=fixture();f.allowed=false;await f.runtime.open({management:true});assert.equal(f.loaded,0);assert.equal(f.runtime.busy,false);
  f.allowed=true;let release;f.wait=new Promise(r=>release=r);const pending=f.runtime.open({management:true});await new Promise(r=>setImmediate(r));
  assert.equal(f.runtime.busy,true);await f.runtime.open({management:true});assert.equal(f.loaded,1);
  release();await pending;assert.equal(f.opened,1);assert.equal(f.runtime.busy,true);await f.options.guard();
  f.allowed=false;await assert.rejects(f.options.guard(),/页面或账户已变化/);assert.equal(f.options.isActive(),false);
  f.runtime.close();assert.equal(f.runtime.busy,false);assert.equal(f.released,1);
});
test('focus manager does not reopen after closing or view invalidation while its chunk is pending',async()=>{
  for(const change of ['close','page','failure']){
    const f=fixture();let release,reject;f.wait=new Promise((a,b)=>{release=a;reject=b;});
    const pending=f.runtime.open({management:true});await new Promise(r=>setImmediate(r));
    if(change==='close')f.runtime.close();if(change==='page')f.live=false;
    change==='failure'?reject(Error('synthetic chunk failure')):release();await pending;
    assert.equal(f.opened,0);assert.equal(f.runtime.busy,false);assert.equal(f.released,1);
  }
});
