import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createGalleryOriginalSource} from '../qianmu-gallery-original-source.js';
import {createGalleryOriginalService} from '../qianmu-gallery-original-service.js';
import {createGalleryOriginalClient} from '../qianmu-gallery-original-client.js';
import {galleryOriginalBatchRequest,galleryOriginalBatchPreserved} from '../qianmu-gallery-original-contract.js';
import {createChatGalleryHeaderCapture} from '../qianmu-chat-gallery-header.js';
import {chatGalleryDigest} from '../qianmu-chat-gallery-digest.js';
import {galleryOriginalHttpFixture as httpFixture,originalPng as png} from './helpers/gallery-original-http-fixture.mjs';

const failure=error=>/^(?:gallery_original_|chat_character_receipt_)/.test(error?.code);
async function fixture(t,{io=fs,count=8,timeoutMs}={}){
    const f=await httpFixture(t,{io,timeoutMs});f.rows.splice(0,f.rows.length,...Array.from({length:count},(_,index)=>({id:'frame-'+index,createdAt:index,
        url:'/user/images/frame-'+index+'.png',unknown:{preserve:['',0,false]},snapshot:{source:'novel',prompt:'private',negative:'',profile:{},payload:{}}})));
    for(const row of f.rows)await fs.writeFile(path.join(f.images,path.basename(row.url)),png);await f.save();
    const source=createGalleryOriginalSource({dataRoot:f.root,io,timeoutMs}),service=createGalleryOriginalService({dataRoot:f.root,io,timeoutMs});
    t.after(()=>source.close());t.after(()=>service.close());
    const input=()=>({version:1,expectedAccount:f.expectedAccount,target:f.input().target,gallerySha256:chatGalleryDigest(f.rows).sha256,
        selections:f.rows.map(({id:recordId,createdAt})=>({recordId,createdAt}))});
    return {...f,source,service,batchInput:input,preserve:()=>service.preserveBatch(f.req,input()),
        batchClientInput:()=>({target:input().target,gallerySha256:input().gallerySha256,records:f.rows.map(row=>({recordId:row.id,createdAt:row.createdAt,url:row.url}))})};
}

test('eight originals share exactly two complete chat header reads and one image read each',async t=>{
    let headers=0,images=0;const f=await fixture(t,{io:{...fs,open:(file,...args)=>{if(String(file).endsWith('.jsonl'))headers++;if(String(file).endsWith('.png'))images++;return fs.open(file,...args);}}});
    const before=await fs.readFile(f.file),result=galleryOriginalBatchPreserved(await f.preserve());
    assert.equal(result.records.length,8);assert.equal(headers,2);assert.equal(images,8);assert.equal(result.canPrune,false);
    assert.deepEqual(result.records.map(row=>row.selection.recordId),f.rows.map(row=>row.id));assert.equal(new Set(result.records.map(row=>row.reference.id)).size,1,'equal content deduplicates within a batch');
    assert.deepEqual(await fs.readFile(f.file),before);
    for(const row of result.records){const read=await f.service.read(f.req,{version:1,expectedAccount:f.expectedAccount,reference:row.reference});assert.deepEqual(read.bytes,png);}
});

test('batch selectors enforce bounds, uniqueness and exact account before reading or writing images',async t=>{
    let images=0;const f=await fixture(t,{io:{...fs,open:(file,...args)=>{if(String(file).endsWith('.png'))images++;return fs.open(file,...args);}}});
    const input=f.batchInput();for(const patch of [{selections:[]},{selections:[...input.selections,input.selections[0]]},{selections:[input.selections[0],input.selections[0]]},
        {url:'https://outside.invalid/image.png'},{expectedAccount:'st-user:'+'0'.repeat(64)},{selections:[{...input.selections[0],url:f.image}]},
        {gallerySha256:'0'.repeat(64)},{selections:[{recordId:'missing',createdAt:0}]}])await assert.rejects(f.service.preserveBatch(f.req,{...input,...patch}),failure);
    assert.equal(images,0);await assert.rejects(fs.stat(path.join(f.req.user.directories.root,'.qianmu-originals-v1')),{code:'ENOENT'});
});

test('ordered batch selection works for group chats and duplicate saved ids reject before media reads',async t=>{
    const f=await fixture(t,{count:3}),input=f.batchInput();input.selections.reverse();
    const folder=f.req.user.directories.groupChats;await fs.mkdir(folder,{recursive:true});await fs.writeFile(path.join(folder,'group.jsonl'),await fs.readFile(f.file));
    input.target={kind:'group',chatId:'group'};const result=await f.service.preserveBatch(f.req,input);assert.deepEqual(result.selections,input.selections);
    f.rows.push({...f.rows[0]});await f.save();await assert.rejects(f.preserve(),failure);
});

