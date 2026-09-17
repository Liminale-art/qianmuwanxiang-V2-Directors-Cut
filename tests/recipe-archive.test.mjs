import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {createRecipeArchiveService} from '../qianmu-recipe-archive-service.js';
import {createRecipeArchiveStore} from '../qianmu-recipe-archive-store.js';
import {recipeArchiveSnapshot,recipeArchiveReference,recipeArchiveEnvelope,recipeArchiveRequest,recipeArchiveResponse,recipeArchiveErrorPayload,RECIPE_ARCHIVE_LIMITS} from '../qianmu-recipe-archive-contract.js';
import {chatGalleryReceiptText} from '../qianmu-chat-gallery-receipt.js';
import {init,exit} from '../server-plugin.js';
const sha=value=>createHash('sha256').update(value).digest('hex'),account=handle=>'st-user:'+sha(handle);
const target={kind:'character',avatar:'Alice.png',chatId:'chat'};
const recipe=(prompt='原始\n提示词')=>({source:'comfy',prompt,negative:'',profile:{seed:0},connection:{baseUrl:'http://127.0.0.1:8188',credentialId:'alias-only'},
  payload:{prompt,parameters:{workflow:{nodes:Array.from({length:120},(_,index)=>({id:index,text:'node '+index}))}}},future:{keep:['','  spaces  ',0,false,null]}});
const frame=()=>({id:'image',createdAt:1,snapshot:recipe(),snapshotRef:'legacy-local',url:'/user/images/fixture.png',privateOther:'DO_NOT_RETURN'});
const input=rows=>({version:1,expectedAccount:account('alice'),target,selection:{recordId:'image',createdAt:1,gallerySha256:sha(chatGalleryReceiptText(rows).text)}});
const envelope=snapshot=>({version:1,expectedAccount:account('alice'),source:{target,recordId:'image',createdAt:1},snapshot});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function fixture(t,options={}){
  const parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'qianmu-recipe-test-'));
  const accountRoot=path.join(root,'alice'),chats=path.join(accountRoot,'chats'),folder=path.join(chats,'Alice'),groups=path.join(accountRoot,'group chats');
  await fs.mkdir(folder,{recursive:true});await fs.mkdir(groups);
  const file=path.join(folder,'chat.jsonl'),archive=path.join(accountRoot,'.qianmu-recipes-v1');
  const req={user:{profile:{handle:'alice',enabled:true},directories:{root:accountRoot,chats,groupChats:groups}}};
  const service=createRecipeArchiveService({dataRoot:root,...options}),store=createRecipeArchiveStore({dataRoot:root,...options});
  t.after(async()=>{await Promise.all([service.close(),store.close()]);const resolved=await fs.realpath(root);
    assert.equal(path.dirname(resolved),parent);assert.match(path.basename(resolved),/^qianmu-recipe-test-/);await fs.rm(resolved,{recursive:true});});
  return {root,accountRoot,folder,chats,groups,file,archive,req,service,store,
    write:rows=>fs.writeFile(file,JSON.stringify({chat_metadata:{story_director_liminale:{storyboardImages:rows,privateHistory:'PRIVATE_HISTORY'}}})+'\n'+JSON.stringify({mes:'PRIVATE_BODY'})+'\n')};
}

test('recipe contract retains unknown fields, large workflows, whitespace and zero without sanitizing or truncating',()=>{
  const value=recipe(),before=structuredClone(value),result=recipeArchiveSnapshot(value);
  assert.deepEqual(result.snapshot,value);assert.deepEqual(value,before);assert.equal(result.snapshot.payload.parameters.workflow.nodes.length,120);
  assert.equal(result.snapshot.future.keep[1],'  spaces  ');assert.equal(result.snapshot.profile.seed,0);
  const reordered={...value,future:{keep:value.future.keep},prompt:value.prompt};assert.equal(recipeArchiveSnapshot(reordered).text,result.text);
  assert.deepEqual(recipeArchiveEnvelope(envelope(value)).value,envelope(value));
});

