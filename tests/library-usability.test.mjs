import test from 'node:test';
import assert from 'node:assert/strict';
import {createStoryboardVibeLibraryController} from '../qianmu-vibe-library-view.js';
import {createVibeLibraryAssets} from '../qianmu-vibe-library-assets.js';
import {createComfyLibraryController,renderComfyLibrary} from '../qianmu-comfy-library-view.js';
import {createComfyPoolController,renderComfyPools} from '../qianmu-comfy-pool-view.js';

const flush=async()=>{for(let step=0;step<8;step++)await new Promise(resolve=>setImmediate(resolve));};
const document={workflow:JSON.stringify({save:{class_type:'SaveImage',inputs:{text:'%qianmu_prompt%'}}}),parameters:{},outputNodeId:'save'};

// This host keeps event/field behavior, rather than asserting source snippets.
// No browser, images, network or generation is needed for editor visibility.
function vibeHost(){
  const nodes=new Map();let html='';
  const host={isConnected:true,contains:()=>true,
    get innerHTML(){return html;},set innerHTML(value){html=value;nodes.clear();},
    querySelector(selector){return this.querySelectorAll(selector)[0]||null;},
    querySelectorAll(selector){
      if(!selector.startsWith('.'))return [];
      const className=selector.slice(1),tag=html.match(new RegExp(`<[^>]+class="[^"]*\\b${className}\\b[^\"]*"[^>]*>`));if(!tag)return [];
      if(!nodes.has(selector))nodes.set(selector,{isConnected:true,value:tag[0].match(/value="([^"]*)"/)?.[1]||'',disabled:/\sdisabled/.test(tag[0]),
        addEventListener(type,callback){this[type]=callback;},focus(){},scrollIntoView(){},closest:()=>({dataset:{vibeId:'vibe-one'}})});
      return [nodes.get(selector)];
    },
    click(selector){const node=this.querySelector(selector);assert.ok(node,selector);assert.equal(node.disabled,false);node.click?.({type:'click',preventDefault(){},currentTarget:node});},
  };
  return host;
}

test('Vibe opens as a browsable library; only new/edit opens fields, save/cancel closes them',async()=>{
  const host=vibeHost(),rows=[{id:'vibe-one',name:'Existing',previewUrl:'/user/images/one.png',strength:.6,informationExtracted:1}],saved=[],notices=[];
  const controller=createStoryboardVibeLibraryController({items:()=>rows,gallery:()=>[],onNotice:message=>notices.push(message),remove:async()=>true,
    save:async(_node,{readDraft})=>{saved.push(readDraft());return true;}});
  try{
    controller.mount(host);assert.match(host.innerHTML,/sd-vibe-new/);assert.doesNotMatch(host.innerHTML,/sd-vibe-editor|sd-storyboard-vibe-name/);
    host.click('.sd-vibe-new');await flush();assert.match(host.innerHTML,/sd-vibe-editor/);
    host.querySelector('.sd-storyboard-vibe-name').value='Created';host.click('.sd-storyboard-create-vibe');await flush();
    assert.equal(saved.length,1);assert.equal(saved[0].name,'Created');assert.doesNotMatch(host.innerHTML,/sd-vibe-editor/);assert.equal(host.querySelector('.sd-vibe-new').disabled,false);
    host.click('.sd-vibe-edit');await flush();assert.equal(host.querySelector('.sd-storyboard-vibe-name').value,'Existing');
    host.click('.sd-vibe-reset-editor');await flush();assert.doesNotMatch(host.innerHTML,/sd-vibe-editor/);assert.equal(saved.length,1);assert.deepEqual(notices,[]);
  }finally{controller.dispose();}
});

test('Vibe keeps an explicit unsaved edit across host remounts without reopening an idle editor',async()=>{
  const first=vibeHost(),second=vibeHost(),controller=createStoryboardVibeLibraryController({items:()=>[],gallery:()=>[]});
  try{
    controller.mount(first);controller.detach();controller.mount(second);assert.doesNotMatch(second.innerHTML,/sd-vibe-editor/);
    second.click('.sd-vibe-new');await flush();second.querySelector('.sd-storyboard-vibe-name').value='Keep my draft';
    controller.detach();controller.mount(first);assert.equal(first.querySelector('.sd-storyboard-vibe-name').value,'Keep my draft');
  }finally{controller.dispose();}
});

