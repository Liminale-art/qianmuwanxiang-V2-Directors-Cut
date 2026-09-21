import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {galleryOriginalCapabilities,galleryOriginalPreserved,galleryOriginalErrorPayload,galleryOriginalReadRequest} from '../qianmu-gallery-original-contract.js';
import {createGalleryOriginalClient} from '../qianmu-gallery-original-client.js';
import {galleryOriginalHttpFixture as fixture,originalPng as png,originalHash as sha} from './helpers/gallery-original-http-fixture.mjs';

const failure=error=>/^gallery_original_/.test(error?.code);
const selected=f=>({target:f.input().target,selection:f.input().selection,url:'/user/images/example.png'});
function client(f,extra={}){return createGalleryOriginalClient({account:async()=>'st-user:alice',headers:()=>({'X-CSRF-Token':'fixture','Authorization':'must-not-forward','X-API-Key':'must-not-forward'}),fetchImpl:f.fetch,...extra});}

test('installed routes authenticate and capabilities do no filesystem writes or source reads',async t=>{
    const f=await fixture(t,{io:new Proxy(fs,{get:(object,key)=>typeof object[key]==='function'?()=>{throw Error('no I/O allowed');}:object[key]})});
    assert.equal((await f.request('capabilities',null,true)).status,401);assert.equal((await f.request('preserve',f.input(),true)).status,401);
    const caps=await f.request('capabilities'),body=galleryOriginalCapabilities(await caps.json());assert.equal(body.expectedAccount,f.expectedAccount);
    assert.equal(body.canPrune,false);assert.equal(body.selectorOnly,true);
    assert.equal(caps.headers.get('cache-control'),'no-store');assert.equal(caps.headers.get('x-content-type-options'),'nosniff');
    assert.equal(caps.headers.get('cross-origin-resource-policy'),'same-origin');
    await assert.rejects(fs.stat(path.join(f.req.user.directories.root,'.qianmu-originals-v1')),{code:'ENOENT'});
});

test('real HTTP preserve/read is exact binary, private, independent of later original/chat removal',async t=>{
    const f=await fixture(t),before=await fs.readFile(f.file),saved=await f.request('preserve',f.input());assert.equal(saved.status,200);
    const result=galleryOriginalPreserved(await saved.json());assert.equal(result.original.sha256,sha(png));assert.equal(result.canPrune,false);
    assert.deepEqual(await fs.readFile(f.file),before);assert.deepEqual(await fs.readFile(f.image),png);
    await fs.unlink(f.image);await fs.unlink(f.file);
    const read=await f.request('read',{version:1,expectedAccount:f.expectedAccount,reference:result.reference});assert.equal(read.status,200);
    assert.equal(read.headers.get('content-length'),String(png.length));assert.equal(read.headers.get('content-type'),'image/png');
    assert.equal(read.headers.get('x-qianmu-original-account'),f.expectedAccount);assert.equal(read.headers.get('x-qianmu-original-sha256'),sha(png));
    assert.deepEqual(Buffer.from(await read.arrayBuffer()),png);
});

test('HTTP never accepts uploaded bytes, arbitrary paths, outside accounts or unsaved changes',async t=>{
    const f=await fixture(t);for(const extra of [{url:'https://example.invalid/private.png'},{path:f.image},{bytes:[1,2]}]){
        const response=await f.request('preserve',{...f.input(),...extra});assert.equal(response.status,400);assert.doesNotMatch(await response.text(),/private\.png|[A-Z]:\\/);
    }
    assert.notEqual((await f.request('preserve',{...f.input(),expectedAccount:'st-user:'+'a'.repeat(64)})).status,200);
    f.rows[0].snapshot.prompt='unsaved';assert.notEqual((await f.request('preserve',f.input())).status,200);
    await assert.rejects(fs.stat(path.join(f.req.user.directories.root,'.qianmu-originals-v1')),{code:'ENOENT'});
});

test('contract rejects partial/foreign evidence and error serialization never exposes exception text',async t=>{
    const f=await fixture(t),value=await (await f.request('preserve',f.input())).json();
    for(const bad of [{...value,canPrune:true},{...value,reference:{...value.reference,sha256:'0'.repeat(64)}},{...value,proof:'record-readback-only'},
        {...value,original:{...value.original,bytes:1}},{...value,path:f.file}])assert.throws(()=>galleryOriginalPreserved(bad),failure);
    assert.throws(()=>galleryOriginalReadRequest({version:1,expectedAccount:f.expectedAccount,reference:value.reference,url:f.image}),failure);
    for(const error of [Error(f.file),{code:'gallery_original_store_path',status:409,message:'private '+f.file},{code:'ENOENT',path:f.file}]){
        const result=galleryOriginalErrorPayload(error);assert.doesNotMatch(JSON.stringify(result),/private|[A-Z]:\\/);assert.equal(result.body.canPrune,false);
    }
});

test('browser client uses real routes, checks hashes, and sends only selectors with ST CSRF',async t=>{
    const f=await fixture(t),s=client(f);t.after(()=>s.close());const result=await s.preserve(selected(f));
    const loaded=await s.read(result.reference);assert.deepEqual(Buffer.from(await loaded.blob.arrayBuffer()),png);assert.equal(loaded.originalVerified,true);
    assert.equal(loaded.canPrune,false);assert.deepEqual(f.calls.map(row=>row.url.split('/').at(-1)),['capabilities','preserve','capabilities','read']);
    for(const call of f.calls){assert.equal(call.credentials,'same-origin');assert.equal(call.redirect,'error');assert.equal(call.cache,'no-store');
        assert.equal(call.headers['X-CSRF-Token'],'fixture');assert.equal(call.headers.Authorization,undefined);assert.equal(call.headers['X-API-Key'],undefined);
        if(call.body)assert.doesNotMatch(call.body,/snapshot|private body|data:image|Bearer|example\.png/);
    }
});

