import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createVibeRestoreOperations} from '../qianmu-vibe-restore.js';
import {createVibeStorageActions} from '../qianmu-vibe-storage.js';
import {createVibeAssetOperations} from '../qianmu-vibe-assets-worker.js';
import {parseNovelVibeFile,vibeDigest,vibeFilePreview} from '../qianmu-vibe-file.js';
const namespace='st-user:restore',png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';
const encoding=btoa('encoded');
async function fixture(){return {identifier:'novelai-vibe-transfer',version:1,type:'image',id:await vibeDigest(png),image:png,name:'Original',thumbnail:`data:image/png;base64,${png}`,
  encodings:{futuremodel:{custom:{encoding,params:{information_extracted:0,focus_seed:0}}},v4full:{first:{encoding,params:{information_extracted:1}}}},importInfo:{strength:0,information_extracted:0}};}
const blob=docs=>new Blob([JSON.stringify(docs.length===1?docs[0]:{identifier:'novelai-vibe-transfer-bundle',version:1,vibes:docs})]);
const proof=plan=>({fingerprint:plan.fingerprint,localFingerprint:plan.localFingerprint});
function environment(initial=[]){
  const files=new Map(initial.map(asset=>[asset.assetId,asset])),calls=[];let countExtra=0,byteExtra=0;
  const store={inventory:async ns=>{assert.equal(ns,namespace);const heads=[...files.values()].map(a=>({namespace,assetId:a.assetId,bytes:a.bytes,previewBytes:vibeFilePreview(a.document)?.size||0,summary:a.summary}));
    return {heads:[...heads,...Array.from({length:countExtra},()=>({assetId:'extra'}))],usage:{count:heads.length+countExtra,bytes:heads.reduce((sum,h)=>sum+h.bytes,0)+byteExtra,previewBytes:heads.reduce((sum,h)=>sum+h.previewBytes,0),limit:512*1048576}};},
    load:async(ns,id)=>{assert.equal(ns,namespace);calls.push(['load',id]);return files.get(id)||null;},
    putFile:async(ns,text)=>{assert.equal(ns,namespace);calls.push(['put',text]);const parsed=await parseNovelVibeFile(text);parsed.forEach(asset=>{if(!files.has(asset.assetId))files.set(asset.assetId,asset);});return parsed;}};
  return {store,files,calls,ops:createVibeRestoreOperations({store}),capacity:(count,bytes=0)=>{countExtra=count;byteExtra=bytes;}};
}

test('restore inspection validates all original bytes and preserves exact IDs without writing or returning media to UI',async()=>{
  const doc=await fixture(),[existing]=await parseNovelVibeFile(JSON.stringify(doc)),other={...doc,name:'Another'},file=blob([doc,other,doc]),e=environment([existing]);
  const plan=await e.ops.inspect(namespace,file);assert.equal(plan.rows.length,2);assert.equal(plan.duplicateCount,1);assert.equal(plan.existingCount,1);assert.equal(plan.missingCount,1);
  assert.equal(plan.rows[0].id,existing.assetId);assert.ok(plan.neededBytes>0);assert.equal(plan.fits,true);assert.deepEqual(e.calls,[['load',existing.assetId]]);
  assert.ok(!JSON.stringify(plan).includes(png));assert.ok(!JSON.stringify(plan).includes(encoding));
  const result=await e.ops.restore(namespace,file,proof(plan),true);assert.equal(result.restored,1);assert.equal(result.existing,1);assert.equal(e.calls.filter(c=>c[0]==='put').length,1);
  const restored=e.files.get(plan.rows[1].id);assert.deepEqual(restored.document,other);assert.deepEqual(restored.document.encodings,doc.encodings);assert.equal(restored.document.importInfo.strength,0);
  assert.equal(e.files.get(existing.assetId),existing,'test store behavior is verified by the real IDB browser test');
});

test('an already complete backup is a verified no-op, not a new library entry or request',async()=>{
  const doc=await fixture(),[asset]=await parseNovelVibeFile(JSON.stringify(doc)),e=environment([asset]),file=blob([doc]),plan=await e.ops.inspect(namespace,file);
  assert.equal(plan.missingCount,0);assert.equal(plan.neededBytes,0);assert.deepEqual(await e.ops.restore(namespace,file,proof(plan),true),{restored:0,existing:1,ids:[asset.assetId]});assert.equal(e.calls.some(c=>c[0]==='put'),false);
});

test('pure encoding original order and unknown IE are restored without inventing an image or default',async()=>{
  const doc={identifier:'novelai-vibe-transfer',version:1,type:'encoding',id:await vibeDigest(encoding),encodings:{zfuture:{unknown:{encoding}},v4full:{fixed:{encoding,params:{information_extracted:0}}}}},e=environment(),file=blob([doc]),plan=await e.ops.inspect(namespace,file);
  assert.equal(plan.rows[0].type,'encoding');assert.equal(plan.rows[0].previewBytes,0);await e.ops.restore(namespace,file,proof(plan),true);
  assert.deepEqual(e.files.get(plan.rows[0].id).document,doc);
});

test('invalid, corrupt, repeated-key or oversized backup input never opens storage or writes partial assets',async()=>{
  const e=environment(),doc=await fixture();e.store.inventory=async()=>assert.fail('invalid file must not read local inventory');
  const valid=JSON.stringify(doc);
  for(const file of [null,new Blob([]),new Blob(['{}']),new Blob(['{']),new Blob([valid.replace('"version":1','"version":1,"version":1')]),blob([doc,{...doc,id:'0'.repeat(64)}]),blob(Array(17).fill(doc)),
    new Blob([' '.repeat(64*1048576+1)])])await assert.rejects(()=>e.ops.inspect(namespace,file));
  assert.equal(e.calls.length,0);await assert.rejects(()=>e.ops.inspect('wrong',blob([doc])));
});

