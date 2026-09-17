// Disposable browser contexts and temporary saved chats only. No host account,
// real narratives, paid generation, cleanup action or automatic backup entry.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import http from 'node:http';
import {chatEvidenceFixture,sha} from '../tests/helpers/chat-evidence-fixture.mjs';
import {captureStoryboardChatEvidence} from '../qianmu-storyboard-chat-evidence.js';
const {chromium}=createRequire(import.meta.url)(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const f=await chatEvidenceFixture(),checks=[],errors=[],unexpected=[],requests=[];
const config=JSON.parse(await readFile(new URL('../release-files.json',import.meta.url),'utf8'));
const modules=new Map(await Promise.all(config.files.filter(file=>file.endsWith('.js')).map(async file=>['/'+file,await readFile(new URL('../'+file,import.meta.url),'utf8')])));
const server=http.createServer(async(req,res)=>{
  const controller=new AbortController();res.once('close',()=>{if(!res.writableEnded)controller.abort();});
  try{
    const path=new URL(req.url,'http://localhost').pathname;
    if(path==='/'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><html><body></body></html>');return;}
    if(path==='/favicon.ico'){res.writeHead(204);res.end();return;}
    if(modules.has(path)){res.writeHead(200,{'Content-Type':'application/javascript'});res.end(modules.get(path));return;}
    if(path==='/api/plugins/qianmu-tts/chat-gallery/evidence'){
      let body='';for await(const part of req){body+=part;if(body.length>4096)throw Error('oversized fixture selector');}requests.push(JSON.parse(body));
      const result=await f.fetch(path,{body,signal:controller.signal});if(!res.destroyed){res.writeHead(result.status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(await result.text());}return;
    }
    unexpected.push(path);res.writeHead(404);res.end();
  }catch(error){errors.push(error.message);res.writeHead(500);res.end();}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true}),contexts=[];
async function device(){
  const context=await browser.newContext();contexts.push(context);await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){unexpected.push(route.request().url());return route.abort();}return route.continue();});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(origin);
  await page.evaluate(async ({target,gallerySha256})=>{
    window.api=await import('/qianmu-chat-character-receipt-client.js');window.account='st-user:alice';window.currentChat=[{mes:'WRONG current browser narrative'}];
    window.target=target;window.gallerySha256=gallerySha256;
    window.options={namespace:account,target,guard:async()=>{if(account!=='st-user:alice')throw Error('account switched');}};
    window.client=api.createChatGalleryEvidenceClient(options);
  },f.request());return page;
}
const check=(name,condition)=>{assert.ok(condition,name);checks.push(name);};
try{
  const a=await device(),before=await readFile(f.file),wanted=await captureStoryboardChatEvidence(f.messages,f.target.chatId);
  check('opening client does not automatically scan historical bodies',requests.length===0);
  const result=await a.evaluate(()=>client.read(gallerySha256));assert.deepEqual(result.chatEvidence,wanted);checks.push('native browser client reads exact saved historical floors and digests');
  check('server response carries no plaintext narrative, recipes or hidden swipes',!/PRIVATE_|正文|USER 的选择|swipes|snapshot/.test(JSON.stringify(result)));
  check('file byte fingerprint belongs to the complete saved JSONL',result.source.bytes===before.length&&result.source.sha256===sha(before));
  check('browser current story is neither read as source nor modified',(await a.evaluate(()=>currentChat[0].mes))==='WRONG current browser narrative');
  check('source chat bytes are unchanged by reading',(await readFile(f.file)).equals(before));
  const b=await device();assert.deepEqual(await b.evaluate(()=>client.read(gallerySha256)),result);checks.push('fresh isolated device obtains the same source evidence without local cache');
  const worker=await a.evaluate(async messages=>{const {runStoryboardBundle}=await import('/qianmu-storyboard-bundle-runtime.js');return (await runStoryboardBundle('chat-evidence',null,{chatKey:target.chatId,messages,guard:async()=>{}})).chatEvidence;},f.messages);
  assert.deepEqual(worker,result.chatEvidence);checks.push('existing real QMB worker produces the exact same evidence format and digest');
  await f.write({body:[...f.messages,{mes:'new floor'}]});const next=await b.evaluate(()=>client.read(gallerySha256));
  check('body changes with unchanged gallery create a new source/evidence snapshot',next.source.sha256!==result.source.sha256&&next.chatEvidence.digest!==result.chatEvidence.digest&&next.chatEvidence.messages.length===3);
  await f.write({newline:'\r\n',bom:'\uFEFF'});const reformatted=await b.evaluate(()=>client.read(gallerySha256));
  check('BOM and CRLF keep narrative evidence stable but file identity changes',reformatted.chatEvidence.digest===result.chatEvidence.digest&&reformatted.source.sha256!==result.source.sha256);
  f.rows[0].tags=['changed'];await f.write();
  check('old gallery selector cannot accept new saved gallery evidence',await a.evaluate(async()=>{try{await client.read(gallerySha256);return false;}catch{return true;}}));
  f.rows[0].tags=['test'];await f.write();
  check('late account guard refuses a complete response',await b.evaluate(async()=>{const c=api.createChatGalleryEvidenceClient({...options,fetchImpl:async(...args)=>{const result=await fetch(...args);account='st-user:bob';return result;}});try{await c.read(gallerySha256);return false;}catch{return true;}finally{c.close();account='st-user:alice';}}));
  const count=requests.length;
  check('closed client sends no request and does not return cached source',await a.evaluate(async()=>{client.close();try{await client.read(gallerySha256);return false;}catch{return true;}})&&requests.length===count);
  check('old backend has an explicit upgrade error rather than an empty source',await b.evaluate(async()=>{const c=api.createChatGalleryEvidenceClient({...options,fetchImpl:async()=>new Response('old',{status:404})});try{await c.read(gallerySha256);return false;}catch(error){return error.message.includes('更新千幕配套后端');}finally{c.close();}}));
  check('pending headers expire without sending a late request',await b.evaluate(async()=>{let release,calls=0;const c=api.createChatGalleryEvidenceClient({...options,timeoutMs:100,headers:()=>new Promise(done=>release=done),fetchImpl:async()=>{calls++;return new Response('');}});let failed=false;try{await c.read(gallerySha256);}catch{failed=true;}release({});await new Promise(done=>setTimeout(done,10));c.close();return failed&&calls===0;}));
  check('HTTP selectors contain only account, file target and complete gallery hash',requests.every(body=>Object.keys(body).sort().join(',')==='expectedAccount,gallerySha256,target,version'));
  check('no external, paid or production routes and no browser exceptions',unexpected.length===0&&errors.length===0);
  console.log(JSON.stringify({checks,errors,unexpected,isolatedDevices:contexts.length,realTemporaryChatFiles:true,productionDataRead:false}));
}finally{for(const context of contexts)await context.close();await browser.close();await new Promise(done=>server.close(done));await f.close();}
