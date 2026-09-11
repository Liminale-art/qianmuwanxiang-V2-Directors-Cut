import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true});
const context=await browser.newContext();let external=0;const requests=[];
try{
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());if(url.origin!=='https://qianmu.test'){external++;return route.abort();}
    if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<meta name="viewport" content="width=device-width,initial-scale=1"><div>isolated module recovery</div>'});
    if(['/qianmu-reader.js','/builtin-theaters.js'].includes(url.pathname)){
      requests.push(url.pathname+url.search);
      if(!url.searchParams.has('qm_retry'))return route.fulfill({status:503,contentType:'text/plain',body:'temporary unavailable'});
    }
    if(!/^\/(qianmu-[a-z-]+|builtin-theaters)\.js$/.test(url.pathname))return route.abort();
    return route.fulfill({contentType:'application/javascript',body:await readFile(new URL('..'+url.pathname,import.meta.url),'utf8')});
  });
  const page=await context.newPage();await page.goto('https://qianmu.test');
  const value=await page.evaluate(async()=>{
    const {loadLocalChunk}=await import('/qianmu-feature-runtime.js');
    const [reader,again,theater]=await Promise.all([loadLocalChunk('./qianmu-reader.js?v=qa'),loadLocalChunk('./qianmu-reader.js?v=qa'),loadLocalChunk('./builtin-theaters.js?v=qa')]);
    return {same:reader===again&&reader===await loadLocalChunk('./qianmu-reader.js?v=qa'),reader:Object.keys(reader).length,theaters:theater.BUILTIN_THEATERS.length};
  });
  assert.ok(value.same&&value.reader>0&&value.theaters>0);assert.equal(requests.length,4);assert.equal(requests.filter(url=>url.includes('qm_retry=1')).length,2);assert.equal(external,0);
  console.log(JSON.stringify({http503Recovery:true,singleFlight:true,successReused:true,requests,external}));
}finally{await context.close();await browser.close();}