test('recipe contract rejects incomplete, non-JSON, oversized and explicit credential-bearing content without guessing defaults',()=>{
  const cycle=recipe();cycle.future=cycle;
  for(const value of [null,{}, {prompt:'only'}, {...recipe(),profile:null},{...recipe(),future:new Date()},
    {...recipe(),future:undefined},{...recipe(),future:[Infinity]},cycle,{...recipe(),future:'a'.repeat(RECIPE_ARCHIVE_LIMITS.recipeBytes)},
    {...recipe(),future:JSON.parse('{"__proto__":{"x":1}}')}])assert.throws(()=>recipeArchiveSnapshot(value));
  for(const field of ['apiKey','Authorization','access_token','password','token','X-API-Key','secret.key','credentials','OPENAI_API_KEY','myApiKey','X-Secret-Key']){
    const value=recipe();value.payload[field]='PRIVATE_TOKEN';assert.throws(()=>recipeArchiveSnapshot(value),{code:'recipe_archive_credentials'});
  }
  for(const baseUrl of ['https://user:pass@example.test','https://example.test?api_key=PRIVATE','https://example.test?signature=PRIVATE','https://example.test?X-Amz-Signature=PRIVATE'])
    assert.throws(()=>recipeArchiveSnapshot({...recipe(),connection:{baseUrl}}),{code:'recipe_archive_credentials'});
});

test('selectors cannot carry uploaded recipes, disk paths, unrelated owners or caller-chosen archive references',()=>{
  const request=input([frame()]);assert.deepEqual(recipeArchiveRequest(request),request);
  for(const extra of [{snapshot:recipe()},{path:'other/file'},{owner:'bob'},{reference:{id:'fake'}}])assert.throws(()=>recipeArchiveRequest({...request,...extra}));
  for(const value of [null,{}, {version:1,id:'../escape',sha256:'a'.repeat(64),bytes:1}])assert.throws(()=>recipeArchiveReference(value));
  assert.deepEqual(recipeArchiveErrorPayload(new Error('PRIVATE disk path')).body,{ok:false,version:1,code:'recipe_archive_unavailable',message:'配方保全暂未确认，请保留原聊天及本机副本后重试'});
});

test('response contract distinguishes a saved inline recipe from a durable archive and rejects extra fields',()=>{
  const value={ok:true,...input([frame()]),reference:null,snapshot:recipe(),origin:'saved-inline',proof:'read-only-recipe'};
  assert.deepEqual(recipeArchiveResponse(value),value);
  for(const patch of [{origin:'server-archive'},{proof:'durable-recipe'},{extra:'private'}, {version:2},{expectedAccount:'st-user:bob'},{snapshot:{prompt:'partial'}}])
    assert.throws(()=>recipeArchiveResponse({...value,...patch}));
});

test('declared recipe size is enforced without clipping, while typed continuity keys and routing aliases remain intact',()=>{
  const value=recipe();value.future={key:'continuity fact',credentialId:'local-alias',headers:{'X-Model-Family':'custom'}};
  assert.deepEqual(recipeArchiveSnapshot(value).snapshot,value);
  const limits=recipe();limits.future={large:'x'.repeat(RECIPE_ARCHIVE_LIMITS.recipeBytes)};
  assert.throws(()=>recipeArchiveSnapshot(limits),{code:'recipe_archive_size'});assert.equal(limits.future.large.length,RECIPE_ARCHIVE_LIMITS.recipeBytes);
});

test('startup and full inline reading do not create storage, modify chats or expose unrelated body and settings',async t=>{
  const f=await fixture(t),rows=[frame()];await f.write(rows);const before=await fs.readFile(f.file);
  await assert.rejects(fs.stat(f.archive),{code:'ENOENT'});
  const result=await f.service.read(f.req,input(rows));assert.deepEqual(result.snapshot,rows[0].snapshot);assert.equal(result.origin,'saved-inline');assert.equal(result.reference,null);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_BODY|PRIVATE_HISTORY|DO_NOT_RETURN|legacy-local|user\/images/);
  await assert.rejects(fs.stat(f.archive),{code:'ENOENT'});assert.deepEqual(await fs.readFile(f.file),before);
});

test('preserve reads the saved exact source, returns only a durable reference and reuses immutable retries',async t=>{
  const f=await fixture(t),rows=[frame()];await f.write(rows);const before=await fs.readFile(f.file);
  const result=await f.service.preserve(f.req,input(rows)),ref=recipeArchiveReference(result.reference);
  assert.equal(result.proof,'durable-recipe');assert.equal(result.snapshot,undefined);assert.doesNotMatch(JSON.stringify(result),/原始|legacy-local/);
  const file=path.join(f.archive,ref.id+'.json'),bytes=await fs.readFile(file);assert.equal(bytes.byteLength,ref.bytes);assert.equal(sha(bytes),ref.sha256);
  assert.equal((await fs.stat(file)).nlink,1);if(process.platform!=='win32')assert.equal((await fs.stat(file)).mode&0o777,0o600);
  assert.deepEqual((await f.store.get(f.req,account('alice'),ref)).snapshot,rows[0].snapshot);
  assert.deepEqual((await f.service.preserve(f.req,input(rows))).reference,ref);assert.equal((await fs.readdir(f.archive)).length,1);
  assert.deepEqual(await fs.readFile(f.file),before);
  rows[0].snapshot=recipe('edited');await f.write(rows);const newer=await f.service.preserve(f.req,input(rows));assert.notEqual(newer.reference.id,ref.id);
  assert.deepEqual(await fs.readFile(file),bytes);assert.equal((await fs.readdir(f.archive)).length,2);
});

