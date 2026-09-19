import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createAccountDocumentFiles} from '../qianmu-account-document-files.js';

const options=root=>({root,filename:'.collection.json',lockname:'.collection.lock',temporaryPrefix:'.collection-write-',bytes:1024,label:'收藏',
  errorFactory:(code,message,status=409)=>Object.assign(new Error(message),{code:`fixture_${code}`,status}),empty:()=>({records:[]}),
  validate(raw){const {checksum,...state}=raw;assert.equal(checksum,createHash('sha256').update(JSON.stringify(state)).digest('hex'));return state;}});
async function fixture(t){
  const parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'qianmu-account-document-')),folder=path.join(root,'user');await fs.mkdir(folder);
  t.after(async()=>{const real=await fs.realpath(root);assert.equal(path.dirname(real),parent);assert.match(path.basename(real),/^qianmu-account-document-/);await fs.rm(real,{recursive:true});});
  return {root,folder,context:{folder,roots:new Map(),writeState:'not_started',guard(){}}};
}
test('shared engine accepts only fixed local filenames and a bounded trusted data directory',async t=>{
  const f=await fixture(t),base=options(f.root);
  for(const patch of [{root:path.parse(f.root).root},{root:'relative'},{filename:'../escape'},{lockname:'other/lock'},
    {temporaryPrefix:'../../'},{filename:base.lockname},{bytes:Infinity},{processStatus:3}])assert.throws(()=>createAccountDocumentFiles({...base,...patch}),TypeError);
  const storage=createAccountDocumentFiles(base);
  for(const folder of [f.root,path.join(f.root,'..','outside'),'relative'])await assert.rejects(storage.read({...f.context,folder}),{code:'fixture_path',status:403});
  assert.deepEqual(await fs.readdir(f.folder),[]);
});
test('a second schema shares atomic transactions without creating or changing any notes file',async t=>{
  const f=await fixture(t),storage=createAccountDocumentFiles(options(f.root));
  const before=await storage.read(f.context);assert.deepEqual(before,{state:{records:[]},fingerprint:null});assert.deepEqual(await fs.readdir(f.folder),[]);
  await storage.exclusive(f.context,()=>storage.writeAtomic(f.context,{records:['plain collection']},before.fingerprint));
  const reread=await createAccountDocumentFiles(options(f.root)).read({...f.context,roots:new Map()});
  assert.deepEqual(reread.state,{records:['plain collection']});assert.deepEqual(await fs.readdir(f.folder),['.collection.json']);
});
test('capacity and replaced-file errors are labeled for the caller and preserve the previous complete data',async t=>{
  const f=await fixture(t),storage=createAccountDocumentFiles(options(f.root)),first={records:['original']};
  await storage.exclusive(f.context,()=>storage.writeAtomic(f.context,first,null));
  const prior=await storage.read(f.context),original=await fs.readFile(path.join(f.folder,'.collection.json'));
  await assert.rejects(storage.exclusive(f.context,()=>storage.writeAtomic(f.context,{records:['x'.repeat(1500)]},prior.fingerprint)),error=>error.code==='fixture_capacity'&&error.message.includes('收藏')&&!error.message.includes('便笺'));
  assert.deepEqual(await fs.readFile(path.join(f.folder,'.collection.json')),original);
  await assert.rejects(storage.exclusive(f.context,()=>storage.writeAtomic(f.context,{records:['replacement']},null)),{code:'fixture_changed'});
  assert.deepEqual(await fs.readFile(path.join(f.folder,'.collection.json')),original);assert.deepEqual(await fs.readdir(f.folder),['.collection.json']);
});
