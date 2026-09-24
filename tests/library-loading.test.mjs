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

function characterFixture({read=async()=>({rows:[],bindings:[],imports:[]}),account=async()=> 'st-user:fixture',...options}={}){
  let reads=0,closes=0;const document=new EventTarget();document.activeElement=null;
  const host=()=>({isConnected:true,ownerDocument:document,innerHTML:'',closest:()=>null,contains:()=>false,querySelector:()=>null,
    querySelectorAll(selector){if(selector!=='[data-archive-action]')return [];
      const parent=this;return [...this.innerHTML.matchAll(/data-archive-action="([^"]+)"/g)].map(([,action])=>({dataset:{archiveAction:action,category:'char'},addEventListener(_type,fn){const invoke=()=>fn({preventDefault(){},stopPropagation(){}});if(action==='refresh')parent.retry=invoke;if(action==='new')parent.create=invoke;}}));}});
  const store={overview:async namespace=>{reads++;return read(namespace);},close(){closes++;}};
  const controller=createCharacterArchiveController({store,resolveNamespace:account,getContext:async()=>({chatKey:'chat',subjects:[]}),...options});
  return {controller,host,document,get reads(){return reads;},get closes(){return closes;}};
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

test('character reopens a confirmed empty library after freshness expires without another blocking screen',async()=>{
  let time=1,finish,accounts=0,contexts=0;
  const f=characterFixture({now:()=>time,getScope:()=> 'chat',account:async()=>{accounts++;return 'st-user:fixture';},
    getContext:async()=>{contexts++;return {chatKey:'chat',subjects:[]};},read:()=>f.reads===1?Promise.resolve({rows:[],bindings:[],imports:[]}):new Promise(resolve=>finish=resolve)});
  const first=f.host();
  try{
    f.controller.mount(first);await flush();assert.equal(f.reads,1);assert.equal(contexts,1);assert.ok(accounts>=2);
    f.controller.detach();first.isConnected=false;time+=31000;const second=f.host();f.controller.mount(second);await flush();
    assert.equal(f.reads,2);assert.match(second.innerHTML,/还没有保存/);assert.doesNotMatch(second.innerHTML,/正在读取角色库|aria-busy="true"/);assert.equal(contexts,2);
    f.controller.mount(second);await flush();assert.equal(f.reads,2);
    second.create();await flush();assert.match(second.innerHTML,/sd-character-editor/);
    finish({rows:[{id:'one',name:'background',category:'char',aliases:[],cover:''}],bindings:[],imports:[]});await flush();
    assert.match(second.innerHTML,/sd-character-editor/);assert.doesNotMatch(second.innerHTML,/background/);
  }finally{f.controller.dispose();}
});

test('character close/reopen within freshness uses no catalogue read but still refreshes current subjects',async()=>{
  let contexts=0;const f=characterFixture({getScope:()=> 'chat',getContext:async()=>{contexts++;return {chatKey:'chat',subjects:[]};}}),first=f.host();
  try{f.controller.mount(first);await flush();f.controller.detach();first.isConnected=false;const second=f.host();f.controller.mount(second);await flush();
    assert.equal(f.reads,1);assert.equal(contexts,2);assert.match(second.innerHTML,/还没有保存/);
  }finally{f.controller.dispose();}
});

test('character changes while detached invalidate the otherwise fresh empty snapshot',async()=>{
  const f=characterFixture(),first=f.host();
  try{f.controller.mount(first);await flush();f.controller.detach();first.isConnected=false;f.document.dispatchEvent(new Event('qianmu-character-library-changed'));
    const next=f.host();f.controller.mount(next);await flush();assert.equal(f.reads,2);assert.match(next.innerHTML,/还没有保存/);
  }finally{f.controller.dispose();}
});

test('character invalidation during a pending read never paints the obsolete response or schedules a third read',async()=>{
  const pending=[],f=characterFixture({read:()=>new Promise(resolve=>pending.push(resolve))}),host=f.host();
  try{f.controller.mount(host);await flush();f.document.dispatchEvent(new Event('qianmu-character-library-changed'));
    pending[0]({rows:[{id:'old',name:'obsolete-row',category:'char',aliases:[],cover:''}],bindings:[],imports:[]});await flush();
    assert.equal(f.reads,2);assert.doesNotMatch(host.innerHTML,/obsolete-row/);
    pending[1]({rows:[],bindings:[],imports:[]});await flush();assert.equal(f.reads,2);assert.match(host.innerHTML,/还没有保存/);
  }finally{f.controller.dispose();}
});

test('character background response does not rebuild the focused search input',async()=>{
  let time=1,finish;const f=characterFixture({now:()=>time,getScope:()=> 'chat',read:()=>f.reads===1?Promise.resolve({rows:[],bindings:[],imports:[]}):new Promise(resolve=>finish=resolve)}),first=f.host();
  try{f.controller.mount(first);await flush();f.controller.detach();first.isConnected=false;time+=31000;const next=f.host();f.controller.mount(next);await flush();
    const before=next.innerHTML;f.document.activeElement={matches:()=>true};next.contains=()=>true;
    finish({rows:[{id:'new',name:'deferred-new-row',category:'char',aliases:[],cover:''}],bindings:[],imports:[]});await flush();
    assert.equal(next.innerHTML,before);f.document.activeElement=null;f.controller.detach();next.isConnected=false;
    const third=f.host();f.controller.mount(third);await flush();assert.equal(f.reads,2);assert.match(third.innerHTML,/deferred-new-row/);
  }finally{f.controller.dispose();}
});

test('character detach/remount during stale background refresh hands off the completed read without fetching twice',async()=>{
  let time=1,finish;const f=characterFixture({now:()=>time,getScope:()=> 'chat',read:()=>f.reads===1?Promise.resolve({rows:[],bindings:[],imports:[]}):new Promise(resolve=>finish=resolve)}),first=f.host();
  try{f.controller.mount(first);await flush();f.controller.detach();first.isConnected=false;time+=31000;
    const second=f.host();f.controller.mount(second);await flush();assert.equal(f.reads,2);
    f.controller.detach();second.isConnected=false;const third=f.host();f.controller.mount(third);await flush();
    finish({rows:[{id:'ready',name:'handed-off-result',category:'char',aliases:[],cover:''}],bindings:[],imports:[]});await flush();
    assert.equal(f.reads,2);assert.match(third.innerHTML,/handed-off-result/);
  }finally{f.controller.dispose();}
});

test('character owned store is replaced on account switch so a retry is not trapped in the old session',async()=>{
  let owner='st-user:first';const created=[],closed=[];
  const f=characterFixture({store:undefined,account:async()=>owner,createStore:()=>{
    const account=owner;created.push(account);return {overview:async namespace=>{assert.equal(namespace,account);return {rows:[],bindings:[],imports:[]};},close:()=>closed.push(account)};
  }}),first=f.host();
  try{f.controller.mount(first);await flush();f.controller.detach();first.isConnected=false;owner='st-user:second';const second=f.host();f.controller.mount(second);await flush();
    assert.match(second.innerHTML,/账户已切换/);second.retry();await flush();assert.match(second.innerHTML,/还没有保存/);
    assert.deepEqual(created,['st-user:first','st-user:second']);assert.deepEqual(closed,['st-user:first']);
  }finally{f.controller.dispose();assert.deepEqual(closed,['st-user:first','st-user:second']);}
});

test('character snapshots older than the retention window cannot mask a failed first read',async()=>{
  let time=1,fail=false;const f=characterFixture({now:()=>time,read:async()=>{if(fail)throw Error('offline');return {rows:[],bindings:[],imports:[]};}}),first=f.host();
  try{f.controller.mount(first);await flush();f.controller.detach();first.isConnected=false;time+=31*60*1000;fail=true;const next=f.host();f.controller.mount(next);await flush();
    assert.equal(f.reads,2);assert.match(next.innerHTML,/offline/);
  }finally{f.controller.dispose();}
});

for(const failure of ['account','auth','network'])test(`character stale-background ${failure} failure does not expose foreign data or mislabel first-load success`,async()=>{
  let time=1,owner='st-user:first',finish;
  const f=characterFixture({now:()=>time,getScope:()=> 'chat',account:async()=>owner,
    read:()=>f.reads===1?Promise.resolve({rows:[{id:'one',name:'private-old',category:'char',aliases:[],cover:''}],bindings:[],imports:[]}):new Promise((resolve,reject)=>finish={resolve,reject})}),first=f.host();
  try{f.controller.mount(first);await flush();f.controller.detach();first.isConnected=false;time+=31000;const next=f.host();f.controller.mount(next);await flush();
    assert.match(next.innerHTML,/private-old/);
    if(failure==='account'){owner='st-user:second';finish.resolve({rows:[],bindings:[],imports:[]});}
    else finish.reject(Object.assign(Error(failure==='auth'?'not authorized':'offline'),failure==='auth'?{status:401}:{}));
    await flush();assert.match(next.innerHTML,/role="alert"/);
    if(failure==='network')assert.match(next.innerHTML,/private-old/);else assert.doesNotMatch(next.innerHTML,/private-old/);
  }finally{f.controller.dispose();}
});

test('character scope changes during avatar resolution cannot publish a wrong-chat binding',async()=>{
  let scope='chat-a';const f=characterFixture({getScope:()=>scope,getContext:async()=>{scope='chat-b';return {chatKey:'chat-a',subjects:[]};}}),host=f.host();
  try{f.controller.mount(host);await flush();assert.equal(f.reads,0);assert.match(host.innerHTML,/页面已切换/);assert.doesNotMatch(host.innerHTML,/还没有保存/);}
  finally{f.controller.dispose();}
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
