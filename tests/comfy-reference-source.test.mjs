import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createComfyReferenceSource} from '../qianmu-comfy-reference-source.js';
import {imageServiceAccount} from '../qianmu-image-service-access.js';
import {planComfyCloudUpload} from '../qianmu-comfy-cloud-upload-contract.js';
import {bindComfyCloudProtocol} from '../qianmu-comfy-cloud-protocol.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==','base64');
async function fixture(t,io){
  const temporary=await fs.mkdtemp(path.join(tmpdir(),'qianmu-reference-source-')),dataRoot=path.join(temporary,'data'),root=path.join(dataRoot,'alice'),images=path.join(root,'user','images');
  const file=path.join(images,'selected.png');await fs.mkdir(images,{recursive:true});await fs.writeFile(file,png);
  const req={user:{profile:{handle:'alice',enabled:true},directories:{root,userImages:images}}};
  const plan=planComfyCloudUpload(bindComfyCloudProtocol('https://cloud.comfy.org','comfy-cloud-v2'),
    {url:'/user/images/selected.png',name:'selected',bytes:png.length,mime:'image/png',sha256:createHash('sha256').update(png).digest('hex')});
  const service=createComfyReferenceSource({dataRoot,io});
  t.after(async()=>{await service.close();assert.equal(path.dirname(temporary),path.resolve(tmpdir()));assert.ok(path.basename(temporary).startsWith('qianmu-reference-source-'));assert.equal((await fs.lstat(temporary)).isSymbolicLink(),false);await fs.rm(temporary,{recursive:true,force:true});});
  return {temporary,dataRoot,images,file,req,plan,service,authorize:()=>service.authorize(req,plan,imageServiceAccount(req))};
}
test('host-selected sources read current account bytes once without adding or deleting files',async t=>{
  const f=await fixture(t),grant=await f.authorize();assert.deepEqual(await grant.read(),png);await grant.verify();
  await assert.rejects(grant.read(),{code:'comfy_reference_source'});assert.deepEqual(await fs.readdir(f.images),['selected.png']);
});
test('account, directory or file replacement invalidates an existing source grant before it returns bytes',async t=>{
  for(const mode of ['account','directory','file','closed']){
    const f=await fixture(t),grant=await f.authorize();
    if(mode==='account')f.req.user.profile.handle='bob';
    if(mode==='directory')f.req.user.directories.userImages=path.join(f.dataRoot,'bob');
    if(mode==='file'){await fs.rename(f.file,path.join(f.images,'previous.png'));await fs.writeFile(f.file,png);}
    if(mode==='closed')await f.service.close();
    await assert.rejects(grant.read(),{code:'comfy_reference_source'});
  }
});
test('parent junctions, hardlinked files and unsafe portable paths cannot reach file-open',async t=>{
  let opens=0;const io={...fs,open:async(...args)=>{opens++;return fs.open(...args);}};
  const f=await fixture(t,io),outside=path.join(f.dataRoot,'bob');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'secret.png'),png);
  await fs.symlink(outside,path.join(f.images,'linked'),'junction');
  for(const url of ['/user/images/linked/secret.png','/user/images/../bob/secret.png','/user/images/selected.png:secret.png','/user/images/con.png']){
    await assert.rejects(f.service.authorize(f.req,{...f.plan,source:{...f.plan.source,url}},imageServiceAccount(f.req)));
  }
  await fs.link(f.file,path.join(f.images,'linked-file.png'));await assert.rejects(f.authorize(),{code:'comfy_reference_source'});assert.equal(opens,0);
});
test('aborting a grant or changing bytes during an open read fails without leaking filesystem details',async t=>{
  let mutate=false;const io={...fs,open:async(...args)=>{
    const handle=await fs.open(...args);return {stat:options=>handle.stat(options),close:()=>handle.close(),read:async(...parts)=>{
      const result=await handle.read(...parts);if(mutate){mutate=false;await fs.writeFile(args[0],Buffer.alloc(png.length+1));}return result;
    }};
  }};
  const f=await fixture(t,io),controller=new AbortController(),grant=await f.service.authorize(f.req,f.plan,imageServiceAccount(f.req),{signal:controller.signal});
  controller.abort();await assert.rejects(grant.read(),{code:'comfy_reference_source'});
  const next=await f.authorize();mutate=true;await assert.rejects(next.read(),error=>error.code==='comfy_reference_source'&&!error.message.includes(f.temporary));
});

test('slow file opens remain inside a two-reader bound and closing the service prevents late delivery',async t=>{
  let opens=0,release,entered;const waiting=new Promise(resolve=>release=resolve),bothEntered=new Promise(resolve=>entered=resolve);
  const f=await fixture(t,{...fs,open:async(...args)=>{opens++;if(opens===2)entered();await waiting;return fs.open(...args);}});
  const grants=await Promise.all([f.authorize(),f.authorize(),f.authorize()]);
  const first=grants[0].read(),second=grants[1].read();const failures=[assert.rejects(first,{code:'comfy_reference_source'}),assert.rejects(second,{code:'comfy_reference_source'})];
  await assert.rejects(grants[2].read(),{code:'comfy_reference_source'});
  await bothEntered;const closing=f.service.close();release();await Promise.all(failures);await closing;assert.equal(opens,2);
});
