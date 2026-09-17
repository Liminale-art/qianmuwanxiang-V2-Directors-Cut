// Native browser fetch -> actual plugin routes -> isolated account files.
// Only loopback traffic and synthetic accounts/prose. This is not a deployed ST login test.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { init, exit } from '../server-plugin.js';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'qianmu-notes-http-test-'));
const dataRoot=path.join(root,'data');await fs.mkdir(dataRoot);
for(const account of ['alice','bob'])await fs.mkdir(path.join(dataRoot,account));
const routes=new Map(),router={};for(const method of ['get','post','delete','put'])router[method]=(route,handler)=>routes.set(`${method.toUpperCase()} ${route}`,handler);
await init(router,{dataRoot});
const checks=[],errors=[],requests=[],contexts=[];let external=0,missing=false,redirect=false;
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/'){res.setHeader('Content-Type','text/html');return res.end('<!doctype html><meta charset="utf-8"><title>Isolated notes HTTP</title>');}
    if(url.pathname==='/favicon.ico'){res.statusCode=204;return res.end();}
    if(/^\/qianmu-[a-z0-9-]+\.js$/.test(url.pathname)){res.setHeader('Content-Type','text/javascript');return res.end(await fs.readFile(new URL('..'+url.pathname,import.meta.url)));}
    if(!url.pathname.startsWith('/api/plugins/qianmu-tts/notes')){res.statusCode=404;return res.end();}
    const handle=/fixture-account=(alice|bob)(?:;|$)/.exec(req.headers.cookie||'')?.[1];
    assert.ok(handle,'synthetic authentication cookie required');assert.equal(req.headers.authorization,undefined);assert.equal(req.headers['x-api-key'],undefined);
    const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;assert.ok(bytes<=512*1024);chunks.push(chunk);}
    req.body=bytes?JSON.parse(Buffer.concat(chunks).toString('utf8')):undefined;
    if(req.method==='POST'){assert.equal(req.headers['x-csrf-token'],'synthetic-csrf');assert.equal(req.headers.origin,origin);}
    requests.push({method:req.method,path:url.pathname,handle});
    if(missing){res.statusCode=404;return res.end('old plugin fixture');}
    if(redirect){res.writeHead(307,{Location:'https://never-follow.invalid/notes'});return res.end();}
    req.user={profile:{handle},directories:{root:path.join(dataRoot,handle)}};
    res.set=(key,value)=>{if(typeof key==='object')for(const [name,item]of Object.entries(key))res.setHeader(name,item);else res.setHeader(key,value);return res;};
    res.status=code=>{res.statusCode=code;return res;};res.json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));return res;};
    const route=url.pathname.slice('/api/plugins/qianmu-tts'.length),handler=routes.get(`${req.method} ${route}`);assert.ok(handler);
    await handler(req,res);
  }catch(error){errors.push(error.message);if(!res.headersSent)res.statusCode=500;res.end('synthetic test failure');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true});