test('header batch projection retains only two small matches per id, hashing all unknown fields',()=>{
    const records=Array.from({length:40},(_,index)=>({id:index%3?'other-'+index:'wanted',createdAt:index,payload:'private '.repeat(1000)}));
    const capture=createChatGalleryHeaderCapture({recordIds:['wanted','other-1'],projectRecord:row=>({id:row.id,createdAt:row.createdAt})});
    capture.write(JSON.stringify({chat_metadata:{story_director_liminale:{storyboardImages:records}}}));const result=capture.finish();
    assert.equal(result.records.length,3);assert.ok(result.records.every(row=>Object.keys(row).length===2));assert.deepEqual(result.gallery,chatGalleryDigest(records));
    for(const options of [{recordIds:[]},{recordIds:Array(9).fill('x')},{recordIds:['x','x']},{recordId:'x',recordIds:['x']}])assert.throws(()=>createChatGalleryHeaderCapture(options));
});

test('large saved source still scans its header only twice for a full batch',async t=>{
    let headers=0;const f=await fixture(t,{io:{...fs,open:(file,...args)=>{if(String(file).endsWith('.jsonl'))headers++;return fs.open(file,...args);}}});
    for(const row of f.rows)row.extra='x'.repeat(280000);await f.save();assert.ok(chatGalleryDigest(f.rows).bytes>2*1024*1024);
    const result=await f.preserve();assert.equal(result.records.length,8);assert.equal(headers,2);
});

test('chat edits during copying reject the batch and retain unacknowledged immutable copies',async t=>{
    let f,changed=false;const io={...fs,open:async(file,...args)=>{
        const h=await fs.open(file,...args);if(!String(file).endsWith('.bin')||args[0]!=='wx')return h;
        return {stat:options=>h.stat(options),write:(...parts)=>h.write(...parts),sync:()=>h.sync(),close:async()=>{await h.close();if(!changed){changed=true;f.rows.at(-1).unknown.changed=true;await f.save();}}};
    }};f=await fixture(t,{io});await assert.rejects(f.preserve(),failure);
    const root=path.join(f.req.user.directories.root,'.qianmu-originals-v1'),buckets=await fs.readdir(root);assert.equal(buckets.length,1);assert.equal((await fs.readdir(path.join(root,buckets[0]))).length,1);
    for(const row of f.rows)assert.deepEqual(await fs.readFile(path.join(f.images,path.basename(row.url))),png);
});

test('original changes between batch images or during final chat scan prevent any successful batch receipt',async t=>{
    for(const phase of ['next-image','final-header']){
        let f,headers=0,images=0;const io={...fs,open:async(file,...args)=>{
            if(String(file).endsWith('.jsonl'))headers++;if(String(file).endsWith('.png'))images++;
            if((phase==='next-image'&&String(file).endsWith('.png')&&images===2)||(phase==='final-header'&&String(file).endsWith('.jsonl')&&headers===2))
                await fs.writeFile(path.join(f.images,'frame-0.png'),Buffer.alloc(png.length));
            return fs.open(file,...args);
        }};f=await fixture(t,{io,count:2});await assert.rejects(f.preserve(),failure);
    }
});

test('batch refuses partial consumer success and revoked read leases cannot open more images',async t=>{
    const f=await fixture(t,{count:2});let escaped;
    await assert.rejects(f.source.withBatch(f.req,f.batchInput(),async lease=>{escaped=lease;await lease.read('frame-0');return 'partial';}),failure);
    await assert.rejects(escaped.read('frame-1'),failure);
    await f.source.withBatch(f.req,f.batchInput(),async lease=>{escaped=lease;for(const row of lease.records)await lease.read(row.id);return true;});
    await assert.rejects(escaped.read('frame-0'),failure);
});

test('batch source rejects hardlinked, invalid or missing originals without a batch receipt',async t=>{
    for(const mode of ['hardlink','invalid','missing']){
        const f=await fixture(t,{count:2}),target=path.join(f.images,'frame-1.png');
        if(mode==='hardlink')await fs.link(target,path.join(f.root,'outside-link'));
        if(mode==='invalid')await fs.writeFile(target,Buffer.from('not image'));if(mode==='missing')await fs.unlink(target);
        await assert.rejects(f.preserve(),failure);
    }
});

test('batch request snapshot cannot be mutated while the first file open is delayed',async t=>{
    let entered,release;const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});let blocked=true;
    const f=await fixture(t,{count:2,io:{...fs,open:async(file,...args)=>{if(String(file).endsWith('.jsonl')&&blocked){blocked=false;entered();await gate;}return fs.open(file,...args);}}});
    const input=f.batchInput(),task=f.service.preserveBatch(f.req,input);await started;input.target.chatId='wrong';input.selections[0].recordId='changed';release();
    const result=await task;assert.equal(result.target.chatId,'chat');assert.equal(result.records[0].selection.recordId,'frame-0');
});

