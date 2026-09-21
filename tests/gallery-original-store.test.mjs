import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createGalleryOriginalStore,galleryOriginalReference,GALLERY_ORIGINAL_STORE_LIMITS as LIMIT} from '../qianmu-gallery-original-store.js';
import {createGalleryOriginalService} from '../qianmu-gallery-original-service.js';
import {imageServiceAccount} from '../qianmu-image-service-access.js';
import {chatGalleryDigest} from '../qianmu-chat-gallery-digest.js';
import {recipeClientFixture} from './helpers/recipe-client-fixture.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==','base64');
const sha=value=>createHash('sha256').update(value).digest('hex');
const content=bytes=>({bytes:Buffer.from(bytes||png),sha256:sha(bytes||png),mime:'image/png'});
const failure=error=>/^gallery_original_/.test(error?.code);
async function fixture(t,{io=fs,timeoutMs}={}){
    const f=await recipeClientFixture(t),account=imageServiceAccount(f.req).namespace;
    const folder=path.join(f.req.user.directories.root,'.qianmu-originals-v1'),bucket=path.join(folder,sha(png).slice(0,2));
    const store=createGalleryOriginalStore({dataRoot:f.root,io,timeoutMs});t.after(()=>store.close());
    return {...f,account,folder,bucket,store,put:value=>store.put(f.req,account,value||content()),get:ref=>store.get(f.req,account,ref),
        location:ref=>path.join(folder,ref.sha256.slice(0,2),ref.id+'.bin')};
}
function binaryIO(onOpen){return {...fs,open:(file,...args)=>String(file).endsWith('.bin')?onOpen(file,args):fs.open(file,...args)};}
function wrapped(handle,overrides={}){return {stat:options=>handle.stat(options),read:(...args)=>handle.read(...args),write:(...args)=>handle.write(...args),
    sync:()=>handle.sync(),close:()=>handle.close(),...overrides};}
async function serviceFixture(t,options={}){
    const f=await fixture(t,options),images=path.join(f.req.user.directories.root,'user','images'),image=path.join(images,'example.png');
    await fs.mkdir(images,{recursive:true});await fs.writeFile(image,png);f.req.user.directories.userImages=images;
    const service=createGalleryOriginalService({dataRoot:f.root,...options});t.after(()=>service.close());
    const input=()=>({version:1,expectedAccount:f.account,target:{kind:'character',avatar:'Alice.png',chatId:'chat'},
        selection:{recordId:f.rows[0].id,createdAt:f.rows[0].createdAt,gallerySha256:chatGalleryDigest(f.rows).sha256}});
    return {...f,images,image,service,input,preserve:()=>service.preserve(f.req,input()),
        read:reference=>service.read(f.req,{version:1,expectedAccount:f.account,reference})};
}

test('store constructor and rejected requests do no I/O or startup writes',async t=>{
    let calls=0;const f=await fixture(t,{io:new Proxy(fs,{get:(target,key)=>typeof target[key]==='function'?()=>{calls++;throw Error('unexpected I/O');}:target[key]})});
    assert.equal(calls,0);await assert.rejects(fs.stat(f.folder),{code:'ENOENT'});
    for(const value of [{...content(),sha256:'0'.repeat(64)},{...content(),mime:'image/jpeg'},content(png.subarray(0,20)),{...content(),url:'secret'},content(Buffer.alloc(LIMIT.bytes+1))])
        await assert.rejects(f.put(value),failure);
    await assert.rejects(f.store.put(f.req,'st-user:'+'a'.repeat(64),content()),failure);
    assert.equal(calls,0);
});

