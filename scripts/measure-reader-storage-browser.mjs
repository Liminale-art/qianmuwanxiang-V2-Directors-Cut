// Synthetic, isolated desktop-browser baseline, not a phone or production-ST benchmark.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true});
const results=[],errors=[];let external=0;
try{
  for(const workload of [{textMiB:1,books:16},{textMiB:8,books:128},{textMiB:32,books:512}]){
    const context=await browser.newContext({viewport:{width:393,height:898}});
    try{
      await context.route('**/*',async route=>{
        const url=new URL(route.request().url());
        if(url.href==='https://qianmu.test/')return route.fulfill({contentType:'text/html',body:'<!doctype html>'});
        if(url.origin==='https://qianmu.test'&&['/qianmu-reader-package.js','/qianmu-blobstore.js','/qianmu-json-input.js'].includes(url.pathname))return route.fulfill({contentType:'application/javascript',body:await readFile(new URL('..'+url.pathname,import.meta.url))});
        external++;return route.abort();
      });
      const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto('https://qianmu.test/');
      results.push(await page.evaluate(async workload=>{
        const db=await import('/qianmu-blobstore.js'),pack=await import('/qianmu-reader-package.js');
        const text='x'.repeat(workload.textMiB*1048576/workload.books),state={books:[]};let saves=0;
        const file=new File([JSON.stringify({type:'qianmu-coread',version:5,books:Array.from({length:workload.books},(_,i)=>({meta:{id:'synthetic-'+i,title:'Synthetic '+i,progress:42,hasCover:false},fullText:text}))})],'synthetic-reader.json',{type:'application/json'});
        async function measure(action){
          let previous=performance.now(),maxTimerGapMs=0;
          const timer=setInterval(()=>{const now=performance.now();maxTimerGapMs=Math.max(maxTimerGapMs,now-previous);previous=now;},16);
          try{
            await new Promise(resolve=>setTimeout(resolve,32));const start=performance.now(),value=await action(),ms=performance.now()-start;
            await new Promise(resolve=>setTimeout(resolve,32));return {value,ms,maxTimerGapMs};
          }finally{clearInterval(timer);}
        }
        const read=await measure(()=>pack.readCoreadPackageFile(file));
        const write=await measure(()=>pack.applyCoreadPackageData(read.value,{blobStore:db.createReaderPackageWriter(),coread:()=>state,
          isPlainObject:value=>!!value&&typeof value==='object'&&!Array.isArray(value),base64ToBlob(){throw Error('text-only fixture');},onBookIndexed(){saves++;},warn(){throw Error('unexpected write failure');}}));
        const inventory=await measure(()=>db.listBookIds());
        const reader=db.createReaderPackageReader(),first=await reader.getBook('synthetic-0'),last=await reader.getBook('synthetic-'+(workload.books-1));
        if(write.value.ok!==workload.books||write.value.failed||inventory.value.length!==workload.books||state.books.length!==workload.books||saves!==workload.books
          ||first.fullText!==text||last.fullText!==text||first.meta.progress!==42||last.meta.progress!==42)throw Error('synthetic roundtrip incomplete');
        const timing=({ms,maxTimerGapMs})=>({ms:Math.round(ms*10)/10,maxTimerGapMs:Math.round(maxTimerGapMs*10)/10});
        return {...workload,fileBytes:file.size,read:timing(read),write:timing(write),inventory:timing(inventory),countsMatch:true,verifiedSamples:2};
      },workload));
    }finally{await context.close();}
  }
  assert.equal(external,0);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({browser:browser.version(),scope:'single-run desktop headless, 393px viewport; ASCII books only; first/last originals sampled; no ST save, phone, heap or server measurement',results,external,errors}));
}finally{await browser.close();}
