// Verification only: synthetic histories in a disposable browser context.
// Warm desktop measurements are not mobile, production ST or disk-capacity claims.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true});
const context=await browser.newContext({viewport:{width:393,height:898}}),errors=[];let external=0;
const allowed=new Set(['qianmu-prose-assistant-history.js','qianmu-prose-assistant-history-contract.js','qianmu-account-local-store.js','qianmu-chat-file-target.js']);
const timer=setTimeout(()=>{console.error('Assistant storage probe exceeded 60 seconds');void browser.close();},60000);
try{
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url()),file=url.pathname.slice(1);
  if(url.origin==='https://qianmu.test'&&route.request().method()==='GET'){
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8">'});
   if(allowed.has(file))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../'+file,import.meta.url),'utf8')});
  }
  external++;return route.abort();
 });
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto('https://qianmu.test/');
 const results=await page.evaluate(async()=>{
  const {createProseAssistantHistoryStore}=await import('./qianmu-prose-assistant-history.js');
  const account='st-user:'+'a'.repeat(64),store=createProseAssistantHistoryStore(),results=[];
  const key=n=>JSON.stringify(['qianmu-prose-assistant-v2',account,'char:A.png',{kind:'character',chatId:'probe-'+n,avatar:'A.png'},null]);
  const row={id:1,user:'测试问答',assistant:'场景记述😀'.repeat(4000),status:'complete',reference:{floor:0,replyId:'swipe:0',mode:'floor',range:{start:0,end:4}}};
  let seeded=0;
  try{
   for(const chats of [16,128,512]){
    while(seeded<chats){await store.write(account,key(seeded),0,[row],{now:1});seeded++;}
    const samples=[];
    for(let trial=0;trial<3;trial++){
     let last=performance.now(),maxTimerLagMs=0;
     const tick=setInterval(()=>{const now=performance.now();maxTimerLagMs=Math.max(maxTimerLagMs,now-last-5);last=now;},5);
     const start=performance.now();let summary,elapsedMs;
     try{summary=await store.usage(account);elapsedMs=performance.now()-start;
      maxTimerLagMs=Math.max(maxTimerLagMs,performance.now()-last-5);
     }finally{clearInterval(tick);}
     if(summary.chats!==chats||summary.count!==chats||summary.complete!==chats)throw Error('incomplete inventory');
     samples.push({elapsedMs:+elapsedMs.toFixed(2),maxTimerLagMs:+maxTimerLagMs.toFixed(2),bytes:summary.bytes});
    }
    for(const n of [0,chats-1]){const state=await store.read(account,key(n));if(state.revision!==1||JSON.stringify(state.rows)!==JSON.stringify([row]))throw Error('read-only inventory changed an original');}
    results.push({chats,turns:chats,replyCharactersPerChat:row.assistant.length,samples,verifiedOriginals:2});
   }
   return results;
  }finally{store.close();}
 });
 assert.equal(external,0);assert.deepEqual(errors,[]);assert.equal(results.length,3);
 console.log(JSON.stringify({browser:browser.version(),scope:'warm same-page desktop headless; three runs per size; Unicode synthetic content; viewport is not a phone; no ST/model/server/heap measurement',results,externalRequests:external,pageErrors:errors,productionDataRead:false,productionWrites:false}));
}finally{clearTimeout(timer);await context.close();await browser.close();}