test('a saved server reference can be read from a fresh service and follows an explicitly copied chat record within the same account',async t=>{
  const f=await fixture(t),rows=[frame()];await f.write(rows);const saved=await f.service.preserve(f.req,input(rows));
  delete rows[0].snapshot;rows[0].snapshotServerRef=saved.reference;await f.write(rows);
  const fresh=createRecipeArchiveService({dataRoot:f.root});t.after(()=>fresh.close());
  const result=await fresh.read(f.req,input(rows));assert.equal(result.origin,'server-archive');assert.deepEqual(result.snapshot,recipe());
  const renamed={...target,chatId:'renamed'};await fs.copyFile(f.file,path.join(f.folder,'renamed.jsonl'));
  assert.deepEqual((await fresh.read(f.req,{...input(rows),target:renamed})).snapshot,recipe());
  assert.deepEqual((await fresh.preserve(f.req,input(rows))).reference,saved.reference);
});

test('archive references cannot be rebound to a different image or generation time',async t=>{
  const f=await fixture(t),rows=[frame()];await f.write(rows);const saved=await f.service.preserve(f.req,input(rows));delete rows[0].snapshot;rows[0].snapshotServerRef=saved.reference;
  for(const [field,value] of [['id','other'],['createdAt',2]]){
    const copy=structuredClone(rows);copy[0][field]=value;await f.write(copy);
    await assert.rejects(f.service.read(f.req,{...input(copy),selection:{...input(copy).selection,recordId:copy[0].id,createdAt:copy[0].createdAt}}),{code:'recipe_archive_source'});
  }
});

test('local-only references, missing recipes, unavailable markers and duplicates never authorize guessed recipes',async t=>{
  const f=await fixture(t);
  for(const row of [{id:'image',createdAt:1,snapshotRef:'legacy-local'},{id:'image',createdAt:1},{...frame(),recipeUnavailable:true}]){
    const rows=[row];await f.write(rows);await assert.rejects(f.service.preserve(f.req,input(rows)),{code:'recipe_archive_missing'});
  }
  const rows=[frame(),frame()];await f.write(rows);await assert.rejects(f.service.preserve(f.req,input(rows)),{code:'recipe_archive_source'});
  await assert.rejects(fs.stat(f.archive),{code:'ENOENT'});
});

test('authentication, exact gallery digest and cancellation precede archive creation',async t=>{
  const f=await fixture(t),rows=[frame()];await f.write(rows);
  for(const request of [{}, {...f.req,user:{...f.req.user,profile:{handle:'bob'}}}])await assert.rejects(f.service.preserve(request,input(rows)));
  await assert.rejects(f.service.preserve(f.req,{...input(rows),selection:{...input(rows).selection,gallerySha256:'0'.repeat(64)}}),{code:'recipe_archive_source'});
  const abort=new AbortController();abort.abort();await assert.rejects(f.service.preserve(f.req,input(rows),{signal:abort.signal}),{code:'recipe_archive_changed'});
  const secret=[{...frame(),snapshot:{...recipe(),apiKey:'PRIVATE'}}];await f.write(secret);await assert.rejects(f.service.preserve(f.req,input(secret)),{code:'recipe_archive_credentials'});
  await assert.rejects(fs.stat(f.archive),{code:'ENOENT'});
});

test('wrong-account archive files and corruption are rejected without overwriting old data',async t=>{
  const f=await fixture(t),rows=[frame()];await f.write(rows);const {reference}=await f.service.preserve(f.req,input(rows));
  const bob=path.join(f.root,'bob');await fs.mkdir(path.join(bob,'.qianmu-recipes-v1'),{recursive:true});
  await fs.copyFile(path.join(f.archive,reference.id+'.json'),path.join(bob,'.qianmu-recipes-v1',reference.id+'.json'));
  const req={user:{profile:{handle:'bob'},directories:{root:bob}}};await assert.rejects(f.store.get(req,account('bob'),reference),{code:'recipe_archive_corrupt'});
  const file=path.join(f.archive,reference.id+'.json');await fs.writeFile(file,'x'.repeat(reference.bytes));const bad=await fs.readFile(file);
  await assert.rejects(f.store.get(f.req,account('alice'),reference),{code:'recipe_archive_corrupt'});
  const retry=await f.service.preserve(f.req,input(rows));assert.notEqual(retry.reference.id,reference.id);assert.deepEqual(await fs.readFile(file),bad);
});

