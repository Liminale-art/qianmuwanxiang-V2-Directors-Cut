import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createGalleryOriginalSource,GALLERY_ORIGINAL_SOURCE_LIMITS as LIMIT} from '../qianmu-gallery-original-source.js';
import {imageServiceAccount} from '../qianmu-image-service-access.js';
import {chatGalleryDigest} from '../qianmu-chat-gallery-digest.js';
import {recipeClientFixture} from './helpers/recipe-client-fixture.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==','base64');
const hash=value=>createHash('sha256').update(value).digest('hex');
const originalError=error=>/^gallery_original_/.test(error?.code);
async function fixture(t,{io=fs,timeoutMs}={}){
    const e=await recipeClientFixture(t),images=path.join(e.req.user.directories.root,'user','images'),image=path.join(images,'example.png');
    await fs.mkdir(images,{recursive:true});await fs.writeFile(image,png);e.req.user.directories.userImages=images;
    const service=createGalleryOriginalSource({dataRoot:e.root,io,timeoutMs});t.after(()=>service.close());
    const input=()=>({version:1,expectedAccount:imageServiceAccount(e.req).namespace,target:{kind:'character',avatar:'Alice.png',chatId:'chat'},
        selection:{recordId:e.rows[0].id,createdAt:e.rows[0].createdAt,gallerySha256:chatGalleryDigest(e.rows).sha256}});
    return {...e,images,image,service,input,read:options=>service.read(e.req,input(),options)};
}
function imageIO(onOpen){return {...fs,open:async(filename,...args)=>String(filename).endsWith('.png')||String(filename).endsWith('.jpg')?onOpen(filename,args):fs.open(filename,...args)};}

test('saved chat and selected image yield exact bytes and non-durable evidence without writes',async t=>{
    const f=await fixture(t),before=await fs.readFile(f.file),files=await fs.readdir(f.images),input=f.input(),result=await f.read();
    assert.deepEqual(result.bytes,png);assert.deepEqual(result.receipt,{url:'/user/images/example.png',bytes:png.length,mime:'image/png',sha256:hash(png)});
    assert.deepEqual(result.target,input.target);assert.deepEqual(result.selection,input.selection);assert.equal(result.expectedAccount,input.expectedAccount);
    assert.equal(result.proof,'read-only-original-bytes');assert.equal(result.originalVerified,false);assert.equal(result.canPrune,false);
    assert.doesNotMatch(JSON.stringify({...result,bytes:undefined}),/private body|workflow|nodes|apiKey|[A-Z]:\\/);
    assert.deepEqual(await fs.readFile(f.file),before);assert.deepEqual(await fs.readFile(f.image),png);assert.deepEqual(await fs.readdir(f.images),files);
});

test('selectors cannot be replaced by a URL, disk path, arbitrary bytes or another account',async t=>{
    let opened=0;const f=await fixture(t,{io:imageIO((filename,args)=>{opened++;return fs.open(filename,...args);})});
    for(const extra of [{url:'/user/images/example.png'},{path:f.image},{data:'bytes'},{expectedAccount:'st-user:'+'a'.repeat(64)}])await assert.rejects(f.service.read(f.req,{...f.input(),...extra}),originalError);
    assert.equal(opened,0);
});

test('group-chat selection uses its exact saved source without a character-chat fallback',async t=>{
    const f=await fixture(t),folder=f.req.user.directories.groupChats;await fs.mkdir(folder,{recursive:true});
    const file=path.join(folder,'group-only.jsonl');await fs.writeFile(file,JSON.stringify({chat_metadata:f.context.chatMetadata})+'\n');
    const input={...f.input(),target:{kind:'group',chatId:'group-only'}},before=await fs.readFile(file),result=await f.service.read(f.req,input);
    assert.deepEqual(result.bytes,png);assert.deepEqual(result.target,input.target);assert.deepEqual(await fs.readFile(file),before);
    await assert.rejects(f.service.read(f.req,{...input,target:{kind:'group',chatId:'chat'}}),originalError);
});

