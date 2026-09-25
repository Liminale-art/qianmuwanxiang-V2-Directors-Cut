// Real assistant panel/source/session/history runtime; delayed synthetic identity
// and in-memory store transport only. Every case gets an isolated browser context.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const allowed=new Set(['qianmu-icon-renderer.js','qianmu-current-chat-source.js','qianmu-chat-file-target.js','qianmu-model-response.js','qianmu-llm-output.js','qianmu-portable-connection.js','qianmu-account-local-store.js',...['panel','window','source','context','session','request','messages','preferences','history-contract','history','history-runtime'].map(name=>'qianmu-prose-assistant-'+name+'.js')]);
const assets=new Map(await Promise.all([...allowed].map(async name=>[name,await readFile(new URL('../'+name,import.meta.url),'utf8')])));
const css=(await Promise.all(['style.css','qianmu-prose-assistant.css'].map(name=>readFile(new URL('../'+name,import.meta.url),'utf8')))).join('\n');
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true}),checks=[],errors=[];let external=0;
const timer=setTimeout(()=>{console.error('Assistant loading checks exceeded 90 seconds');void browser.close();},90000);
async function setup(width,stage,{failHistory=false}={}){
  const context=await browser.newContext({viewport:{width,height:820}}),page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url()),name=url.pathname.slice(1);
    if(url.href==='https://qianmu.test/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><button id="entry">特助</button><main id="fixture"></main>'});
    if(url.origin==='https://qianmu.test'&&assets.has(name))return route.fulfill({contentType:'text/javascript',body:assets.get(name)});
    external++;return route.abort();
  });
  await page.goto('https://qianmu.test/');await page.addStyleTag({content:css});
  await page.evaluate(async({stage,failHistory})=>{
    const {openProseAssistantPanel}=await import('./qianmu-prose-assistant-panel.js');
    const {openProseAssistantHistory}=await import('./qianmu-prose-assistant-history-runtime.js');
    const host={chatId:'A',characterId:0,characters:[{avatar:'A.png',chat:'A'}],chatMetadata:{},chat:[{mes:'PRIVATE story text must not be read'}]};
    const f=window.fixture={live:true,namespace:'st-user:synthetic-a',identityCalls:0,contextChecks:0,historyCalls:0,sourceReads:0,requests:0,historyClosed:0,failedReads:failHistory?1:0,readySettled:false,geometryReads:[],geometryWrites:[]};
    const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('synthetic-a')));
    f.geometryKey='qianmu-assistant-window:st-user:'+Array.from(digest,byte=>byte.toString(16).padStart(2,'0')).join('');
    f.oldGeometry={width:280,height:240,x:10,y:10};
    const originalGet=Storage.prototype.getItem,originalSet=Storage.prototype.setItem;
    originalSet.call(localStorage,f.geometryKey,JSON.stringify(f.oldGeometry));
    Storage.prototype.getItem=function(key){f.geometryReads.push(String(key));return originalGet.call(this,key);};
    Storage.prototype.setItem=function(key,value){f.geometryWrites.push({key:String(key),value:JSON.parse(value)});return originalSet.call(this,key,value);};
    f.storedGeometry=()=>JSON.parse(originalGet.call(localStorage,f.geometryKey));
    f.moveWindow=(selector,dx,dy,{finish=true}={})=>{
      const target=document.querySelector(selector);
      for(const [type,x,y] of [['pointerdown',100,100],['pointermove',100+dx,100+dy],...(finish?[['pointerup',100+dx,100+dy]]:[])])
        target.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:7,isPrimary:true,button:0,clientX:x,clientY:y}));
    };
    f.endGesture=(selector,cancelled=false)=>document.querySelector(selector).dispatchEvent(new PointerEvent(cancelled?'pointercancel':'pointerup',{bubbles:true,pointerId:7,isPrimary:true,button:0,clientX:132,clientY:140}));
    const controller=f.controller=new AbortController();
    let release;const gate=new Promise(resolve=>{release=resolve;});f.release=()=>{f.released=true;release();};
    const source={getContext:()=>{f.contextChecks++;return host;},epoch:()=>0,isCurrent:()=>f.live,signal:controller.signal,readText:()=>{f.sourceReads++;throw Error('unexpected story read');},
      resolveNamespace:async()=>{f.identityCalls++;if(stage==='identity'&&!f.released)await gate;return f.namespace;}};
    const historyFactory=async options=>{
      f.historyCalls++;
      const store={read:async(_namespace,key)=>{
        if(stage==='history'&&!f.released)await gate;
        if(f.failedReads){f.failedReads--;throw Error('PRIVATE failed storage');}
        return {version:1,namespace:key,revision:1,updatedAt:1,rows:[{id:1,user:'已保存的问题',assistant:'已保存的回答',status:'complete',reference:null}]};
      },write:()=>{throw Error('unexpected write');},close(){}};
      const history=await openProseAssistantHistory({...options,store});
      return {...history,close(){f.historyClosed++;history.close();}};
    };
    const profile={id:'chosen',name:'本地模拟预设',apiUrl:'https://model.invalid/v1',apiKey:'synthetic-only',model:'fixture'};
    f.opening=openProseAssistantPanel({parent:document.getElementById('fixture'),source,profiles:[profile],selection:{mode:'profile',profileId:'chosen'},referenceFloors:0,isCurrent:()=>f.live,
      historyFactory,copy:async()=>{},confirm:async()=>true,getRequestHeaders:()=>({}),
      fetchImpl:async()=>{f.requests++;throw Error('unexpected model request');}
    }).then(panel=>{f.panel=panel;panel.ready.then(()=>{f.readySettled=true;});return panel;});
  },{stage,failHistory});
  await page.waitForFunction(()=>!!fixture.panel,{},{timeout:3000});
  const panel=page.getByRole('dialog',{name:'场外特助'}),question=page.getByLabel('向场外特助提问');
  assert.equal(await panel.isVisible(),true,width+'/'+stage+': shell visible before gate resolves');
  assert.equal(await question.isEnabled(),true);
  await question.fill('等待时写好的问题');await question.press('Control+Enter');
  assert.equal(await page.locator('[data-pa-action=send]').isDisabled(),true);
  assert.equal(await page.locator('[data-pa-action=close]').isEnabled(),true);
  const state=await page.evaluate(()=>({settled:fixture.readySettled,released:!!fixture.released,reads:fixture.sourceReads,requests:fixture.requests,turns:document.querySelectorAll('[data-pa-turn]').length}));
  assert.deepEqual(state,{settled:false,released:false,reads:0,requests:0,turns:0});
  if(stage==='identity')assert.equal(await page.evaluate(()=>fixture.historyCalls),0,'history cannot open before account identity');
  else await page.waitForFunction(()=>fixture.historyCalls===1);
  const box=await panel.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width+1&&box.width>=280&&box.height>=220,width+'/'+stage+': loading shell has a usable fitted size');
  const geometry=await page.evaluate(()=>({keys:fixture.geometryReads,writes:fixture.geometryWrites,own:fixture.geometryKey}));
  assert.ok(geometry.keys.every(key=>key===geometry.own),'never read an unbound or foreign geometry key');
  assert.equal(geometry.writes.length,0);
  if(stage==='identity')assert.equal(geometry.keys.length,0,'identity pending must not read localStorage');
  return {context,page,question,panel};
}
try{
  for(const width of [320,393,1280])for(const stage of ['identity','history']){
    for(const outcome of ['ready','close','abort','account']){
      const {context,page,question}=await setup(width,stage),key=[width,stage,outcome].join('/');
      try{
        if(outcome==='ready'){
          const before=await page.getByRole('dialog').boundingBox();
          await page.evaluate(()=>fixture.moveWindow('.qm-prose-assistant-dialog>header',14,24));
          const moved=await page.getByRole('dialog').boundingBox();
          assert.ok(moved.y>before.y+10,key+' shell drags before ready');
          await page.evaluate(()=>fixture.moveWindow('[data-pa-resize]',16,40));
          const resized=await page.getByRole('dialog').boundingBox();
          assert.ok(resized.height>moved.height+30,key+' shell resizes before ready');
          if(stage==='identity')assert.deepEqual(await page.evaluate(()=>({reads:fixture.geometryReads,writes:fixture.geometryWrites})),{reads:[],writes:[]},key+' pre-identity gestures stay only in memory');
          await page.evaluate(async()=>{fixture.release();await fixture.panel.ready;});
          assert.deepEqual(await page.getByRole('dialog').boundingBox(),resized,key+' ready never replaces manual geometry with older preferences');
          const saved=await page.evaluate(()=>({key:fixture.geometryKey,reads:fixture.geometryReads,writes:fixture.geometryWrites,value:fixture.storedGeometry()}));
          assert.ok(saved.writes.length>0&&saved.writes.every(row=>row.key===saved.key),key+' only confirmed account geometry is saved');
          assert.ok(saved.reads.every(key=>key===saved.key),key);
          assert.ok(Math.abs(saved.value.height-resized.height)<1&&Math.abs(saved.value.width-resized.width)<1,key);
          assert.equal(await page.locator('[data-pa-action=send]').isEnabled(),true,key);
          assert.equal(await question.inputValue(),'等待时写好的问题',key);
          assert.equal(await page.locator('[data-pa-turn]').count(),1,key);
          assert.equal(await page.locator('[data-pa-turn] pre').textContent(),'已保存的回答',key);
          assert.deepEqual(await page.evaluate(()=>({requests:fixture.requests,reads:fixture.sourceReads})),{requests:0,reads:0},key);
          await page.locator('[data-pa-action=close]').click();
          assert.equal(await page.getByRole('dialog').count(),0,key);assert.equal(await page.evaluate(()=>fixture.historyClosed),1,key);
        }else{
          if(outcome==='close')await page.locator('[data-pa-action=close]').click();
          else if(outcome==='abort')await page.evaluate(()=>fixture.controller.abort());
          else await page.evaluate(()=>{fixture.live=false;fixture.namespace='st-user:synthetic-b';document.getElementById('entry').append(document.createElement('span'));});
          await page.waitForFunction(()=>!document.querySelector('.qm-prose-assistant-dialog'));
          assert.equal(await page.evaluate(()=>!!fixture.released),false,key+' closing did not wait for blocked transport');
          await page.evaluate(async()=>{fixture.release();await fixture.panel.ready;});
          assert.equal(await page.getByRole('dialog').count(),0,key+' late completion cannot revive the old window');
          assert.deepEqual(await page.evaluate(()=>({requests:fixture.requests,reads:fixture.sourceReads,turns:document.querySelectorAll('[data-pa-turn]').length})),{requests:0,reads:0,turns:0},key);
          assert.equal(await page.evaluate(()=>fixture.geometryWrites.length),0,key+' stale preparation writes no geometry');
          if(stage==='identity')assert.deepEqual(await page.evaluate(()=>fixture.geometryReads),[],key+' stale identity never adopts geometry');
        }
        checks.push(key);
      }finally{await context.close();}
    }
  }
  for(const width of [320,393,1280]){
    const {context,page}=await setup(width,'identity');
    try{
      await page.evaluate(async()=>{fixture.release();await fixture.panel.ready;});
      assert.deepEqual(await page.getByRole('dialog').boundingBox(),{x:10,y:10,width:280,height:240},'untouched '+width+' adopts only confirmed own saved geometry');
      assert.deepEqual(await page.evaluate(()=>({reads:fixture.geometryReads,writes:fixture.geometryWrites})),{reads:[await page.evaluate(()=>fixture.geometryKey)],writes:[]});
      checks.push(width+'/identity/untouched preferences attach only after confirmation');
    }finally{await context.close();}
  }
  for(const cancelled of [true,false]){
    const {context,page}=await setup(393,'identity'),before=await page.getByRole('dialog').boundingBox();
    try{
      await page.evaluate(()=>fixture.moveWindow('[data-pa-resize]',16,40,{finish:false}));
      const active=await page.getByRole('dialog').boundingBox();
      assert.ok(active.height>before.height+30);
      await page.evaluate(async()=>{fixture.release();await fixture.panel.ready;});
      assert.deepEqual(await page.getByRole('dialog').boundingBox(),active,'ready does not move an in-flight resize');
      assert.equal(await page.evaluate(()=>fixture.geometryWrites.length),0,'an unfinished gesture must not save an intermediate size');
      await page.evaluate(cancelled=>fixture.endGesture('[data-pa-resize]',cancelled),cancelled);
      if(cancelled){
        assert.deepEqual(await page.getByRole('dialog').boundingBox(),before,'cancel restores pre-gesture visible size');
        assert.deepEqual(await page.evaluate(()=>({writes:fixture.geometryWrites,unchanged:JSON.stringify(fixture.storedGeometry())===JSON.stringify(fixture.oldGeometry)})),{writes:[],unchanged:true});
      }else{
        assert.deepEqual(await page.getByRole('dialog').boundingBox(),active);
        const saved=await page.evaluate(()=>({writes:fixture.geometryWrites,key:fixture.geometryKey}));
        assert.equal(saved.writes.length,1);assert.equal(saved.writes[0].key,saved.key);assert.ok(Math.abs(saved.writes[0].value.height-active.height)<1);
      }
      checks.push('393/identity/in-flight resize across ready '+(cancelled?'cancels without storage write':'persists only on pointerup'));
    }finally{await context.close();}
  }
  const {context,page,question}=await setup(393,'history',{failHistory:true});
  try{
    await page.evaluate(async()=>{fixture.release();await fixture.panel.ready;});
    assert.equal(await page.locator('[data-pa-action=retry-history]').isVisible(),true);
    assert.equal(await page.locator('[data-pa-action=send]').isDisabled(),true);
    assert.equal(await question.inputValue(),'等待时写好的问题');
    assert.doesNotMatch(await page.locator('[data-pa-history]').textContent(),/PRIVATE/);
    await page.locator('[data-pa-action=retry-history]').click();
    await page.waitForFunction(()=>!document.querySelector('[data-pa-action=send]').disabled);
    assert.equal(await question.inputValue(),'等待时写好的问题');
    assert.equal(await page.locator('[data-pa-turn]').count(),1);
    assert.deepEqual(await page.evaluate(()=>({historyCalls:fixture.historyCalls,requests:fixture.requests,reads:fixture.sourceReads})),{historyCalls:2,requests:0,reads:0});
    checks.push('393/history/read failure retains typed question; explicit retry enables send only after real history validation');
  }finally{await context.close();}
  const {context:pressureContext,page:pressurePage}=await setup(393,'history');
  try{
    await pressurePage.evaluate(async()=>{fixture.release();await fixture.panel.ready;});
    const pressure=await pressurePage.evaluate(async()=>{
      const before=fixture.contextChecks;
      for(let index=0;index<48;index++){
        document.getElementById('entry').append(document.createElement('span'));
        await new Promise(resolve=>setTimeout(resolve,8));
      }
      await new Promise(resolve=>setTimeout(resolve,100));
      return {checks:fixture.contextChecks-before,dialogs:document.querySelectorAll('.qm-prose-assistant-dialog').length};
    });
    assert.equal(pressure.dialogs,1);
    assert.ok(pressure.checks>=1&&pressure.checks<=12,'unrelated DOM updates should share bounded lifetime checks');
    console.log(JSON.stringify({assistantObserverPressure:{updates:48,...pressure}}));
    checks.push('393/history/48 separately scheduled unrelated DOM updates coalesced');
  }finally{await pressureContext.close();}
  const {context:accountContext,page:accountPage}=await setup(393,'history');
  try{
    await accountPage.evaluate(async()=>{fixture.release();await fixture.panel.ready;});
    await accountPage.evaluate(()=>{document.getElementById('entry').append(document.createElement('span'));fixture.live=false;fixture.namespace='st-user:synthetic-b';});
    await accountPage.waitForFunction(()=>!document.querySelector('.qm-prose-assistant-dialog'),null,{timeout:2000});
    assert.deepEqual(await accountPage.evaluate(()=>({closed:fixture.historyClosed,requests:fixture.requests,reads:fixture.sourceReads,writes:fixture.geometryWrites.length})),{closed:1,requests:0,reads:0,writes:0});
    checks.push('393/history/late account switch closes without sending or writing');
  }finally{await accountContext.close();}
  const {context:sendContext,page:sendPage}=await setup(393,'history');
  try{
    await sendPage.evaluate(async()=>{fixture.release();await fixture.panel.ready;});
    const refused=await sendPage.evaluate(()=>{
      fixture.live=false;fixture.namespace='st-user:synthetic-b';
      document.querySelector('[data-pa-action="send"]').click();
      return {closed:fixture.historyClosed,requests:fixture.requests,reads:fixture.sourceReads,writes:fixture.geometryWrites.length};
    });
    assert.deepEqual(refused,{closed:1,requests:0,reads:0,writes:0});
    checks.push('393/history/send action rechecks account immediately before passive observer');
  }finally{await sendContext.close();}
  const {context:detachContext,page:detachPage}=await setup(393,'history');
  try{
    await detachPage.evaluate(async()=>{fixture.release();await fixture.panel.ready;});
    const detached=await detachPage.evaluate(async()=>{
      document.getElementById('entry').append(document.createElement('span'));
      await Promise.resolve();
      document.getElementById('fixture').remove();
      await new Promise(resolve=>setTimeout(resolve,0));
      return {closed:fixture.historyClosed,connected:fixture.panel.element.isConnected,requests:fixture.requests,reads:fixture.sourceReads};
    });
    assert.deepEqual(detached,{closed:1,connected:false,requests:0,reads:0});
    checks.push('393/history/parent removal disposes in observer microtask even with check pending');
  }finally{await detachContext.close();}
  const {context:closeContext,page:closePage}=await setup(393,'history');
  try{
    await closePage.evaluate(async()=>{fixture.release();await fixture.panel.ready;});
    const afterClose=await closePage.evaluate(async()=>{
      document.getElementById('entry').append(document.createElement('span'));
      await Promise.resolve();
      document.querySelector('[data-pa-action="close"]').click();
      await fixture.panel.finished;
      const checks=fixture.contextChecks;
      await new Promise(resolve=>setTimeout(resolve,100));
      return {stable:fixture.contextChecks===checks,closed:fixture.historyClosed,requests:fixture.requests,reads:fixture.sourceReads};
    });
    assert.deepEqual(afterClose,{stable:true,closed:1,requests:0,reads:0});
    checks.push('393/history/explicit close cancels pending lifetime timer');
  }finally{await closeContext.close();}
  assert.deepEqual(errors,[]);assert.equal(external,0);console.log(JSON.stringify({ok:true,passed:checks.length,checks,external,pageErrors:errors,scope:'real assistant code, synthetic identity/storage transports, no production ST or model API'},null,2));
}finally{clearTimeout(timer);await browser.close();}