test('hard-linked archives and linked directories are not read or written',async t=>{
  const f=await fixture(t),rows=[frame()];await f.write(rows);const {reference}=await f.service.preserve(f.req,input(rows));
  const file=path.join(f.archive,reference.id+'.json');await fs.link(file,path.join(f.root,'linked-copy'));
  await assert.rejects(f.store.get(f.req,account('alice'),reference),{code:'recipe_archive_corrupt'});
  await assert.rejects(f.service.preserve(f.req,input(rows)),{code:'recipe_archive_path'});
  const other=await fixture(t);await other.write(rows);const outside=path.join(other.root,'outside');await fs.mkdir(outside);
  await fs.symlink(outside,other.archive,process.platform==='win32'?'junction':'dir');
  await assert.rejects(other.service.preserve(other.req,input(rows)),{code:'recipe_archive_path'});assert.deepEqual(await fs.readdir(outside),[]);
});

test('interrupted writes never acknowledge a reference and retries preserve partial files without overwriting',async t=>{
  let failWrite=true;
  const io={...fs,open:async(file,...args)=>{const handle=await fs.open(file,...args);if(args[0]==='wx'&&file.includes('.qianmu-recipes-v1')){
    const write=handle.writeFile.bind(handle);handle.writeFile=async text=>{if(failWrite){await write(text.slice(0,13));throw Error('synthetic disk full');}return write(text);};
  }return handle;}};
  const f=await fixture(t,{io}),rows=[frame()];await f.write(rows);const before=await fs.readFile(f.file);
  await assert.rejects(f.service.preserve(f.req,input(rows)),{code:'recipe_archive_storage'});
  const [partial]=await fs.readdir(f.archive),bytes=await fs.readFile(path.join(f.archive,partial));assert.equal(bytes.length,13);
  failWrite=false;const saved=await f.service.preserve(f.req,input(rows));assert.notEqual(saved.reference.id+'.json',partial);
  assert.deepEqual(await fs.readFile(path.join(f.archive,partial)),bytes);assert.deepEqual(await fs.readFile(f.file),before);
});

test('source changes while saving prevent receipt adoption even when an immutable orphan was durably written',async t=>{
  let change,fired=false;
  const io={...fs,open:async(file,...args)=>{const handle=await fs.open(file,...args);if(args[0]==='wx'&&file.includes('.qianmu-recipes-v1')){
    const sync=handle.sync.bind(handle);handle.sync=async()=>{await sync();if(!fired){fired=true;await change();}};
  }return handle;}};
  const f=await fixture(t,{io}),rows=[frame()];await f.write(rows);change=()=>f.write([{...frame(),snapshot:recipe('changed during save')}]);
  await assert.rejects(f.service.preserve(f.req,input(rows)),{code:'recipe_archive_source'});assert.equal((await fs.readdir(f.archive)).length,1);
});

test('concurrent same-account writes are bounded and do not overwrite acknowledged archives',async t=>{
  const gate=deferred(),entered=deferred();
  const io={...fs,open:async(file,...args)=>{const handle=await fs.open(file,...args);if(args[0]==='wx'&&file.includes('.qianmu-recipes-v1')){
    const write=handle.writeFile.bind(handle);handle.writeFile=async text=>{entered.resolve();await gate.promise;return write(text);};
  }return handle;}};
  const f=await fixture(t,{io}),pending=f.store.put(f.req,envelope(recipe()));await entered.promise;
  await assert.rejects(f.store.put(f.req,envelope(recipe('another'))),{code:'recipe_archive_busy'});gate.resolve();const ref=await pending;
  assert.deepEqual((await f.store.get(f.req,account('alice'),ref)).snapshot,recipe());
});

