// Actual detachable-entry controller and installed CSS; synthetic DOM only.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true}),context=await browser.newContext(),page=await context.newPage();
let external=0;const errors=[];page.on('pageerror',error=>errors.push(error.message));
await context.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin==='https://qianmu.test'&&url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><button id="tile" style="position:fixed;left:60px;top:120px;width:48px;height:56px">助手</button>'});if(url.origin==='https://qianmu.test'&&url.pathname==='/qianmu-prose-hive.js')return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../qianmu-prose-hive.js',import.meta.url),'utf8')});external++;await route.abort();});
try{
 await page.setViewportSize({width:393,height:760});await page.goto('https://qianmu.test/');await page.addStyleTag({content:await readFile(new URL('../style.css',import.meta.url),'utf8')});
 await page.evaluate(async()=>{
  const {createProseHive}=await import('./qianmu-prose-hive.js');window.fixture={height:64,opened:0,busy:false,closedWheel:0};const f=window.fixture;
  window.hive=createProseHive({open:()=>{f.opened++;},geometry:()=>({height:f.height,width:f.height*.866}),clamp:p=>({x:Math.max(8,Math.min(innerWidth-f.height*.866-8,Number(p.x)||0)),y:Math.max(8,Math.min(innerHeight-f.height-8,Number(p.y)||0))}),palette:()=>({darkFill:'#333',darkIcon:'#fff',lightFill:'#eee',lightIcon:'#222',edges:['#93bba3']}),theme:()=> 'dark',outline:'',canDock:element=>!f.busy&&element.getBoundingClientRect().left<=16,closeWheel:()=>{f.closedWheel++;}});
  hive.bind(document.querySelector('#tile'),{id:'assistant'},{itemSize:48});
 });
 assert.equal(await page.locator('#tile').evaluate(element=>getComputedStyle(element).touchAction),'none');
 await page.mouse.move(84,148);await page.mouse.down();await page.mouse.move(210,300,{steps:8});await page.mouse.up();
 assert.equal(await page.evaluate(()=>hive.detached),true);assert.equal(await page.evaluate(()=>fixture.opened),0);
 let entry=page.locator('.qm-prose-hive-layer button'),box=await entry.boundingBox();assert.ok(Math.abs(box.height-64)<1);assert.ok(Math.abs(box.width-64*.866)<1);
 await entry.click();assert.equal(await page.evaluate(()=>fixture.opened),1);
 await page.evaluate(()=>{fixture.height=40;hive.render();});box=await entry.boundingBox();assert.ok(Math.abs(box.height-40)<1);
 await page.setViewportSize({width:240,height:320});await page.waitForFunction(()=>{const rect=document.querySelector('.qm-prose-hive-layer button')?.getBoundingClientRect();return rect&&rect.bottom<=320&&rect.right<=240;});box=await entry.boundingBox();assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=240&&box.y+box.height<=320);
 await page.evaluate(()=>fixture.busy=true);box=await entry.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(8,100,{steps:8});await page.mouse.up();assert.equal(await page.evaluate(()=>hive.detached),true);
 await page.evaluate(()=>fixture.busy=false);box=await entry.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(0,150,{steps:8});await page.mouse.up();assert.equal(await page.evaluate(()=>hive.detached),false);assert.equal(await entry.count(),0);
 await page.evaluate(()=>hive.dispose());assert.equal(external,0);assert.deepEqual(errors,[]);console.log(JSON.stringify({checks:8,productionWrites:false,externalRequests:external,pageErrors:errors}));
}finally{await browser.close();}