const namespace='st-user:library-test',reference={version:1,namespace,id:'a'.repeat(64)};
function assetHarness(call,options={}){
  let account=namespace,current=true;
  const assets=createVibeLibraryAssets({state:{vibeLibrary:[]},namespace,call,...options,
    guard:async()=>{if(account!==namespace)throw Error('account changed');},isCurrent:()=>current,publish(){},uid:()=> 'unused'});
  return {assets,account:value=>account=value,current:value=>current=value};
}

test('Vibe repeated thumbnails share in-flight IO and a bounded short cache; account checks remain live',async()=>{
  let reads=0,release;const f=assetHarness(()=>{reads++;return new Promise(resolve=>release=resolve);}),blob=new Blob(['thumbnail']);
  const first=f.assets.preview(reference),second=f.assets.preview(reference);await flush();assert.equal(reads,1);
  release(blob);assert.equal(await first,blob);assert.equal(await second,blob);assert.equal(await f.assets.preview(reference),blob);assert.equal(reads,1);
  f.account('st-user:other');await assert.rejects(()=>f.assets.preview(reference),/account changed/);assert.equal(reads,1);
  f.account(namespace);f.current(false);await assert.rejects(()=>f.assets.preview(reference),/页面已变化/);
});

test('Vibe failed and missing thumbnail reads are retryable and originals are never cached',async()=>{
  let reads=0;const f=assetHarness(async type=>{reads++;if(reads===1)throw Error('offline');return type==='original-preview'?new Blob(['original']):null;});
  await assert.rejects(()=>f.assets.preview(reference),/offline/);assert.equal(await f.assets.preview(reference),null);
  assert.ok(await f.assets.preview(reference,{original:true}) instanceof Blob);assert.ok(await f.assets.preview(reference,{original:true}) instanceof Blob);assert.equal(reads,6);
});

test('Vibe thumbnail cache evicts by count and does not retain large image data',async()=>{
  const calls=[];const f=assetHarness(async(_type,{id})=>{calls.push(id);return new Blob([id==='f'.repeat(64)?new Uint8Array(1024*1024+1):id]);});
  for(let n=1;n<=33;n++)await f.assets.preview({...reference,id:n.toString(16).padStart(64,'0')});
  await f.assets.preview({...reference,id:'1'.padStart(64,'0')});assert.equal(calls.length,34);
  await f.assets.preview({...reference,id:'f'.repeat(64)});await f.assets.preview({...reference,id:'f'.repeat(64)});assert.equal(calls.length,36);
});

test('Vibe cache expires and evicts by retained bytes, without returning a late old-account image',async()=>{
  let reads=0,time=0;const f=assetHarness(async()=>{reads++;return new Blob([new Uint8Array(1024*1024)]);},{now:()=>time});
  for(let n=1;n<=5;n++)await f.assets.preview({...reference,id:n.toString(16).padStart(64,'0')});
  await f.assets.preview({...reference,id:'1'.padStart(64,'0')});assert.equal(reads,6);
  time=30001;await f.assets.preview({...reference,id:'1'.padStart(64,'0')});assert.equal(reads,7);
  let release;const pending=assetHarness(()=>new Promise(resolve=>release=resolve)),request=pending.assets.preview(reference);await flush();
  pending.account('st-user:other');release(new Blob(['late private preview']));await assert.rejects(request,/account changed/);
});

test('workflow fields follow the actual platform and hidden RH values remain unmodified',()=>{
  const rh={...document,runninghubInstanceType:'plus',consoleUrl:'https://www.runninghub.ai/workflow/123'},before=structuredClone(rh),draft={name:'saved',document:rh};
  for(const connection of [null,{baseUrl:'http://127.0.0.1:8188'},{baseUrl:'https://cloud.comfy.org'},{baseUrl:'https://www.runninghub.ai.invalid'}]){
    const html=renderComfyLibrary({draft,connection});assert.doesNotMatch(html,/data-comfy-runtime|data-comfy-console|RunningHub 运行配置/);
  }
  const html=renderComfyLibrary({draft,connection:{baseUrl:'https://www.runninghub.ai'}});assert.match(html,/data-comfy-runtime/);assert.match(html,/value="plus" selected/);assert.match(html,/data-comfy-console/);assert.deepEqual(rh,before);
});

