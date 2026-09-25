import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const shipped=new Set(JSON.parse(await readFile(new URL('../release-files.json',import.meta.url),'utf8')).files);
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
    if(!shipped.has(url.pathname.slice(1))||!url.pathname.endsWith('.js'))throw Error('Unexpected isolated import: '+url.pathname);
    return route.fulfill({contentType:'application/javascript',body:await readFile(new URL('..'+url.pathname,import.meta.url),'utf8')});
  });
  const page=await context.newPage(),pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));await page.goto('https://qianmu.test');
  const value=await page.evaluate(async()=>{
    const {loadLocalChunk}=await import('/qianmu-feature-runtime.js');
    const [reader,again,theater]=await Promise.all([loadLocalChunk('./qianmu-reader.js?v=qa'),loadLocalChunk('./qianmu-reader.js?v=qa'),loadLocalChunk('./builtin-theaters.js?v=qa')]);
    const names=['qianmu-storage-gallery-check.js','qianmu-gallery-recipe-review-view.js','qianmu-gallery-local-recipe-current.js',
      'qianmu-storyboard-export-scope-view.js','qianmu-gallery-archive-view.js','qianmu-gallery-location-view.js',
      'qianmu-gallery-directory-view.js','qianmu-historical-gallery-consumer.js'];
    const gallery=await Promise.all(names.map(async name=>{const url='./'+name+'?v=1.59.380',first=await loadLocalChunk(url);
      return {name,exports:Object.keys(first).length,reused:first===await loadLocalChunk(url)};}));
    return {same:reader===again&&reader===await loadLocalChunk('./qianmu-reader.js?v=qa'),reader:Object.keys(reader).length,theaters:theater.BUILTIN_THEATERS.length,gallery};
  });
  assert.ok(value.same&&value.reader>0&&value.theaters>0);assert.equal(requests.length,4);assert.equal(requests.filter(url=>url.includes('qm_retry=1')).length,2);assert.equal(external,0);
  assert.ok(value.gallery.every(row=>row.exports>0&&row.reused));assert.deepEqual(pageErrors,[]);
  console.log(JSON.stringify({http503Recovery:true,singleFlight:true,successReused:true,gallery:value.gallery,requests,external,pageErrors}));
}finally{await context.close();await browser.close();}