test('actual batch HTTP/client roundtrip sends selectors only and preserves exact ordered results',async t=>{
    let headers=0;const f=await fixture(t,{count:3,io:{...fs,open:(file,...args)=>{if(String(file).endsWith('.jsonl'))headers++;return fs.open(file,...args);}}});
    const client=createGalleryOriginalClient({account:async()=>'st-user:alice',headers:()=>({'X-CSRF-Token':'fixture'}),fetchImpl:f.fetch});t.after(()=>client.close());
    const result=await client.preserveBatch(f.batchClientInput());assert.equal(headers,2);assert.equal(result.records.length,3);
    assert.deepEqual(f.calls.map(row=>row.url.split('/').at(-1)),['capabilities','preserve-batch']);
    assert.doesNotMatch(f.calls[1].body,/user\/images|url|snapshot|prompt|bytes|data/);
    const binary=await client.read(result.records[1].reference);assert.deepEqual(Buffer.from(await binary.blob.arrayBuffer()),png);
});

test('batch response cannot claim partial, reordered or another source success',async t=>{
    const f=await fixture(t,{count:2}),result=await f.preserve();
    for(const change of [value=>value.records.pop(),value=>value.records.reverse(),value=>value.gallerySha256='0'.repeat(64),value=>value.records[0].original.url='/user/images/else.png',value=>value.canPrune=true]){
        const bad=structuredClone(result);change(bad);
        if(bad.records[0]?.original.url.endsWith('else.png')){
            const client=createGalleryOriginalClient({account:async()=>'st-user:alice',headers:()=>({}),fetchImpl:(url,options)=>url.endsWith('preserve-batch')?Response.json(bad):f.fetch(url,options)});
            await assert.rejects(client.preserveBatch(f.batchClientInput()),failure);client.close();
        }else assert.throws(()=>galleryOriginalBatchPreserved(bad),failure);
    }
    assert.throws(()=>galleryOriginalBatchRequest({...f.batchInput(),selections:[]}));
});

test('batch timeout cancels its active copy and late handles close without a receipt',{timeout:10000},async t=>{
    let release,entered,writes=0,closed=0;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
    const f=await fixture(t,{count:2,timeoutMs:500,io:{...fs,open:async(file,...args)=>{
        const h=await fs.open(file,...args);if(!String(file).endsWith('.bin')||args[0]!=='wx')return h;
        entered();await gate;return {stat:options=>h.stat(options),write:async(...parts)=>{writes++;return h.write(...parts);},sync:()=>h.sync(),close:async()=>{closed++;await h.close();}};
    }}});t.signal.addEventListener('abort',release,{once:true});
    const task=f.preserve();await started;await assert.rejects(task,failure);release();await f.service.close();assert.equal(writes,0);assert.equal(closed,1);
});

test('an unfinished consumer read stays tracked until its cancelled late handle closes',{timeout:10000},async t=>{
    let entered,release,closed=0,returned=false;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
    const f=await fixture(t,{count:2,io:{...fs,open:async(file,...args)=>{
        const h=await fs.open(file,...args);if(!String(file).endsWith('.png'))return h;entered();await gate;
        return {stat:options=>h.stat(options),read:(...parts)=>h.read(...parts),close:async()=>{closed++;await h.close();}};
    }}});t.signal.addEventListener('abort',release,{once:true});
    let reading;const task=f.source.withBatch(f.req,f.batchInput(),async lease=>{reading=lease.read('frame-0');void reading.catch(()=>{});await started;return 'not awaited';});
    void task.finally(()=>{returned=true;}).catch(()=>{});await started;await new Promise(resolve=>setTimeout(resolve,10));assert.equal(returned,false);
    release();await assert.rejects(task,failure);await assert.rejects(reading,failure);assert.equal(closed,1);
});

test('account or image-directory changes during a batch prevent later image access',async t=>{
    for(const mode of ['account','directory']){
        let f,images=0;const io={...fs,open:async(file,...args)=>{
            const h=await fs.open(file,...args);if(!String(file).endsWith('.png'))return h;images++;
            return {stat:options=>h.stat(options),read:async(...parts)=>{const result=await h.read(...parts);
                if(mode==='account')f.req.user.profile.handle='bob';else f.req.user.directories.userImages=path.join(f.root,'other');return result;},close:()=>h.close()};
        }};f=await fixture(t,{count:2,io});await assert.rejects(f.preserve(),failure);assert.equal(images,1);
    }
});

test('old backend batch absence never falls back to per-image preservation or sends arbitrary URLs',async t=>{
    const f=await fixture(t,{count:2});let posts=0;
    const client=createGalleryOriginalClient({account:async()=>'st-user:alice',headers:()=>({}),fetchImpl:(url,options)=>{
        if(options.method==='POST'){posts++;assert.ok(url.endsWith('/preserve-batch'));return new Response('old',{status:404});}return f.fetch(url,options);
    }});t.after(()=>client.close());await assert.rejects(client.preserveBatch(f.batchClientInput()),failure);assert.equal(posts,1);
    for(const change of [value=>value.records.push(value.records[0]),value=>value.records[0].url='https://outside.invalid/secret',value=>value.records[0].data='private']){
        const input=f.batchClientInput();change(input);await assert.rejects(client.preserveBatch(input));
    }assert.equal(posts,1);
});