test('independent immutable file is fsynced, read back, deduplicated and survives a new store instance',async t=>{
    let syncs=0,writes=0;const f=await fixture(t,{io:binaryIO(async(file,args)=>{
        const handle=await fs.open(file,...args);if(args[0]!=='wx')return handle;writes++;
        return wrapped(handle,{sync:async()=>{syncs++;await handle.sync();}});
    })});
    const before=await fs.readFile(f.file),ref=await f.put();assert.deepEqual(galleryOriginalReference(ref),ref);
    assert.equal(syncs,1);assert.deepEqual(await f.get(ref),png);assert.deepEqual(await f.put(),ref);assert.equal(writes,1);
    assert.deepEqual(await fs.readdir(f.bucket),[ref.id+'.bin']);assert.deepEqual(await fs.readFile(f.file),before);
    const next=createGalleryOriginalStore({dataRoot:f.root});t.after(()=>next.close());assert.deepEqual(await next.get(f.req,f.account,ref),png);
    assert.doesNotMatch(JSON.stringify(ref),/[A-Z]:\\|user\/images|alice/);
});

test('dedup is account-local and arbitrary references cannot traverse or cross account boundaries',async t=>{
    const f=await fixture(t),ref=await f.put(),bob=path.join(f.root,'bob');await fs.mkdir(bob);
    const req={user:{profile:{handle:'bob'},directories:{root:bob}}},account=imageServiceAccount(req).namespace;
    await assert.rejects(f.store.get(req,f.account,ref),failure);
    await assert.rejects(f.store.get(req,account,ref),error=>error.code==='gallery_original_store_missing');
    const other=await f.store.put(req,account,content());assert.notEqual(other.id,ref.id);assert.deepEqual(await f.store.get(req,account,other),png);
    for(const bad of [{...ref,id:'../outside'},{...ref,id:ref.id.toUpperCase()},{...ref,bytes:LIMIT.bytes+1},{...ref,path:f.file},{...ref,mime:'text/html'}])
        await assert.rejects(f.get(bad),failure);
});

test('put owns a bounded byte snapshot before the caller can mutate it',async t=>{
    const f=await fixture(t),input=content(),task=f.put(input);input.bytes.fill(0);input.sha256='0'.repeat(64);
    const ref=await task;assert.deepEqual(await f.get(ref),png);
});

test('corrupt partial copies are retained and a fresh verified variant is generated',async t=>{
    const f=await fixture(t),ref=await f.put(),file=f.location(ref);await fs.writeFile(file,png.subarray(0,12));
    await assert.rejects(f.get(ref),error=>error.code==='gallery_original_store_corrupt');
    const next=await f.put();assert.notEqual(next.id,ref.id);assert.deepEqual(await f.get(next),png);
    assert.deepEqual(await fs.readFile(file),png.subarray(0,12));assert.equal((await fs.readdir(f.bucket)).length,2);
    await fs.writeFile(f.location(next),Buffer.alloc(png.length));await assert.rejects(f.get(next),failure);
});

test('low or unmeasurable free space creates no acknowledged image; dedup needs no extra disk',async t=>{
    let low=false;const f=await fixture(t,{io:{...fs,statfs:(...args)=>low?Promise.resolve({bavail:0n,bsize:4096n}):fs.statfs(...args)}});
    const ref=await f.put();low=true;assert.deepEqual(await f.put(),ref);
    const altered=Buffer.from(png);altered[45]^=1;await assert.rejects(f.put(content(altered)),error=>error.code==='gallery_original_store_space');
    assert.deepEqual(await f.get(ref),png);
    for(const value of [{bavail:999999999,bsize:4096},{bavail:2n,bsize:0n}]){
        const g=await fixture(t,{io:{...fs,statfs:async()=>value}});await assert.rejects(g.put(),failure);assert.deepEqual(await fs.readdir(g.bucket),[]);
    }
});