test('unsaved selection, missing record, duplicate id and other-character source stop before image I/O',async t=>{
    let opened=0;const f=await fixture(t,{io:imageIO((filename,args)=>{opened++;return fs.open(filename,...args);})});
    const input=f.input();f.rows[0].snapshot.prompt='unsaved';await assert.rejects(f.read(),originalError);f.rows[0].snapshot.prompt='original';
    await assert.rejects(f.service.read(f.req,{...input,target:{...input.target,avatar:'Other.png'}}),originalError);
    await assert.rejects(f.service.read(f.req,{...input,selection:{...input.selection,recordId:'missing'}}),originalError);
    f.rows.push(structuredClone(f.rows[0]));await f.save();await assert.rejects(f.read(),originalError);assert.equal(opened,0);
});

test('remote, traversal, reserved and hidden paths cannot reach image open',async t=>{
    let opened=0;const f=await fixture(t,{io:imageIO((filename,args)=>{opened++;return fs.open(filename,...args);})});
    for(const url of ['https://example.invalid/private.png','/user/images/../outside.png','/user/images/%2e%2e/outside.png','/user/images/con.png','/user/images/.private.png','/user/images/a.png:secret.png']){
        f.rows[0].url=url;await f.save();await assert.rejects(f.read(),originalError);
    }assert.equal(opened,0);
});

test('missing, zero-byte, oversized and wrong-extension originals are not accepted as saved',async t=>{
    for(const mode of ['missing','empty','large','extension']){
        let opened=0;const f=await fixture(t,{io:imageIO((filename,args)=>{opened++;return fs.open(filename,...args);})});
        if(mode==='missing')f.rows[0].url='/user/images/missing.png';
        if(mode==='empty')await fs.writeFile(f.image,Buffer.alloc(0));
        if(mode==='large')await fs.truncate(f.image,LIMIT.bytes+1);
        if(mode==='extension'){await fs.writeFile(path.join(f.images,'wrong.jpg'),png);f.rows[0].url='/user/images/wrong.jpg';}
        await f.save();await assert.rejects(f.read(),originalError);assert.equal(opened,mode==='extension'?1:0);
    }
});

test('truncated and animated containers are not accepted as complete still originals',async t=>{
    const chunk=Buffer.alloc(20);chunk.writeUInt32BE(8);chunk.write('acTL',4);
    for(const bytes of [png.subarray(0,png.length-12),Buffer.concat([png.subarray(0,33),chunk,png.subarray(33)])]){
        const f=await fixture(t);await fs.writeFile(f.image,bytes);await assert.rejects(f.read(),error=>error.code==='gallery_original_format');assert.deepEqual(await fs.readFile(f.image),bytes);
    }
});

test('parent junctions and hardlinked originals are rejected before opening the image',async t=>{
    let opened=0;const f=await fixture(t,{io:imageIO((filename,args)=>{opened++;return fs.open(filename,...args);})});
    const outside=path.join(f.root,'other');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'outside.png'),png);
    await fs.symlink(outside,path.join(f.images,'linked'),'junction');f.rows[0].url='/user/images/linked/outside.png';await f.save();await assert.rejects(f.read(),originalError);
    f.rows[0].url='/user/images/example.png';await f.save();await fs.link(f.image,path.join(f.images,'duplicate.png'));await assert.rejects(f.read(),originalError);assert.equal(opened,0);
});

test('image replacement between lstat and open does not deliver bytes from a new file',async t=>{
    let closes=0;const f=await fixture(t,{io:imageIO(async(filename,args)=>{
        await fs.rename(filename,filename+'.old');await fs.writeFile(filename,png);const handle=await fs.open(filename,...args);
        return {stat:options=>handle.stat(options),read:(...parts)=>handle.read(...parts),close:async()=>{closes++;await handle.close();}};
    })});await assert.rejects(f.read(),originalError);assert.equal(closes,1);assert.deepEqual(await fs.readFile(f.image+'.old'),png);
});