test('client refuses mismatched binary headers, lengths, content and references without fallback',async t=>{
    const f=await fixture(t),result=await (await f.request('preserve',f.input())).json();
    for(const mode of ['account','hash','mime','length','short','extra','bytes','redirect','json']){
        let reads=0;const s=client(f,{fetchImpl:async(url,options)=>{
            if(!url.endsWith('/read'))return f.fetch(url,options);reads++;
            const headers={'content-type':'image/png','content-length':String(png.length),'x-qianmu-original-sha256':sha(png),'x-qianmu-original-account':f.expectedAccount};
            let body=png,status=200;
            if(mode==='account')headers['x-qianmu-original-account']='st-user:'+'a'.repeat(64);
            if(mode==='hash')headers['x-qianmu-original-sha256']='0'.repeat(64);
            if(mode==='mime')headers['content-type']='image/jpeg';if(mode==='length')delete headers['content-length'];
            if(mode==='short')body=png.subarray(0,-1);if(mode==='extra')body=Buffer.concat([png,png]);if(mode==='bytes')body=Buffer.alloc(png.length);
            if(mode==='redirect')status=302;if(mode==='json'){headers['content-type']='application/json';body='{}';}
            return new Response(body,{headers,status});
        }});await assert.rejects(s.read(result.reference));assert.equal(reads,1);s.close();
    }
});

test('old backend or wrong capability account prevents all writes, with no automatic retries',async t=>{
    const f=await fixture(t);for(const mode of ['old','account','oversize','truncated']){
        let calls=0;const s=client(f,{fetchImpl:async()=>{calls++;
            if(mode==='old')return new Response('old',{status:404});
            if(mode==='oversize')return new Response('x'.repeat(17000),{headers:{'content-type':'application/json'}});
            if(mode==='truncated')return new Response('{', {headers:{'content-type':'application/json'}});
            const caps=await (await f.request('capabilities')).json();caps.expectedAccount='st-user:'+'a'.repeat(64);return Response.json(caps);
        }});await assert.rejects(s.preserve(selected(f)));assert.equal(calls,1);s.close();
    }
});

test('client captures selectors before awaits and rejects wrong returned target/id/url',async t=>{
    const f=await fixture(t),raw=selected(f),s=client(f);t.after(()=>s.close());const task=s.preserve(raw);raw.target.chatId='mutated';assert.equal((await task).target.chatId,'chat');
    for(const mode of ['target','id','url']){
        const c=client(f,{fetchImpl:async(url,options)=>{const response=await f.fetch(url,options);if(!url.endsWith('/preserve'))return response;
            const body=await response.json();if(mode==='target')body.target.chatId='other';if(mode==='id')body.selection.recordId='other';if(mode==='url')body.original.url='/user/images/other.png';return Response.json(body);
        }});await assert.rejects(c.preserve(selected(f)),failure);c.close();
    }
});

test('account and guard changes during media response discard its data',async t=>{
    const f=await fixture(t),result=await (await f.request('preserve',f.input())).json();
    for(const mode of ['account','guard']){
        let current=true;const s=client(f,{account:async()=>mode==='account'&&!current?'st-user:bob':'st-user:alice',guard:async()=>mode!=='guard'||current,
            fetchImpl:async(url,options)=>{const response=await f.fetch(url,options);if(url.endsWith('/read'))current=false;return response;}});
        await assert.rejects(s.read(result.reference));s.close();
    }
});

test('client cancellation closes stalled body reads, rejects overlap and suppresses late fetch work',{timeout:5000},async t=>{
    const f=await fixture(t);let release,called=0;const gate=new Promise(resolve=>{release=resolve;}),s=client(f,{timeoutMs:100,fetchImpl:async()=>{called++;await gate;return new Response('late');}});
    t.after(()=>s.close());const task=s.preserve(selected(f));await assert.rejects(s.preserve(selected(f)),/正在读取/);await assert.rejects(task,/超时/);
    await assert.rejects(s.preserve(selected(f)),/正在读取/);release();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(called,1);
    let cancelled=0;const stalled=client(f,{timeoutMs:100,fetchImpl:async()=>new Response(new ReadableStream({cancel(){cancelled++;}}),{headers:{'content-type':'application/json'}})});
    await assert.rejects(stalled.preserve(selected(f)),/超时/);stalled.close();assert.equal(cancelled,1);
});

test('HTTP disconnect cancels pending filesystem work and never publishes a late response',{timeout:5000},async t=>{
    let release,entered;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
    const f=await fixture(t,{io:{...fs,open:async(file,...args)=>{if(String(file).endsWith('example.png')){entered();await gate;}return fs.open(file,...args);}}});
    const req=new EventEmitter();req.user=f.req.user;req.body=f.input();const res=new EventEmitter();let sent=0;
    Object.assign(res,{set(){return this;},status(){return this;},json(){sent++;},end(){sent++;}});
    const pending=f.routes.get('POST /chat-gallery/original/preserve')(req,res);await started;res.destroyed=true;res.emit('close');await pending;release();
    await new Promise(resolve=>setTimeout(resolve,20));assert.equal(sent,0);assert.equal(req.listenerCount('aborted'),0);assert.equal(res.listenerCount('close'),0);
});