test('hash lookup scans only its bounded bucket and never opens unrelated image contents',async t=>{
    let opens=0;const f=await fixture(t,{io:binaryIO(async(file,args)=>{opens++;return fs.open(file,...args);})});
    await fs.mkdir(f.bucket,{recursive:true});
    const unrelated=sha(png).slice(0,2)+'f'.repeat(62),name=unrelated+'-'+randomUUID()+'.bin';await fs.writeFile(path.join(f.bucket,name),'unrelated');
    const otherBucket=path.join(f.folder,'ff');await fs.mkdir(otherBucket);await fs.writeFile(path.join(otherBucket,'unknown'),'not visited');
    await f.put();assert.equal(opens,2);assert.equal(await fs.readFile(path.join(f.bucket,name),'utf8'),'unrelated');
});

test('bucket enumeration closes on overflow and unknown files without scanning other buckets',async t=>{
    let closes=0,iterations=0;const f=await fixture(t,{io:{...fs,opendir:async()=>({async *[Symbol.asyncIterator](){
        for(let i=0;i<=LIMIT.bucketFiles;i++){iterations++;yield {name:sha(png).slice(0,2)+'f'.repeat(62)+'-'+randomUUID()+'.bin',isFile:()=>true,isSymbolicLink:()=>false};}
    },async close(){closes++;}})}});
    await assert.rejects(f.put(),error=>error.code==='gallery_original_store_capacity');assert.equal(iterations,LIMIT.bucketFiles+1);assert.equal(closes,1);
    const g=await fixture(t);await fs.mkdir(g.bucket,{recursive:true});await fs.writeFile(path.join(g.bucket,'unexpected'),'keep');
    await assert.rejects(g.put(),failure);assert.equal(await fs.readFile(path.join(g.bucket,'unexpected'),'utf8'),'keep');
});

test('junctions and matching hardlinks are not followed, reused or overwritten',async t=>{
    const f=await fixture(t),outside=path.join(f.root,'outside');await fs.mkdir(outside);await fs.symlink(outside,f.folder,'junction');
    await assert.rejects(f.put(),error=>error.code==='gallery_original_store_path');assert.deepEqual(await fs.readdir(outside),[]);
    const g=await fixture(t),ref=await g.put();await fs.link(g.location(ref),path.join(g.root,'linked-copy'));
    await assert.rejects(g.get(ref),error=>error.code==='gallery_original_store_path');await assert.rejects(g.put(),failure);
    assert.deepEqual(await fs.readFile(g.location(ref)),png);assert.equal((await fs.readdir(g.bucket)).length,1);
});

test('short writes and reads stay bounded and produce the exact large original',async t=>{
    const extra=Buffer.alloc(1024*1024);extra.writeUInt32BE(extra.length-12);extra.write('tEXt',4);
    const bytes=Buffer.concat([png.subarray(0,33),extra,png.subarray(33)]);let writeChunks=0,readChunks=0;
    const f=await fixture(t,{io:binaryIO(async(file,args)=>{const h=await fs.open(file,...args);return wrapped(h,{
        write:async(buffer,offset,length,position)=>{assert.ok(length<=LIMIT.chunkBytes);writeChunks++;return h.write(buffer,offset,Math.min(17000,length),position);},
        read:async(buffer,offset,length,position)=>{assert.ok(length<=LIMIT.chunkBytes);readChunks++;return h.read(buffer,offset,Math.min(19000,length),position);},
    });})});
    const ref=await f.put(content(bytes));assert.deepEqual(await f.get(ref),bytes);assert.ok(writeChunks>16);assert.ok(readChunks>32);
});

test('failed fsync leaves only an unacknowledged file, never removes or overwrites the source',async t=>{
    const f=await fixture(t,{io:binaryIO(async(file,args)=>{const h=await fs.open(file,...args);return args[0]==='wx'?wrapped(h,{sync:async()=>{throw Object.assign(Error('private path secret'),{code:'ENOSPC'});}}):h;})});
    const before=await fs.readFile(f.file);await assert.rejects(f.put(),error=>error.code==='gallery_original_store_space'&&!error.message.includes('secret'));
    assert.deepEqual(await fs.readFile(f.file),before);assert.equal((await fs.readdir(f.bucket)).length,1);
});

