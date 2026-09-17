// Read-only source capture against isolated, genuine saved chats and recipe files.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {historicalSourceFixture} from '../tests/helpers/historical-source-fixture.mjs';
const {chromium}=createRequire(import.meta.url)(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const f=await historicalSourceFixture(),checks=[],errors=[],unexpected=[],requests=[];
const config=JSON.parse(await readFile(new URL('../release-files.json',import.meta.url),'utf8'));
const modules=new Map(await Promise.all(config.files.filter(file=>file.endsWith('.js')).map(async file=>['/'+file,await readFile(new URL('../'+file,import.meta.url),'utf8')])));
const allowed=['/api/plugins/qianmu-tts/chat-gallery/state','/api/plugins/qianmu-tts/chat-gallery/evidence','/api/plugins/qianmu-tts/chat-gallery/recipe/read'];
const server=http.createServer(async(req,res)=>{
  const controller=new AbortController();res.once('close',()=>{if(!res.writableEnded)controller.abort();});
  try{
    const route=new URL(req.url,'http://localhost').pathname;
    if(route==='/'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><html><body></body></html>');return;}
    if(route==='/favicon.ico'){res.writeHead(204);res.end();return;}
    if(modules.has(route)){res.writeHead(200,{'Content-Type':'application/javascript'});res.end(modules.get(route));return;}
    if(allowed.includes(route)){
      let body='';for await(const part of req){body+=part;if(body.length>4096)throw Error('oversized fixture selector');}requests.push({route,body:JSON.parse(body)});
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
    window.api=await import('/qianmu-historical-storyboard-source.js');window.account='st-user:alice';window.currentHost={chat:'WRONG_CHAT',config:'WRONG_MODEL',person:'WRONG_PERSON'};
    window.options={namespace:account,target,gallerySha256,account:async()=>account,guard:async()=>{}};
  },f.request());return page;
}
const check=(name,condition)=>{assert.ok(condition,name);checks.push(name);};
const archive=path.join(f.user,'.qianmu-recipes-v1'),archiveBytes=async()=>Promise.all((await readdir(archive)).sort().map(async name=>[name,await readFile(path.join(archive,name),'utf8')]));
try{
  const a=await device(),before=await readFile(f.file),oldFiles=await archiveBytes();
  check('module loading does not scan saved chats',requests.length===0);
  const result=await a.evaluate(async()=>{window.session=await api.captureHistoricalStoryboardSource(options);return session.source;});
  assert.deepEqual(result.saved,f.saved);checks.push('browser captures actual saved draft, album and original image records');
  check('both inline and archived recipes retain original workflow nodes and fields',result.recipes.length===2&&result.recipes[0].snapshot.prompt==='inline original'&&result.recipes[1].snapshot.prompt==='server original'&&result.recipes.every(row=>row.snapshot.payload.parameters.workflow.nodes.length===120));
  check('body evidence and header/file observations come from the selected saved chat',result.chatEvidence.chatKey===f.target.chatId&&result.chatEvidence.messages.length===f.messages.length&&result.observed.header.kind==='jsonl-header'&&result.observed.file.bytes>result.observed.header.bytes);
  check('returned browser source is deeply immutable',await a.evaluate(()=>Object.isFrozen(session.source)&&Object.isFrozen(session.source.recipes[1].snapshot.payload.parameters.workflow.nodes)));
  check('source capture never borrows or changes current host state',(await a.evaluate(()=>JSON.stringify(currentHost)))==='{"chat":"WRONG_CHAT","config":"WRONG_MODEL","person":"WRONG_PERSON"}');
  check('unchanged source can be revalidated before future file handoff',await a.evaluate(()=>session.verify()));
  const b=await device(),other=await b.evaluate(async()=>{window.session=await api.captureHistoricalStoryboardSource(options);return session.source;});assert.deepEqual(other,result);checks.push('second fresh device captures exactly the same source without IndexedDB');
  check('reading and revalidation do not modify chat or immutable recipe files',(await readFile(f.file)).equals(before)&&JSON.stringify(await archiveBytes())===JSON.stringify(oldFiles));
  const count=requests.length;
  const selected=await b.evaluate(async()=>{const s=await api.captureHistoricalStoryboardSource({...options,recordIds:['server']});const source=s.source;s.close();return source;});
  check('selected capture includes only chosen images and recipes but keeps saved character drafts',selected.saved.storyboardImages.length===1&&selected.selection.total===2&&selected.recipes[0].recordId==='server'&&Boolean(selected.saved.characterDrafts));
  check('unselected recipes and original images are never fetched',requests.slice(count).filter(row=>row.route.endsWith('/recipe/read')).every(row=>row.body.selection.recordId==='server')&&unexpected.length===0);
  f.saved.characterDrafts.items[0].future.note='edited later';await f.write();
  check('draft edit invalidates a captured source even when the gallery is unchanged',await a.evaluate(async()=>{try{await session.verify();return false;}catch(error){return error.message.includes('人物');}}));
  const staleCount=requests.length;
  check('a failed session cannot revive cached source verification',await a.evaluate(async()=>{try{await session.verify();return false;}catch{return true;}})&&requests.length===staleCount);
  await b.evaluate(async()=>{session.close();window.session=await api.captureHistoricalStoryboardSource(options);});
  f.messages.push({mes:'new floor'});await f.write();
  check('a later narrative edit invalidates the captured full-file evidence',await b.evaluate(async()=>{try{await session.verify();return false;}catch(error){return error.message.includes('正文');}}));
  check('account change prevents a new source read',await b.evaluate(async()=>{account='st-user:bob';try{await api.captureHistoricalStoryboardSource(options);return false;}catch{return true;}finally{account='st-user:alice';}}));
  check('old backend is a visible failure, not an empty or current-chat fallback',await b.evaluate(async()=>{try{await api.captureHistoricalStoryboardSource({...options,fetchImpl:async()=>new Response('old',{status:404})});return false;}catch(error){return error.message.includes('更新千幕配套后端');}}));
  f.rows.push({id:'local-only',createdAt:3,snapshotRef:'old-device-only',url:'/user/images/old.png'});await f.write();
  check('missing selected local-only recipe is never looked up in another device cache',await b.evaluate(async gallerySha256=>{try{await api.captureHistoricalStoryboardSource({...options,gallerySha256,recordIds:['local-only']});return false;}catch(error){return error.message.includes('旧设备引用');}},f.request().gallerySha256));
  check('whole-operation deadline covers an unresolved account guard',await b.evaluate(async()=>{let release;try{await api.captureHistoricalStoryboardSource({...options,timeoutMs:100,account:()=>new Promise(done=>release=done)});return false;}catch(error){release('st-user:alice');return error.message.includes('超时');}}));
  check('no uploaded recipes, preserve/write routes or local paths in request bodies',requests.every(row=>Object.keys(row.body).sort().join(',')===(row.route.endsWith('/recipe/read')?'expectedAccount,selection,target,version':'expectedAccount,gallerySha256,target,version')));
  check('no external, production, paid or image calls and no browser exceptions',unexpected.length===0&&errors.length===0);
  console.log(JSON.stringify({checks,errors,unexpected,isolatedDevices:contexts.length,realTemporaryChatFiles:true,realRecipeArchives:true,productionDataRead:false}));
}finally{for(const context of contexts)await context.close();await browser.close();await new Promise(done=>server.close(done));await f.close();}
