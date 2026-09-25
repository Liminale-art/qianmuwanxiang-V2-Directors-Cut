// Isolated Chromium module graph with synthetic per-response RTT. All JS comes
// from the local release list; every external request is blocked. No ST login,
// private data, data-store calls or generation is involved.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const rtt=Number(process.argv.find(arg=>arg.startsWith('--rtt-ms='))?.slice(9)||40);
assert.ok(Number.isFinite(rtt)&&rtt>=0&&rtt<=200);
const release=new Set(JSON.parse(await readFile(new URL('../release-files.json',import.meta.url),'utf8')).files),sources=new Map(),results=[];
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true});
try{
 for(const scenario of ['identity-via-admission','identity-direct','comfy-library-cold','vibe-foreground-only','vibe-during-idle']){
  const context=await browser.newContext(),requests=[],errors=[];let external=0;
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());if(url.origin!=='https://qianmu.test'){external++;return route.abort();}
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<main>isolated module cost</main>'});
   const file=url.pathname.slice(1);assert.ok(release.has(file)&&file.endsWith('.js'),'Only local shipped JS: '+file);
   const event={url:url.pathname+url.search,start:Date.now()};requests.push(event);
   if(!sources.has(file))sources.set(file,await readFile(new URL('../'+file,import.meta.url),'utf8'));
   await new Promise(resolve=>setTimeout(resolve,rtt));event.end=Date.now();
   return route.fulfill({contentType:'application/javascript',body:sources.get(file)});
  });
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto('https://qianmu.test');
  const result=await page.evaluate(async scenario=>{
   const start=performance.now();
   if(scenario.startsWith('identity')){
    const module=await import(scenario==='identity-direct'?'/qianmu-account-identity.js':'/qianmu-image-admission.js');
    const namespace=await module.resolveImageAccountNamespace({loadUser:async()=>({currentUser:{handle:'synthetic'}}),fetchImpl:()=>{throw Error('No account HTTP expected');}});
    return {elapsedMs:performance.now()-start,namespace};
   }
   if(scenario==='comfy-library-cold'){
    const module=await import('/qianmu-comfy-library-view.js?v=1.59.384');return {elapsedMs:performance.now()-start,exports:Object.keys(module).length};
   }
   const {loadLocalChunk}=await import('/qianmu-feature-runtime.js?v=1.59.384');
   let stop=()=>{},idleStarted=false;
   if(scenario==='vibe-during-idle'){
    const {scheduleQianmuIdlePreload,QIANMU_IDLE_CHUNKS}=await import('/qianmu-idle-preload.js');
    stop=scheduleQianmuIdlePreload({quietMs:10,loaders:QIANMU_IDLE_CHUNKS.map(url=>async()=>{idleStarted=true;return loadLocalChunk(url);})});
    while(!idleStarted)await new Promise(resolve=>setTimeout(resolve,5));
    // Explicit interaction suspends subsequent speculative work; imports
    // already underway remain owned by the browser's module map.
    document.dispatchEvent(new Event('pointerdown'));stop();
   }
   const clicked=performance.now(),module=await loadLocalChunk('./qianmu-vibe-library-view.js?v=1.59.384');
   return {elapsedMs:performance.now()-clicked,exports:Object.keys(module).length,idleStarted};
  },scenario);
  assert.equal(external,0);assert.deepEqual(errors,[]);
  const variants=new Map();for(const row of requests){const name=row.url.split('?')[0];if(!variants.has(name))variants.set(name,new Set());variants.get(name).add(row.url);}
  results.push({scenario,...result,requests:requests.length,duplicateModuleUrls:[...variants].filter(([,urls])=>urls.size>1).map(([name,urls])=>({name,urls:[...urls]})),waterfall:requests.map(row=>({...row,startMs:row.start-requests[0].start,endMs:row.end-requests[0].start,start:undefined,end:undefined})),external,errors});
  await context.close();
 }
 console.log(JSON.stringify({isolation:'local-release-modules-only',syntheticRttMs:rtt,results},null,2));
}finally{await browser.close();}