test('dedup of an interrupted complete file must fsync it before acknowledging preservation',async t=>{
    let broken=true,syncs=0;const f=await fixture(t,{io:binaryIO(async(file,args)=>{
        const h=await fs.open(file,...args);return wrapped(h,{sync:async()=>{syncs++;if(broken)throw Error('sync unavailable');await h.sync();}});
    })});
    await assert.rejects(f.put(),failure);assert.equal(syncs,1);const names=await fs.readdir(f.bucket);
    await assert.rejects(f.put(),failure);assert.equal(syncs,2);assert.deepEqual(await fs.readdir(f.bucket),names);
    broken=false;const ref=await f.put();assert.equal(syncs,3);assert.equal(ref.id+'.bin',names[0]);assert.deepEqual(await f.get(ref),png);
});

test('account/root mutations during writes reject receipts and close opened handles',async t=>{
    for(const mode of ['account','root']){
        let f,closed=0;f=await fixture(t,{io:binaryIO(async(file,args)=>{const h=await fs.open(file,...args);return wrapped(h,{
            write:async(...parts)=>{const result=await h.write(...parts);if(mode==='account')f.req.user.profile.handle='bob';else f.req.user.directories.root=path.join(f.root,'bob');return result;},
            close:async()=>{closed++;await h.close();},
        });})});await assert.rejects(f.put(),failure);assert.equal(closed,1);
    }
});

test('replacement before read open and content changes during read are rejected',async t=>{
    for(const mode of ['replace','mutate']){
        let active=false,closed=0;const f=await fixture(t,{io:binaryIO(async(file,args)=>{
            if(active&&mode==='replace'){await fs.rename(file,file+'.old');await fs.writeFile(file,png);}
            const h=await fs.open(file,...args);if(!active)return h;
            return wrapped(h,{read:async(...parts)=>{const result=await h.read(...parts);if(mode==='mutate')await fs.writeFile(file,Buffer.alloc(png.length));return result;},close:async()=>{closed++;await h.close();}});
        })});const ref=await f.put();active=true;await assert.rejects(f.get(ref),failure);assert.equal(closed,1);
    }
});

test('timeout keeps account lock and late write handle is closed without writing or publishing', {timeout:10000},async t=>{
    let release,entered,closes=0,writes=0;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
    const f=await fixture(t,{timeoutMs:500,io:binaryIO(async(file,args)=>{
        const h=await fs.open(file,...args);if(args[0]!=='wx')return h;entered();await gate;
        return wrapped(h,{write:async(...parts)=>{writes++;return h.write(...parts);},close:async()=>{closes++;await h.close();}});
    })});
    t.signal.addEventListener('abort',release,{once:true});const first=f.put();await started;
    await assert.rejects(first,error=>error.code==='gallery_original_store_cancelled');await assert.rejects(f.put(),error=>error.code==='gallery_original_store_busy');
    release();await f.store.close();assert.equal(closes,1);assert.equal(writes,0);await assert.rejects(f.put(),failure);
});

test('service preserves only selected saved originals and returns readable copies after native file/chat removal',async t=>{
    const f=await serviceFixture(t),before=await fs.readFile(f.file),result=await f.preserve();
    assert.equal(result.proof,'original-copy-readback');assert.equal(result.originalVerified,true);assert.equal(result.canPrune,false);
    assert.equal(result.persistence,'st-account-file');assert.deepEqual(result.selection,f.input().selection);
    assert.deepEqual(await fs.readFile(f.file),before);assert.deepEqual(await fs.readFile(f.image),png);
    await fs.unlink(f.image);await fs.unlink(f.file);const restored=await f.read(result.reference);assert.deepEqual(restored.bytes,png);assert.equal(restored.canPrune,false);
});