test('daily workflow and selection libraries omit storage diagnostics and fold management/history',()=>{
  const usage={count:1,versions:8,bytes:8765,limit:999999,persistence:'st-account-file'},row={id:'one',name:'My workflow',version:8,nodes:35,totalBytes:8765,candidateCount:3};
  for(const render of [renderComfyLibrary,renderComfyPools]){
    const html=render({rows:[row],usage});assert.match(html,/My workflow/);assert.doesNotMatch(html,/ST 账户保存|当前目录正文量|非磁盘总占用|8765|个版本|<span>v8<\/span>/);
    assert.match(html,/<details class="sd-comfy-library-management"\s*><summary>管理/);
  }
  const html=renderComfyLibrary({draft:{name:'My workflow',document,versions:[{revision:'r1',version:1,updatedAt:1}]}});
  assert.match(html,/<details class="sd-comfy-library-history"><summary>历史版本/);assert.doesNotMatch(html,/不代表远端执行验证|保存不切换当前配方|分类仅用于候选匹配/);
});

function libraryHost(kind){
  const actionKey=kind==='workflow'?'comfyAction':'poolAction',buttons={refresh:{dataset:{[actionKey]:'refresh'},addEventListener(_type,callback){this.click=callback;},closest:()=>null}};
  const host={isConnected:true,innerHTML:'',contains:()=>false,closest:()=>null,querySelector:()=>null,
    querySelectorAll:selector=>selector===`[data-${kind==='workflow'?'comfy':'pool'}-action]`?Object.values(buttons):[]};
  return {host,refresh:()=>buttons.refresh.click({preventDefault(){}})};
}
for(const [kind,create] of [['workflow',createComfyLibraryController],['pool',createComfyPoolController]]){
  test(`${kind} remount reuses verified recent rows, explicit refresh/expiry reread, failure can retry`,async()=>{
    let reads=0,time=0,fail=false;const store={view:async()=>{reads++;if(fail)throw Error('temporary failure');return {rows:[{id:'one',name:'One',nodes:1,version:1,totalBytes:1,candidateCount:1}],usage:null};},close(){}};
    const controller=create({resolveNamespace:async()=>namespace,store,now:()=>time}),a=libraryHost(kind),b=libraryHost(kind);
    try{
      controller.mount(a.host);await flush();assert.equal(reads,1);controller.detach();controller.mount(b.host);await flush();assert.equal(reads,1);assert.match(b.host.innerHTML,/One/);
      b.refresh();await flush();assert.equal(reads,2);time=30001;controller.detach();controller.mount(a.host);await flush();assert.equal(reads,3);
      fail=true;a.refresh();await flush();assert.equal(reads,4);assert.match(a.host.innerHTML,/temporary failure/);
      fail=false;controller.detach();controller.mount(b.host);await flush();assert.equal(reads,5);assert.doesNotMatch(b.host.innerHTML,/temporary failure/);
    }finally{controller.dispose();}
  });
  test(`${kind} cached lists still hide rows and retry safely after an account switch`,async()=>{
    let account=namespace,reads=0;const store={view:async value=>{reads++;return {rows:[{id:'one',name:value,nodes:1,version:1,totalBytes:1,candidateCount:1}],usage:null};},close(){}};
    const controller=create({resolveNamespace:async()=>account,store}),a=libraryHost(kind),b=libraryHost(kind);
    try{
      controller.mount(a.host);await flush();controller.detach();account='st-user:other';controller.mount(b.host);await flush();
      assert.doesNotMatch(b.host.innerHTML,/st-user:library-test/);assert.match(b.host.innerHTML,/账户已切换/);assert.equal(reads,1);
      b.refresh();await flush();assert.equal(reads,2);assert.match(b.host.innerHTML,/st-user:other/);
    }finally{controller.dispose();}
  });
}