async function device(handle){
  const context=await browser.newContext();contexts.push(context);
  await context.addCookies([{name:'fixture-account',value:handle,url:origin,httpOnly:true}]);
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();external++;return route.abort();});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(origin);
  await page.evaluate(async handle=>{
    window.api=await import(new URL('/qianmu-notes.js',location.href).href);
    const {createNotesPanelSync}=await import(new URL('/qianmu-notes-panel-sync.js',location.href).href);
    window.fixture={handle,views:[],notices:[]};
    api.configureQianmuNotes({resolveNamespace:async()=>`st-user:${fixture.handle}`,headers:()=>({'X-CSRF-Token':'synthetic-csrf',Authorization:'must-not-forward','x-api-key':'must-not-forward'})});
    window.panel=createNotesPanelSync({getRoot:()=>null,refresh:async()=>{fixture.views=await api.listQianmuNotes();},confirm:async()=>false,notify:(...args)=>fixture.notices.push(args)});
    await api.listQianmuNotes();panel.mount();
  },handle);
  return {context,page};
}
const sync=page=>page.evaluate(()=>panel.sync());
const rows=page=>page.evaluate(()=>api.listQianmuNotes());
const saved=async page=>{try{await page.waitForFunction(()=>api.qianmuNotesState().state==='synced'&&api.qianmuNotesState().pending===0,{},{timeout:10000});}catch(error){throw new Error(JSON.stringify({state:await page.evaluate(()=>api.qianmuNotesState()),requests,errors,external}),{cause:error});}};
try{
  const a=await device('alice'),b=await device('alice'),other=await device('bob');
  assert.equal(requests.length,0);assert.equal((await a.page.evaluate(()=>api.getQianmuNotesStorage())).bytes,0);assert.equal(requests.length,0);
  checks.push('opening local inventory or summaries never uploads or reads the HTTP directory');
  await a.page.evaluate(async()=>{const base=document.createElement('base');base.href='https://never-follow.invalid/';document.head.append(base);await api.saveQianmuNote(api.createQianmuNote({body:'first automatic original\n第二行😀',pinned:false}));});
  await saved(a.page);assert.ok(requests.some(row=>row.method==='POST'&&row.handle==='alice'));
  await b.page.evaluate(()=>window.dispatchEvent(new Event('focus')));await b.page.waitForFunction(()=>fixture.views.length===1);
  assert.equal((await rows(b.page))[0].body,'first automatic original\n第二行😀');assert.equal((await rows(b.page))[0].pinned,false);
  checks.push('automatic save and focus pull transfer full unpinned Unicode prose over native same-origin HTTP despite a foreign document base');
  await sync(other.page);assert.deepEqual(await rows(other.page),[]);
  checks.push('a second authenticated ST account cannot list the first account originals');
  await b.page.evaluate(async()=>{const note=(await api.listQianmuNotes())[0];await api.saveQianmuNote({...note,body:'edited on second device',pinned:true});});
  await saved(b.page);await sync(a.page);assert.equal((await rows(a.page))[0].body,'edited on second device');assert.equal((await rows(a.page))[0].pinned,true);
  await a.page.evaluate(async()=>{const note=(await api.listQianmuNotes())[0];await api.saveQianmuNote({...note,pinned:false});});await saved(a.page);await sync(b.page);
  assert.equal((await rows(b.page)).length,1);assert.equal((await rows(b.page))[0].pinned,false);
  checks.push('pinning and unpinning cross HTTP without changing durable lifetime or losing the body');
  await a.context.setOffline(true);await a.page.evaluate(async()=>{const note=(await api.listQianmuNotes())[0];await api.saveQianmuNote({...note,body:'offline retained original'});});
  await sync(a.page);assert.equal((await rows(a.page))[0].body,'offline retained original');assert.ok((await a.page.evaluate(()=>api.qianmuNotesState())).pending>0);
  await a.context.setOffline(false);await sync(a.page);await sync(b.page);assert.equal((await rows(b.page))[0].body,'offline retained original');
  checks.push('failed native network writes retain a durable outbox and recover using the same operation after reconnect');
  await a.context.setOffline(true);await b.context.setOffline(true);
  for(const [device,body]of [[a,'concurrent device A'],[b,'concurrent device B']])await device.page.evaluate(async body=>{const note=(await api.listQianmuNotes())[0];await api.saveQianmuNote({...note,body});},body);
  await sync(a.page);await sync(b.page);await a.context.setOffline(false);await b.context.setOffline(false);
  await sync(a.page);await sync(b.page);await sync(a.page);
  assert.deepEqual((await rows(a.page)).map(row=>row.body).sort(),['concurrent device A','concurrent device B']);
  checks.push('actual server CAS conflicts preserve both concurrent device originals as separate notes');
  const deleted=(await rows(a.page))[0];await a.page.evaluate(note=>api.deleteQianmuNote(note.id,{namespace:note._notesAccount,localRevision:note.localRevision}),deleted);
  await saved(a.page);await sync(b.page);assert.equal((await rows(b.page)).length,1);assert.ok((await rows(b.page)).every(note=>note.id!==deleted.id));
  checks.push('automatic confirmed deletion propagates an authenticated server tombstone and does not resurrect');
  missing=true;await a.page.evaluate(async()=>{const note=(await api.listQianmuNotes())[0];await api.saveQianmuNote({...note,body:'retained while plugin is old'});});await sync(a.page);
  assert.equal((await a.page.evaluate(()=>api.qianmuNotesState())).state,'local-only');assert.equal((await rows(a.page))[0].body,'retained while plugin is old');
  missing=false;await sync(a.page);await sync(b.page);assert.equal((await rows(b.page))[0].body,'retained while plugin is old');
  checks.push('an old or missing backend shows local-only and keeps drafts until the updated route is available');
  redirect=true;await sync(a.page);assert.equal(external,0);assert.equal((await rows(a.page))[0].body,'retained while plugin is old');redirect=false;await sync(a.page);
  checks.push('native redirect refusal never forwards a note request to an external destination');
  const summary=await a.page.evaluate(()=>api.getQianmuNotesStorage());assert.equal(summary.count,1);assert.ok(summary.bytes>0);assert.doesNotMatch(JSON.stringify(summary),/retained while|"body"|"id"/);
  checks.push('account inventory exposes only local logical counts and bytes without note prose or another account');
  const files=await fs.readdir(path.join(dataRoot,'alice'));assert.ok(files.includes('.qianmu-notes-sync-v1.json'));
  for(const {page}of [a,b,other])await page.evaluate(async()=>{panel.dispose();await api.clearTemporaryQianmuNotes();});
  assert.deepEqual(errors,[]);assert.equal(external,0);
  console.log(JSON.stringify({passed:checks.length,checks,requests:requests.length,external,errors,scope:'native browser HTTP and actual plugin routes with temporary account files; synthetic authentication, no deployed ST or production data'}));
}finally{
  for(const context of contexts)await context.close();await browser.close();await exit();
  await new Promise(resolve=>server.close(resolve));
  const resolved=await fs.realpath(root);assert.equal(path.dirname(resolved),parent);assert.match(path.basename(resolved),/^qianmu-notes-http-test-/);await fs.rm(resolved,{recursive:true});
}