test('account, directory or content changes during chunk reading close the handle without delivering bytes',async t=>{
    for(const mode of ['account','directory','content']){
        let f,closes=0,changed=false;f=await fixture(t,{io:imageIO(async(filename,args)=>{
            const handle=await fs.open(filename,...args);return {stat:options=>handle.stat(options),close:async()=>{closes++;await handle.close();},read:async(...parts)=>{
                const result=await handle.read(...parts);if(!changed){changed=true;if(mode==='account')f.req.user.profile.handle='bob';if(mode==='directory')f.req.user.directories.userImages=path.join(f.root,'elsewhere');if(mode==='content')await fs.writeFile(filename,Buffer.alloc(png.length+1));}return result;
            }};
        })});await assert.rejects(f.read(),originalError);assert.equal(closes,1);
    }
});

test('saved chat mutation after reading the image invalidates the selected source',async t=>{
    let f;f=await fixture(t,{io:imageIO(async(filename,args)=>{const handle=await fs.open(filename,...args);return {
        stat:options=>handle.stat(options),read:(...parts)=>handle.read(...parts),close:async()=>{await handle.close();f.rows[0].snapshot.prompt='changed after image';await f.save();},
    };})});await assert.rejects(f.read(),error=>error.code==='gallery_original_source');assert.deepEqual(await fs.readFile(f.image),png);
});

test('image changes during the final chat proof are detected by the last path identity check',async t=>{
    let f,chats=0;const io={...fs,open:async(filename,...args)=>{if(String(filename).endsWith('.jsonl')&&++chats===2)await fs.writeFile(f.image,Buffer.alloc(png.length+1));return fs.open(filename,...args);}};
    f=await fixture(t,{io});await assert.rejects(f.read(),error=>error.code==='gallery_original_changed');assert.equal(chats,2);
});

test('large original reads use bounded chunks and preserve exact bytes without a second media read',async t=>{
    const payload=Buffer.alloc(1024*1024,65),chunk=Buffer.alloc(payload.length+12);chunk.writeUInt32BE(payload.length);chunk.write('tEXt',4);payload.copy(chunk,8);
    const bytes=Buffer.concat([png.subarray(0,png.length-12),chunk,png.subarray(png.length-12)]);let opens=0,reads=0;
    const f=await fixture(t,{io:imageIO(async(filename,args)=>{opens++;const handle=await fs.open(filename,...args);return {stat:options=>handle.stat(options),close:()=>handle.close(),read:async(...parts)=>{assert.ok(parts[2]<=LIMIT.chunkBytes);reads++;return handle.read(...parts);}};})});
    await fs.writeFile(f.image,bytes);const result=await f.read();assert.deepEqual(result.bytes,bytes);assert.equal(result.receipt.sha256,hash(bytes));assert.equal(opens,1);assert.ok(reads>16);
});

test('timeouts retain occupied slots until slow OS opens finish and late handles are closed',{timeout:10000},async t=>{
    let release,entered,opens=0,closes=0;const gate=new Promise(done=>release=done),both=new Promise(done=>entered=done);
    t.signal.addEventListener('abort',()=>{release();entered();},{once:true});
    const f=await fixture(t,{timeoutMs:500,io:imageIO(async(filename,args)=>{if(++opens===2)entered();await gate;const handle=await fs.open(filename,...args);return {stat:options=>handle.stat(options),read:(...parts)=>handle.read(...parts),close:async()=>{closes++;await handle.close();}};})});
    const one=assert.rejects(f.read(),originalError),two=assert.rejects(f.read(),originalError);await both;await Promise.all([one,two]);
    await assert.rejects(f.read(),error=>error.code==='gallery_original_busy');const closing=f.service.close();release();await closing;assert.equal(opens,2);assert.equal(closes,2);
});

test('abort and service close cancel selected reads; raw filesystem errors are redacted',async t=>{
    const f=await fixture(t),controller=new AbortController();controller.abort();await assert.rejects(f.read({signal:controller.signal}),originalError);
    await f.service.close();await assert.rejects(f.read(),originalError);
    const broken=await fixture(t,{io:imageIO(async()=>{throw Error('PRIVATE_DISK_PATH PRIVATE_KEY');})});
    await assert.rejects(broken.read(),error=>originalError(error)&&!/PRIVATE/.test(error.message));
});
