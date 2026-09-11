// Isolated native IndexedDB, synthetic records only; production ST is never contacted.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const sources=new Map(await Promise.all(['qianmu-blobstore.js','qianmu-plan-archive-write.js'].map(async file=>['https://qianmu.test/'+file,await readFile(new URL('../'+file,import.meta.url),'utf8')])));
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true}),context=await browser.newContext();let external=0;const errors=[];
await context.route('**/*',route=>{const url=route.request().url();return url==='https://qianmu.test/'?route.fulfill({contentType:'text/html',body:'<!doctype html>'}):sources.has(url)?route.fulfill({contentType:'application/javascript',body:sources.get(url)}):(external++,route.abort());});
try {
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto('https://qianmu.test/');
  const checks=await page.evaluate(async()=>{
    const api=await import('/qianmu-blobstore.js'),checks=[];
    const check=(name,ok)=>{if(!ok)throw Error(name);checks.push(name);};
    const make=(key,prompt)=>({key,chatKey:'fixture',planId:'same',updatedAt:1,plan:{shots:[{prompt}]}});
    const put=rows=>api.putStoryboardPlanArchives(rows,{preserveExisting:true});
    const old=make('fixture-key','old'),fresh=make('fixture-key','new');
    await api.putStoryboardPlanArchives([old]);
    const added=await put([fresh]),key=added.stored[0];
    check('different content receives an independent key',key!=='fixture-key');
    const rows=await api.getStoryboardPlanArchives(['fixture-key',key]);
    check('old payload preserved and new payload readable',rows[0].plan.shots[0].prompt==='old'&&rows[1].plan.shots[0].prompt==='new'&&rows[1].key===key);
    check('identical retries reuse the same variant',(await put([fresh])).stored[0]===key);
    const batch=await put([fresh,fresh,make('fixture-key','third')]);
    check('duplicate batch inputs are idempotent and ordered',batch.stored[0]===key&&batch.stored[1]===key&&batch.stored[2]!==key);
    const parallel=await Promise.all([put([make('race','A')]),put([make('race','B')])]);
    check('concurrent writers never overwrite one another',parallel[0].stored[0]!==parallel[1].stored[0]&&(await api.getStoryboardPlanArchives(parallel.flatMap(r=>r.stored))).length===2);
    const original=IDBObjectStore.prototype.add;
    try {
      IDBObjectStore.prototype.add=function(value,...args){if(this.name==='storyboard_plan_archives'&&value.key==='abort-two')throw Error('fixture write failure');return original.call(this,value,...args);};
      let rejected=false;try{await put([make('abort-one','one'),make('abort-two','two')]);}catch{rejected=true;}
      check('failure aborts the whole batch without partial new records',rejected&&(await api.getStoryboardPlanArchives(['abort-one','abort-two'])).length===0);
    } finally { IDBObjectStore.prototype.add=original; }
    check('failure does not remove existing originals',(await api.getStoryboardPlanArchives(['fixture-key']))[0].plan.shots[0].prompt==='old');
    check('writer does not mutate caller records',fresh.key==='fixture-key'&&fresh.plan.shots[0].prompt==='new');
    return checks;
  });
  assert.equal(external,0);assert.deepEqual(errors,[]);console.log(JSON.stringify({nativeIndexedDB:true,checks,external,errors}));
} finally {await context.close();await browser.close();}