test('service refuses remote/unsaved sources and arbitrary payloads before creating an archive',async t=>{
    const f=await serviceFixture(t);for(const extra of [{url:f.image},{bytes:png},{path:f.file}])await assert.rejects(f.service.preserve(f.req,{...f.input(),...extra}));
    f.rows[0].snapshot.prompt='not saved';await assert.rejects(f.preserve(),failure);
    f.rows[0].url='https://example.invalid/private.png';await f.save();await assert.rejects(f.preserve(),failure);
    await assert.rejects(fs.stat(f.folder),{code:'ENOENT'});
});

test('source mutation after copy leaves the copy but does not publish a matching preservation receipt',async t=>{
    let f,changed=false;f=await serviceFixture(t,{io:binaryIO(async(file,args)=>{
        const h=await fs.open(file,...args);return wrapped(h,{close:async()=>{await h.close();if(args[0]==='wx'&&!changed){changed=true;f.rows[0].snapshot.prompt='new source';await f.save();}}});
    })});
    await assert.rejects(f.preserve(),failure);assert.equal((await fs.readdir(f.bucket)).length,1);assert.deepEqual(await fs.readFile(f.image),png);
});

test('native original byte changes after copy invalidate preservation even if the chat URL is unchanged',async t=>{
    let f,changed=false;f=await serviceFixture(t,{io:binaryIO(async(file,args)=>{
        const h=await fs.open(file,...args);return wrapped(h,{close:async()=>{await h.close();if(args[0]==='wx'&&!changed){changed=true;const alternate=Buffer.from(png);alternate[45]^=1;await fs.writeFile(f.image,alternate);}}});
    })});
    await assert.rejects(f.preserve(),error=>error.code==='gallery_original_service_source');assert.equal((await fs.readdir(f.bucket)).length,1);
});

test('pre-abort and closed service reject without creating a copy; errors redact internal paths',async t=>{
    const f=await serviceFixture(t,{io:{...fs,statfs:async()=>{throw Error('PRIVATE '+f.root);}}});
    await assert.rejects(f.service.preserve(f.req,f.input(),{signal:AbortSignal.abort()}),failure);
    await assert.rejects(fs.stat(f.folder),{code:'ENOENT'});
    await assert.rejects(f.preserve(),error=>failure(error)&&!error.message.includes(f.root)&&!error.message.includes('PRIVATE'));
    await f.service.close();await assert.rejects(f.preserve(),failure);
});

test('copy corruption during final native source verification prevents a successful service receipt',async t=>{
    let f,nativeReads=0;f=await serviceFixture(t,{io:{...fs,open:async(file,...args)=>{
        if(String(file).endsWith('example.png')&&++nativeReads===2){
            const names=await fs.readdir(f.bucket);await fs.writeFile(path.join(f.bucket,names[0]),Buffer.alloc(png.length));
        }
        return fs.open(file,...args);
    }}});
    await assert.rejects(f.preserve(),error=>error.code==='gallery_original_store_corrupt');assert.equal(nativeReads,2);assert.deepEqual(await fs.readFile(f.image),png);
});

test('store read cancellation and the global pending bound hold until slow reads really settle',{timeout:10000},async t=>{
    let block=false,opened=0,closes=0,release;const gate=new Promise(resolve=>{release=resolve;});
    const f=await fixture(t,{timeoutMs:500,io:binaryIO(async(file,args)=>{const h=await fs.open(file,...args);if(!block)return h;
        opened++;await gate;return wrapped(h,{close:async()=>{closes++;await h.close();}});
    })});
    const ref=await f.put();block=true;t.signal.addEventListener('abort',release,{once:true});
    const reads=[f.get(ref),f.get(ref)];await Promise.all(reads.map(task=>assert.rejects(task,failure)));
    assert.equal(opened,2);await assert.rejects(f.get(ref),error=>error.code==='gallery_original_store_busy');release();await f.store.close();assert.equal(closes,2);
});
