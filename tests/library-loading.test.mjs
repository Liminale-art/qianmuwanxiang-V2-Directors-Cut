import test from 'node:test';
import assert from 'node:assert/strict';
import {renderComfyLibrary,createComfyLibraryController} from '../qianmu-comfy-library-view.js';
import {renderComfyPools} from '../qianmu-comfy-pool-view.js';
import {renderCharacterArchive,createCharacterArchiveController} from '../qianmu-character-archive-view.js';

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

function characterFixture({read=async()=>({rows:[],bindings:[],imports:[]}),account=async()=> 'st-user:fixture'}={}){
  let reads=0,closes=0;const document=new EventTarget();document.activeElement=null;
  const host=()=>({isConnected:true,ownerDocument:document,innerHTML:'',closest:()=>null,contains:()=>false,querySelector:()=>null,
    querySelectorAll(selector){if(selector!=='[data-archive-action]')return [];
      if(!this.innerHTML.includes('data-archive-action="refresh"'))return [];const parent=this;
      const button={dataset:{archiveAction:'refresh'},addEventListener(_type,fn){parent.retry=()=>fn({preventDefault(){},stopPropagation(){}});}};return [button];}});
  const store={overview:async namespace=>{reads++;return read(namespace);},close(){closes++;}};
  const controller=createCharacterArchiveController({store,resolveNamespace:account,getContext:async()=>({chatKey:'chat',subjects:[]})});
  return {controller,host,get reads(){return reads;},get closes(){return closes;}};
}

test('character initial read failure stays a failure and its retry really reads again',async()=>{
  let fail=true;const f=characterFixture({read:async()=>{if(fail)throw Error('temporary read failure');return {rows:[],bindings:[],imports:[]};}}),host=f.host();
  try{f.controller.mount(host);await flush();assert.equal(f.reads,1);assert.match(host.innerHTML,/role="alert"/);assert.doesNotMatch(host.innerHTML,/还没有保存/);
    assert.equal(typeof host.retry,'function');fail=false;host.retry();await flush();assert.equal(f.reads,2);assert.match(host.innerHTML,/还没有保存/);
  }finally{f.controller.dispose();assert.equal(f.closes,1);}
});

test('character identity failure can retry without treating missing authorization as an empty library',async()=>{
  let fail=true;const f=characterFixture({account:async()=>{if(fail)throw Error('account unavailable');return 'st-user:fixture';}}),host=f.host();
  try{f.controller.mount(host);await flush();assert.equal(f.reads,0);assert.match(host.innerHTML,/account unavailable/);assert.doesNotMatch(host.innerHTML,/还没有保存/);
    fail=false;host.retry();await flush();assert.equal(f.reads,1);assert.match(host.innerHTML,/还没有保存/);
  }finally{f.controller.dispose();}
});

test('character repeated mount and host replacement share one in-flight list read',async()=>{
  let finish;const f=characterFixture({read:()=>new Promise(resolve=>finish=resolve)}),first=f.host(),second=f.host();
  try{f.controller.mount(first);f.controller.mount(first);await flush();assert.equal(f.reads,1);first.isConnected=false;f.controller.mount(second);f.controller.mount(second);
    finish({rows:[],bindings:[],imports:[]});await flush();assert.equal(f.reads,1);assert.match(second.innerHTML,/还没有保存/);
    const third=f.host();second.isConnected=false;f.controller.mount(third);await flush();assert.equal(f.reads,1);assert.match(third.innerHTML,/还没有保存/);
  }finally{f.controller.dispose();}
});

test('character remount does not publish a cached account before a new live identity check',async()=>{
  let owner='st-user:old';const f=characterFixture({account:async()=>owner,read:async namespace=>({rows:[{id:'one',name:namespace,category:'char',aliases:[],cover:''}],bindings:[],imports:[]})}),first=f.host();
  try{f.controller.mount(first);await flush();assert.match(first.innerHTML,/st-user:old/);
    owner='st-user:new';first.isConnected=false;const second=f.host();f.controller.mount(second);assert.doesNotMatch(second.innerHTML,/st-user:old/);await flush();
    assert.match(second.innerHTML,/账户已切换/);assert.doesNotMatch(second.innerHTML,/st-user:old/);second.retry();await flush();assert.equal(f.reads,2);assert.match(second.innerHTML,/st-user:new/);
  }finally{f.controller.dispose();}
});

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
