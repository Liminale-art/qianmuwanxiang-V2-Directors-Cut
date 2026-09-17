// Real temporary saved files, two empty browser profiles. No production or external requests.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import http from 'node:http';
import {chatStateFixture} from '../tests/helpers/chat-state-fixture.mjs';
const {chromium}=createRequire(import.meta.url)(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const f=await chatStateFixture(),checks=[],errors=[],unexpected=[],requests=[];
const config=JSON.parse(await readFile(new URL('../release-files.json',import.meta.url),'utf8'));
const modules=new Map(await Promise.all(config.files.filter(file=>file.endsWith('.js')).map(async file=>['/'+file,await readFile(new URL('../'+file,import.meta.url),'utf8')])));
const server=http.createServer(async(req,res)=>{
  const controller=new AbortController();res.once('close',()=>{if(!res.writableEnded)controller.abort();});
  try{
    const route=new URL(req.url,'http://localhost').pathname;
    if(route==='/'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><html><body></body></html>');return;}
    if(route==='/favicon.ico'){res.writeHead(204);res.end();return;}
    if(modules.has(route)){res.writeHead(200,{'Content-Type':'application/javascript'});res.end(modules.get(route));return;}
    if(route==='/api/plugins/qianmu-tts/chat-gallery/state'){
      let body='';for await(const part of req){body+=part;if(body.length>4096)throw Error('oversized fixture selector');}requests.push(JSON.parse(body));
      const result=await f.fetch(route,{body,signal:controller.signal});if(!res.destroyed){res.writeHead(result.status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(await result.text());}return;
    }
    unexpected.push(route);res.writeHead(404);res.end();
  }catch(error){errors.push(error.message);res.writeHead(500);res.end();}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true}),contexts=[];
async function device(){
  const context=await browser.newContext();contexts.push(context);await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){unexpected.push(route.request().url());return route.abort();}return route.continue();});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(origin);
  await page.evaluate(async ({target,gallerySha256})=>{
    window.api=await import('/qianmu-chat-character-receipt-client.js');window.account='st-user:alice';window.currentState={source:'WRONG_CURRENT',character:'WRONG_PERSON'};
    window.target=target;window.gallerySha256=gallerySha256;
    window.options={namespace:account,target,guard:async()=>{if(account!=='st-user:alice')throw Error('account switched');}};
    window.client=api.createChatGalleryStateClient(options);
  },f.request());return page;
}
const check=(name,condition)=>{assert.ok(condition,name);checks.push(name);};
try{
  const a=await device(),before=await readFile(f.file);
  check('client creation does not read a saved chat automatically',requests.length===0);
  const result=await a.evaluate(()=>client.read(gallerySha256));assert.deepEqual(result.saved,f.saved);checks.push('browser receives exact saved records, albums and character drafts');
  check('unknown original fields, whitespace and zero values survive',result.saved.characterDrafts.items[0].future.note===' preserve exact fields '&&result.saved.storyboardCollections[0].future.zero===0);
  check('host global settings, unrelated plugin data and body text are excluded',!/WRONG_GLOBAL|PRIVATE_HISTORY|PRIVATE_VOICE|PRIVATE_KEY|PRIVATE_HIDDEN|USER 的选择/.test(JSON.stringify(result)));
  check('current browser state is neither used nor mutated',(await a.evaluate(()=>JSON.stringify(currentState)))==='{"source":"WRONG_CURRENT","character":"WRONG_PERSON"}');
  check('reading leaves saved source bytes unchanged',(await readFile(f.file)).equals(before));
  const b=await device();assert.deepEqual(await b.evaluate(()=>client.read(gallerySha256)),result);checks.push('second empty device reads the same originals without local cache');
  f.saved.characterDrafts.items[0].future.note='edited on source';await f.write();const next=await b.evaluate(()=>client.read(gallerySha256));
  check('draft edits with unchanged gallery update both state and header fingerprints',next.gallerySha256===result.gallerySha256&&next.sha256!==result.sha256&&next.source.sha256!==result.source.sha256);
  delete f.saved.characterDrafts;delete f.saved.storyboardCollections;await f.write();
  check('missing optional originals are not fabricated as empty resources',JSON.stringify(Object.keys((await b.evaluate(()=>client.read(gallerySha256))).saved))==='["storyboardImages"]');
  f.rows[0].tags=['changed'];await f.write();
  check('stale gallery selector refuses changed saved records',await a.evaluate(async()=>{try{await client.read(gallerySha256);return false;}catch{return true;}}));
  f.rows[0].tags=['test'];f.rows[0].apiKey='SECRET';await f.write();
  check('source credential fields are refused instead of silently stripped',await b.evaluate(async hash=>{try{await client.read(hash);return false;}catch(error){return error.message.includes('连接凭据');}},f.request().gallerySha256));
  delete f.rows[0].apiKey;await f.write();
  check('late account switch discards a complete response',await b.evaluate(async()=>{const c=api.createChatGalleryStateClient({...options,fetchImpl:async(...args)=>{const result=await fetch(...args);account='st-user:bob';return result;}});try{await c.read(gallerySha256);return false;}catch{return true;}finally{c.close();account='st-user:alice';}}));
  const count=requests.length;
  check('closed client cannot return stale local data or issue requests',await a.evaluate(async()=>{client.close();try{await client.read(gallerySha256);return false;}catch{return true;}})&&requests.length===count);
  check('old backend gives explicit update guidance',await b.evaluate(async()=>{const c=api.createChatGalleryStateClient({...options,fetchImpl:async()=>new Response('old',{status:404})});try{await c.read(gallerySha256);return false;}catch(error){return error.message.includes('更新千幕配套后端');}finally{c.close();}}));
  check('slow headers time out without a delayed read',await b.evaluate(async()=>{let release,calls=0;const c=api.createChatGalleryStateClient({...options,timeoutMs:100,headers:()=>new Promise(done=>release=done),fetchImpl:async()=>{calls++;return new Response('');}});let failed=false;try{await c.read(gallerySha256);}catch{failed=true;}release({});await new Promise(done=>setTimeout(done,10));c.close();return failed&&calls===0;}));
  check('wire input never uploads originals or local paths',requests.every(body=>Object.keys(body).sort().join(',')==='expectedAccount,gallerySha256,target,version'));
  check('no external, production or paid calls and no browser exceptions',unexpected.length===0&&errors.length===0);
  console.log(JSON.stringify({checks,errors,unexpected,isolatedDevices:contexts.length,realTemporaryChatFiles:true,productionDataRead:false}));
}finally{for(const context of contexts)await context.close();await browser.close();await new Promise(done=>server.close(done));await f.close();}