test('account, directory changes and cancellation during durable writes cannot acknowledge a usable recipe reference',async t=>{
  for(const mode of ['account','abort','directory','chatRoot']){
    let change;
    const io={...fs,open:async(file,...args)=>{const handle=await fs.open(file,...args);if(args[0]==='wx'&&file.includes('.qianmu-recipes-v1')){
      const sync=handle.sync.bind(handle);handle.sync=async()=>{await sync();change();};
    }return handle;}};
    const f=await fixture(t,{io}),rows=[frame()],abort=new AbortController();await f.write(rows);const before=await fs.readFile(f.file);
    change=()=>{if(mode==='account')f.req.user.profile.handle='bob';else if(mode==='directory')f.req.user.directories.root=path.join(f.root,'changed');
      else if(mode==='chatRoot')f.req.user.directories.chats=path.join(f.root,'changed-chats');else abort.abort();};
    await assert.rejects(f.service.preserve(f.req,input(rows),{signal:abort.signal}),{code:'recipe_archive_changed'});
    assert.deepEqual(await fs.readFile(f.file),before);
  }
});

test('observed directory count and byte limits refuse new archive writes instead of pruning existing files',async t=>{
  for(const mode of ['count','bytes']){
    const rows=mode==='count'?RECIPE_ARCHIVE_LIMITS.files:1;
    const io={...fs,opendir:async folder=>folder.endsWith('.qianmu-recipes-v1')?{async *[Symbol.asyncIterator](){for(let i=0;i<rows;i++)yield {name:'capacity-'+i};}}:fs.opendir(folder),
      lstat:async(file,options)=>path.basename(file).startsWith('capacity-')?{isFile:()=>true,isSymbolicLink:()=>false,nlink:1n,size:mode==='bytes'?BigInt(RECIPE_ARCHIVE_LIMITS.totalBytes):0n}:fs.lstat(file,options)};
    const f=await fixture(t,{io});await assert.rejects(f.store.put(f.req,envelope(recipe())),{code:'recipe_archive_capacity'});
    assert.deepEqual(await fs.readdir(f.archive),[]);
  }
});

test('group sources use their exact saved group-chat file and do not resolve a same-named character recipe',async t=>{
  const f=await fixture(t),character=[frame()],group=[{...frame(),snapshot:recipe('group source')}];await f.write(character);
  await fs.writeFile(path.join(f.groups,'chat.jsonl'),JSON.stringify({chat_metadata:{story_director_liminale:{storyboardImages:group}}})+'\n');
  const request={...input(group),target:{kind:'group',chatId:'chat'}};
  const saved=await f.service.preserve(f.req,request),archived=await f.store.get(f.req,account('alice'),saved.reference);
  assert.equal(archived.snapshot.prompt,'group source');assert.equal(archived.source.target.kind,'group');
  assert.equal((await f.service.read(f.req,input(character))).snapshot.prompt,recipe().prompt);
});

test('actual plugin routes authenticate, refuse client payloads and return no-store lossless source without changing the chat',async t=>{
  const f=await fixture(t),rows=[frame()];await f.write(rows);const before=await fs.readFile(f.file),routes=new Map();
  await init({get:(name,handler)=>routes.set('GET '+name,handler),post:(name,handler)=>routes.set('POST '+name,handler)},{dataRoot:f.root});t.after(()=>exit());
  const server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);req.body=JSON.parse(Buffer.concat(chunks).toString()||'{}');
    if(req.headers['x-fixture-user']==='alice')req.user=f.req.user;
    res.set=(key,value)=>{res.setHeader(key,value);return res;};res.status=code=>{res.statusCode=code;return res;};res.json=body=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body));return res;};
    await routes.get('POST '+req.url)(req,res);
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const request=async(action,body=input(rows),auth=true)=>fetch('http://127.0.0.1:'+server.address().port+'/chat-gallery/recipe/'+action,
    {method:'POST',headers:{'content-type':'application/json',...(auth?{'x-fixture-user':'alice'}:{})},body:JSON.stringify(body)});
  assert.equal((await request('preserve',input(rows),false)).status,401);
  assert.notEqual((await request('preserve',{...input(rows),snapshot:recipe('forged')})).status,200);
  const saved=await request('preserve');assert.equal(saved.status,200);assert.equal(saved.headers.get('cache-control'),'no-store');assert.equal(saved.headers.get('x-content-type-options'),'nosniff');
  const proof=await saved.json();assert.equal(proof.proof,'durable-recipe');assert.equal(proof.snapshot,undefined);
  delete rows[0].snapshot;rows[0].snapshotServerRef=proof.reference;await f.write(rows);
  const read=await request('read');assert.equal(read.status,200);assert.deepEqual((await read.json()).snapshot,recipe());
  assert.match(before.toString(),/PRIVATE_BODY/);assert.match((await fs.readFile(f.file)).toString(),/PRIVATE_BODY/);
});
