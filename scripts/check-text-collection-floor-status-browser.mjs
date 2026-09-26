// Local code and synthetic acknowledgements only; no ST account or remote service.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true});
const context=await browser.newContext(),page=await context.newPage(),errors=[],checks=[];let external=0;
const files=new Set(['qianmu-text-collection-floor.js','qianmu-text-collection-floor-status.js','qianmu-icon-renderer.js','qianmu-feature-runtime.js']);
page.on('pageerror',error=>errors.push(error.message));
await context.route('**/*',async route=>{
  const url=new URL(route.request().url()),file=url.pathname.slice(1);
  if(url.origin==='https://qianmu.test'&&route.request().method()==='GET'){
    if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><div id="chat"></div></body></html>'});
    if(file==='qianmu-text-collection-session.js')return route.fulfill({contentType:'text/javascript',body:'export async function createTextCollectionSession(){return window.fixture.deleteSession();}'});
    if(file==='qianmu-text-collection-floor-delete.js')return route.fulfill({contentType:'text/javascript',body:'export async function deleteTextCollectionFloor(options){return window.fixture.deleteFloor(options);}'});
    if(files.has(file))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../'+file,import.meta.url),'utf8')});
  }
  external++;await route.abort();
});
try{
  await page.goto('https://qianmu.test/');await page.addStyleTag({content:await readFile(new URL('../style.css',import.meta.url),'utf8')});
  await page.addStyleTag({content:'#chat { color: rgb(61, 84, 99); } #chat button { color: purple; background: red; border: 4px solid green; box-shadow: 1px 1px 2px black; }'});
  await page.evaluate(async()=>{
    const {createTextCollectionFloorTools,injectStoryboardMessageButtons}=await import('./qianmu-text-collection-floor.js');
    const {applyQianmuIcons}=await import('./qianmu-icon-renderer.js');
    const fixture=window.fixture={current:true,chatKey:'chat-a',namespace:'st-user:alice',reads:0,closed:0,records:[],mode:'ok',messages:[{mes:'正文 A'}, {mes:'正文 B'}, {mes:'系统',is_system:true}]};
    const chat=document.getElementById('chat');fixture.chat=chat;
    chat.innerHTML=fixture.messages.map((message,index)=>`<div class="mes" mesid="${index}"><div class="mes_text">${message.mes}</div><div class="mes_buttons"><button class="third-party">不改别人的按钮</button></div></div>`).join('');
    fixture.account='st-user:'+'a'.repeat(64);fixture.notices=[];
    const row=(floor,reply='swipe:0',account=fixture.account)=>({source:{account,chatId:fixture.chatKey,messageId:floor,replyId:reply},text:'PRIVATE'});fixture.row=row;
    fixture.records=[row(0,'swipe:2'),row(0,'swipe:4')];
    fixture.tools=createTextCollectionFloorTools({getContext:()=>({chat:fixture.messages}),getChatKey:()=>fixture.chatKey,names:()=>({}),resolveNamespace:async()=>fixture.namespace,isCurrent:()=>fixture.current,notify:(text,type)=>fixture.notices.push({text,type}),applyIcons:applyQianmuIcons,statusSessionFactory:async()=>{
      const expectedAccount=fixture.namespace==='st-user:alice'?fixture.account:'st-user:'+'b'.repeat(64);
      return {expectedAccount,guard:async()=>{},close:()=>fixture.closed++,sources:async()=>{fixture.reads++;const records=structuredClone(fixture.records);if(fixture.mode==='hold')await new Promise(resolve=>fixture.release=resolve);if(fixture.mode==='error')throw Error('offline');return {expectedAccount,items:records.map(record=>record.source)};}};
    }});
    fixture.tools.refresh(chat);fixture.tools.refresh(chat);
    injectStoryboardMessageButtons(chat,{floorOf:node=>Number(node.getAttribute('mesid')),getContext:()=>({chat:fixture.messages}),getState:()=>({}),planForMessage:()=>null,applyIcons:applyQianmuIcons});
    fixture.change=()=>document.dispatchEvent(new Event('qianmu-text-collections-changed'));
  });
  const button=floor=>page.locator(`.mes[mesid="${floor}"] [data-qm-collect-floor]`);
  await page.waitForFunction(()=>document.querySelector('[data-qm-collect-floor]')?.dataset.qmCollectionState==='saved');
  assert.equal(await page.locator('[data-qm-collect-floor]').count(),2);assert.equal(await page.evaluate(()=>fixture.reads),1);
  assert.equal(await button(0).locator('svg').count(),1);assert.equal(await button(1).getAttribute('data-qm-collection-state'),'empty');
  const painted=await button(0).evaluate(node=>({title:node.title,color:getComputedStyle(node).color,bg:getComputedStyle(node).backgroundColor,border:getComputedStyle(node).borderTopWidth,shadow:getComputedStyle(node).boxShadow,fill:getComputedStyle(node.querySelector('svg')).fill}));
  assert.equal(painted.color,'rgb(61, 84, 99)');assert.equal(painted.fill,painted.color);assert.equal(painted.bg,'rgba(0, 0, 0, 0)');assert.equal(painted.border,'0px');assert.equal(painted.shadow,'none');assert.match(painted.title,/其他回复版本/);
  assert.equal(await button(1).locator('svg').evaluate(node=>getComputedStyle(node).fill),'none');
  assert.equal(await page.locator('.third-party').first().evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(255, 0, 0)');
  checks.push('current chat is read once; source floor includes other swipe versions; local Lucide SVG follows ST text color without touching third-party controls');
  for(const color of ['rgb(240, 231, 209)','rgb(14, 23, 30)']){
    await page.locator('#chat').evaluate((node,color)=>node.style.color=color,color);
    assert.equal(await button(0).locator('svg').evaluate(node=>getComputedStyle(node).fill),color);
    assert.equal(await page.locator('.sd-storyboard-message-action').first().evaluate(node=>getComputedStyle(node).color),color);
  }
  checks.push('changing light/dark ST text color updates star and storyboard icons without a Qianmu theme override');
  await page.evaluate(()=>{fixture.records.shift();fixture.change();});await page.waitForFunction(()=>fixture.reads===2&&document.querySelector('[data-qm-collect-floor]')?.dataset.qmCollectionState==='saved');
  await page.evaluate(()=>{fixture.records=[];fixture.change();});await page.waitForFunction(()=>document.querySelector('[data-qm-collect-floor]')?.dataset.qmCollectionState==='empty');
  assert.equal(await button(0).locator('svg').evaluate(node=>getComputedStyle(node).fill),'none');
  checks.push('deleting one of two saved excerpts keeps the filled star; deleting the last returns it to outline after the confirmed read');
  await page.evaluate(()=>{fixture.mode='hold';fixture.records=[fixture.row(1)];fixture.change();});await page.waitForFunction(()=>typeof fixture.release==='function');
  assert.equal(await button(1).getAttribute('data-qm-collection-state'),'empty','known state stays steady during a same-account background refresh');
  await page.evaluate(()=>{fixture.mode='ok';fixture.release();});await page.waitForFunction(()=>document.querySelector('.mes[mesid="1"] [data-qm-collect-floor]')?.dataset.qmCollectionState==='saved');
  await page.evaluate(()=>{fixture.mode='error';fixture.change();});await page.waitForFunction(()=>document.querySelector('.mes[mesid="1"] [data-qm-collect-floor]')?.dataset.qmCollectionState==='unknown');
  const before=await page.evaluate(()=>fixture.reads);await page.evaluate(()=>{for(let i=0;i<100;i++)fixture.tools.refresh(fixture.chat);});await page.waitForTimeout(80);assert.equal(await page.evaluate(()=>fixture.reads),before);
  await page.evaluate(()=>{fixture.mode='ok';window.dispatchEvent(new Event('focus'));});await page.waitForFunction(()=>document.querySelector('.mes[mesid="1"] [data-qm-collect-floor]')?.dataset.qmCollectionState==='saved');
  checks.push('pending writes/events do not optimistically fill stars; read failure stays unknown, render storms do not reread, focus retries');
  await page.evaluate(()=>{
    fixture.release=null;
    fixture.knownFloor=false;
    fixture.deleteSession=()=>({namespace:fixture.namespace,expectedAccount:fixture.account,knownFloorState:async()=>fixture.knownFloor,close:()=>{}});
    fixture.deleteFloor=async({onProgress})=>{
      await new Promise(resolve=>fixture.deleteRelease=resolve);
      onProgress({total:1,confirmed:1});fixture.records=[];fixture.mode='hold';return {total:1,confirmed:1};
    };
  });
  const noticesBeforeDelete=await page.evaluate(()=>fixture.notices.length);
  await button(1).click();await page.waitForFunction(()=>typeof fixture.deleteRelease==='function');
  assert.equal(await button(1).isEnabled(),false,'the actual write must still be awaited');
  assert.equal(await page.evaluate(()=>fixture.notices.length),noticesBeforeDelete,'a pending write cannot announce success');
  await page.evaluate(()=>fixture.deleteRelease());await page.waitForFunction(()=>typeof fixture.release==='function');
  assert.equal(await button(1).isEnabled(),true,'a held post-write reconciliation must not block the star button');
  assert.equal(await button(1).getAttribute('data-qm-collection-state'),'empty');
  assert.equal(await page.evaluate(()=>fixture.notices.at(-1)?.type),'success');
  await page.evaluate(()=>{fixture.mode='ok';fixture.release();});
  checks.push('acknowledged full-floor deletion paints and releases the button before a held background recheck completes');
  for(const known of [null,true]){
    await page.evaluate(()=>{fixture.records=[fixture.row(1)];fixture.change();});
    await page.waitForFunction(()=>document.querySelector('.mes[mesid="1"] [data-qm-collect-floor]')?.dataset.qmCollectionState==='saved');
    await page.evaluate(known=>{
      fixture.release=null;fixture.knownFloor=known;
      fixture.deleteFloor=async({onProgress})=>{
        onProgress({total:1,confirmed:1});fixture.records=known===true?[fixture.row(1,'new-from-other-device')]:[];
        fixture.mode='hold';return {total:1,confirmed:1};
      };
    },known);
    await button(1).click();await page.waitForFunction(()=>typeof fixture.release==='function');
    assert.equal(await button(1).isEnabled(),true);
    assert.equal(await button(1).getAttribute('data-qm-collection-state'),known===true?'saved':'unknown');
    const notice=await page.evaluate(()=>fixture.notices.at(-1));
    assert.equal(/本层已无|已取消本层/.test(notice.text),false,'a receipt cannot claim an empty floor when remaining sources are unknown or present');
    if(known===true)assert.match(notice.text,/仍有其他收藏/);
    await page.evaluate(()=>{fixture.mode='ok';fixture.release();});
    await page.waitForFunction(known=>document.querySelector('.mes[mesid="1"] [data-qm-collect-floor]')?.dataset.qmCollectionState===(known===true?'saved':'empty'),known);
  }
  checks.push('a surviving concurrent collection keeps its star; unknown provenance never claims full-floor deletion, and neither waits for background I/O');
  await page.evaluate(()=>{fixture.namespace='st-user:bob';fixture.tools.refresh(fixture.chat);});await page.waitForFunction(()=>document.querySelector('.mes[mesid="1"] [data-qm-collect-floor]')?.dataset.qmCollectionState==='empty');
  checks.push('switching account cannot reuse another account source index even when the chat name is identical');
  await page.evaluate(()=>fixture.tools.dispose());const stopped=await page.evaluate(()=>fixture.reads);await page.evaluate(()=>{fixture.change();window.dispatchEvent(new Event('focus'));});await page.waitForTimeout(50);
  assert.equal(await page.evaluate(()=>fixture.reads),stopped);assert.equal(await page.locator('[data-qm-collect-floor]').count(),0);assert.equal(await page.locator('.sd-storyboard-message-action').count(),2);
  await page.evaluate(()=>fixture.tools.refresh(fixture.chat));await page.waitForFunction(()=>document.querySelector('[data-qm-collect-floor]')?.dataset.qmCollectionState==='empty');assert.equal(await page.locator('[data-qm-collect-floor]').count(),2);
  checks.push('cleanup detaches status listeners and only owned buttons; remount has one fresh index and no duplicate listeners');
  assert.equal(external,0);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({checks,count:checks.length,externalRequests:external,productionWrites:false,pageErrors:errors},null,2));
}finally{await context.close();await browser.close();}