test('original local corruption, namespace mismatch and changing inventory reject inspection without overwriting',async()=>{
  const doc=await fixture(),[asset]=await parseNovelVibeFile(JSON.stringify(doc)),file=blob([doc]);
  for(const change of [e=>e.store.load=async()=>null,e=>e.store.load=async()=>({...asset,serialized:'changed'}),e=>e.store.load=async()=>{throw Error('broken');},
    e=>{const inv=e.store.inventory;e.store.inventory=async ns=>{const result=await inv(ns);result.heads[0].namespace='st-user:other';return result;};},
    e=>{const inv=e.store.inventory;let times=0;e.store.inventory=async ns=>{const result=await inv(ns);if(++times>1)result.usage.bytes++;return result;};}]){
    const e=environment([asset]);change(e);await assert.rejects(()=>e.ops.inspect(namespace,file));assert.equal(e.calls.some(c=>c[0]==='put'),false);
  }
});

test('capacity includes thumbnails and asset counts; overfull restore is entirely refused',async()=>{
  const doc=await fixture(),file=blob([doc]);
  for(const [count,bytes] of [[1024,0],[0,512*1048576-1]]){const e=environment();e.capacity(count,bytes);const plan=await e.ops.inspect(namespace,file);assert.equal(plan.fits,false);
    await assert.rejects(()=>e.ops.restore(namespace,file,proof(plan),true),/不足/);assert.equal(e.calls.some(c=>c[0]==='put'),false);}
});

test('strict consent plus unchanged file and inventory proof are required before the sole transaction',async()=>{
  const doc=await fixture(),file=blob([doc]),e=environment(),plan=await e.ops.inspect(namespace,file);
  for(const yes of [false,1,'true',undefined])await assert.rejects(()=>e.ops.restore(namespace,file,proof(plan),yes),/确认/);
  await assert.rejects(()=>e.ops.restore(namespace,file,{},true),/确认/);
  await assert.rejects(()=>e.ops.restore(namespace,blob([{...doc,name:'modified'}]),proof(plan),true),/已变化/);
  e.capacity(1);await assert.rejects(()=>e.ops.restore(namespace,file,proof(plan),true),/已变化/);assert.equal(e.calls.some(c=>c[0]==='put'),false);
});

test('transaction errors are not converted into successful or partial restore acknowledgements',async()=>{
  const doc=await fixture(),file=blob([doc]),e=environment(),plan=await e.ops.inspect(namespace,file);e.store.putFile=async()=>{throw Error('quota transaction rolled back');};
  await assert.rejects(()=>e.ops.restore(namespace,file,proof(plan),true),/rolled back/);assert.equal(e.files.size,0);
  e.store.putFile=async()=>[];await assert.rejects(()=>e.ops.restore(namespace,file,proof(plan),true),/未确认/);
});

test('actual worker restore path has no access to fee stores, generation or remote APIs',async()=>{
  const e=environment(),file=blob([await fixture()]),run=createVibeAssetOperations(e.store,{encodings:new Proxy({},{get:()=>assert.fail('fee access')}),locks:{request:()=>assert.fail('generation')}});
  const plan=await run({type:'restore-inspect',namespace,file});await run({type:'restore-originals',namespace,file,proof:proof(plan),confirmed:true});assert.equal(e.files.size,1);
});

test('UI actions guard account changes, strict confirmation, and freeze file/proof across awaited confirmation',async()=>{
  const e=environment(),file=blob([await fixture()]),plan=await e.ops.inspect(namespace,file),calls=[];let live=true;
  const actions=createVibeStorageActions({namespace,guard:async()=>{if(!live)throw Error('account changed');},call:async(type,args)=>{calls.push([type,args]);return type==='restore-inspect'?plan:{restored:1};}});
  assert.equal(await actions.inspectRestore(file),plan);
  for(const yes of [false,undefined,1,'true'])assert.equal(await actions.restore(plan,file,async()=>yes),null);assert.equal(calls.length,1);
  await assert.rejects(()=>actions.restore({...plan,namespace:'st-user:other'},file,async()=>assert.fail('foreign')));
  await assert.rejects(()=>actions.restore(plan,file,async()=>{live=false;return true;}),/account changed/);live=true;
  const expected=proof(plan);await actions.restore(plan,file,async(title,text)=>{assert.match(text,/不更改库条目/);plan.fingerprint='f'.repeat(64);return true;});
  assert.deepEqual(calls.at(-1),['restore-originals',{namespace,file,proof:expected,confirmed:true}]);
});

test('file-space recovery outlet and module ship without private development material or eager imports',async()=>{
  const release=JSON.parse(await readFile(new URL('../release-files.json',import.meta.url)));assert.ok(release.files.includes('qianmu-vibe-restore.js'));
  const worker=await readFile(new URL('../qianmu-vibe-assets-worker.js',import.meta.url),'utf8'),ui=await readFile(new URL('../qianmu-vibe-storage.js',import.meta.url),'utf8');
  assert.match(worker,/await import\('\.\/qianmu-vibe-restore.js'\)/);assert.match(ui,/sd-vibe-restore-open/);
});
