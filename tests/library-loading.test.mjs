import test from 'node:test';
import assert from 'node:assert/strict';
import {renderComfyLibrary,createComfyLibraryController} from '../qianmu-comfy-library-view.js';
import {renderComfyPools} from '../qianmu-comfy-pool-view.js';
import {renderCharacterArchive} from '../qianmu-character-archive-view.js';

const renderers={workflow:renderComfyLibrary,pool:renderComfyPools,character:renderCharacterArchive};
const blank=()=>({rows:[],bindings:[],subjects:[],search:'',shown:{},collapsed:{},busy:false,error:''});
for(const [kind,render] of Object.entries(renderers)){
  test(`${kind} distinguishes a confirmed empty library from pending or failed reads`,()=>{
    const empty=render(blank());assert.match(empty,/还没有/);assert.doesNotMatch(empty,/role="alert"/);
    const pending=render({...blank(),busy:true});assert.doesNotMatch(pending,/还没有/);assert.match(pending,/aria-busy="true"/);
    const failure=render({...blank(),error:'读取失败 <script>alert(1)</script>'});
    assert.match(failure,/role="alert"/);assert.match(failure,/读取失败 &lt;script&gt;/);assert.doesNotMatch(failure,/<script>|还没有/);
  });
}

test('workflow errors remain readable inside an editor without removing the draft or adding an apply action',()=>{
  const html=renderComfyLibrary({...blank(),error:'保存失败，请重试',draft:{name:'保留的草稿',document:{workflow:'{}',parameters:{},outputNodeId:''}}});
  assert.match(html,/role="alert"[^>]*>保存失败，请重试/);assert.match(html,/value="保留的草稿"/);
  assert.match(html,/data-comfy-action="save"/);assert.doesNotMatch(html,/data-comfy-action="apply"/);
});

const flush=async()=>{for(let n=0;n<5;n++)await new Promise(resolve=>setImmediate(resolve));};
for(const delayed of ['list','usage'])test(`workflow ${delayed} completion rechecks the account before publishing rows`,async()=>{
  let account='st-user:old',resolveRead,closed=0,delayedOnce=false;const calls=[],notices=[];
  const refresh={dataset:{comfyAction:'refresh'},addEventListener(_type,handler){this.click=handler;},closest:()=>null};
  const host={isConnected:true,innerHTML:'',closest:()=>null,querySelector:()=>null,querySelectorAll:selector=>selector==='[data-comfy-action]'?[refresh]:[]};
  const delay=async(name,value)=>{if(name===delayed&&!delayedOnce){delayedOnce=true;await new Promise(resolve=>resolveRead=resolve);}return value;};
  const store={
    list:async namespace=>{calls.push(['list',namespace]);return delay('list',[{id:'one',revision:'r1',version:1,name:namespace==='st-user:old'?'旧账户私有方案':'新账户方案',nodes:1,totalBytes:8}]);},
    usage:async namespace=>{calls.push(['usage',namespace]);return delay('usage',{count:1,versions:1,bytes:8,limit:100});},
    save:()=>assert.fail('read recovery cannot write'),close:()=>closed++,
  };
  const controller=createComfyLibraryController({store,resolveNamespace:async()=>account,notify:message=>notices.push(message)});
  try{
    controller.mount(host);await flush();assert.equal(typeof resolveRead,'function');
    account='st-user:new';resolveRead();await flush();
    assert.doesNotMatch(host.innerHTML,/旧账户私有方案/);assert.match(host.innerHTML,/账户已切换/);
    assert.deepEqual(calls,[['list','st-user:old'],['usage','st-user:old']]);
    refresh.click();await flush();assert.match(host.innerHTML,/新账户方案/);assert.doesNotMatch(host.innerHTML,/旧账户私有方案/);
    assert.deepEqual(calls.slice(2),[['list','st-user:new'],['usage','st-user:new']]);assert.equal(notices.length,1);
  }finally{controller.dispose();assert.equal(closed,1);}
});
