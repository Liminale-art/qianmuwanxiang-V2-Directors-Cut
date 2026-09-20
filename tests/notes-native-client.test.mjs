import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import {createStAccountStorage} from '../qianmu-st-account-storage.js';
import {createNotesNativeClient} from '../qianmu-notes-native-client.js';
import {createNotesSyncRuntime} from '../qianmu-notes-sync-runtime.js';
import {emptyNotesLocalState,validateNotesLocalState} from '../qianmu-notes-sync-store.js';

const namespace='st-user:notes-fixture',expectedAccount='st-user:'+createHash('sha256').update('notes-fixture').digest('hex');
const note=(id='note-1',body='内容',revision=1)=>({id,title:'便笺',body,pinned:false,createdAt:10,updatedAt:20,revision,deleted:false});
const request=(text='内容',extra={})=>({id:'note-1',baseRevision:0,note:{title:'便笺',body:text,pinned:false,createdAt:10},deleted:false,mutationId:'mutation-0001',...extra});
const response=(value,status=200)=>new Response(typeof value==='string'?value:JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
function fixture({legacyStatus=404,legacyNotes=[],legacyAccount=expectedAccount}={}){
  const files=new Map(),calls=[];let current=true;
  const fetchImpl=async(url,options)=>{
    const path=new URL(url,'https://st.fixture.invalid').pathname;calls.push({path,options});
    if(path==='/api/plugins/qianmu-tts/notes'){
      assert.equal(options.method,'GET','the old backend is read only during migration');
      return response({ok:true,version:1,expectedAccount:legacyAccount,revision:Math.max(0,...legacyNotes.map(n=>n.revision)),notes:legacyNotes},legacyStatus);
    }
    if(path==='/api/files/upload'){const {name,data}=JSON.parse(options.body);files.set(name,Buffer.from(data,'base64').toString('utf8'));return response({path:`/user/files/${name}`});}
    const name=path.split('/').at(-1);return files.has(name)?response(files.get(name)):response({},404);
  };
  async function open(){
    const store=await createStAccountStorage({resolveNamespace:async()=>namespace,isCurrent:()=>current,headers:()=>({}),fetchImpl,origin:'https://st.fixture.invalid',cryptoImpl:webcrypto});
    const client=await createNotesNativeClient({namespace,headers:()=>({}),guard:()=>current,store,fetchImpl,now:()=>30});
    return {store,client,close(){client.close();store.close();}};
  }
  return {files,calls,open,setCurrent(value){current=value;}};
}

test('new notes use native account storage without a plugin backend or a manual migration action',async()=>{
  const f=fixture(),first=await f.open();assert.deepEqual((await first.client.list()).notes,[]);
  const saved=await first.client.write(request());assert.equal(saved.note.body,'内容');assert.equal(saved.revision,1);first.close();
  const second=await f.open();assert.equal((await second.client.list()).notes[0].body,'内容');
  assert.equal(f.calls.filter(c=>c.path.includes('/plugins/')).length,1);assert.equal(second.client.concurrency,'optimistic-non-cas');second.close();
});

test('legacy notes migrate once without deletion, retain global revisions and continue in native files',async()=>{
  const original=note('note-1','旧便笺',7),f=fixture({legacyStatus:200,legacyNotes:[original]}),first=await f.open();
  assert.deepEqual((await first.client.list()).notes,[original]);
  const changed=await first.client.write(request('新内容',{baseRevision:7}));assert.equal(changed.revision,8);assert.equal(changed.note.createdAt,10);first.close();
  const second=await f.open();assert.equal((await second.client.list()).notes[0].body,'新内容');
  assert.equal(f.calls.filter(c=>c.path.includes('/plugins/')).length,1);assert.equal(original.body,'旧便笺');assert.ok(f.files.size>=3);second.close();
});

test('migration only treats HTTP 404 as absent; auth, unsupported, offline or foreign data cannot create an empty replacement',async()=>{
  for(const legacyStatus of [401,403,405,500,501]){
    const f=fixture({legacyStatus}),session=await f.open();await assert.rejects(session.client.list());assert.equal(f.files.size,0);session.close();
  }
  const f=fixture({legacyStatus:200,legacyNotes:[note()],legacyAccount:'st-user:'+'b'.repeat(64)}),session=await f.open();
  await assert.rejects(session.client.list(),{code:'notes_sync_account'});assert.equal(f.files.size,0);session.close();
});

test('same mutation retry is idempotent, different payload cannot reuse its identity, stale edit returns a conflict',async()=>{
  const f=fixture(),session=await f.open(),a=await session.client.write(request());
  const count=f.calls.filter(c=>c.options.method==='POST').length;assert.deepEqual(await session.client.write(request()),a);
  assert.equal(f.calls.filter(c=>c.options.method==='POST').length,count);
  await assert.rejects(session.client.write(request('other')),{code:'notes_sync_mutation_conflict'});
  const conflict=await session.client.write(request('other',{mutationId:'mutation-0002'}));assert.equal(conflict.ok,false);assert.equal(conflict.note.body,'内容');
  const deleted=await session.client.write(request('内容',{baseRevision:1,deleted:true,mutationId:'mutation-0003'}));assert.equal(deleted.note.deleted,true);assert.equal(deleted.note.body,'');session.close();
});

test('legacy and native account boundaries stay active after awaiting the transport',async()=>{
  const f=fixture(),session=await f.open();f.setCurrent(false);
  await assert.rejects(session.client.write(request()));assert.equal(f.calls.length,0);session.close();
});

test('existing local note runtime automatically drains to native files and a second device reads content, not geometry',async()=>{
  function memoryStore(){let state=emptyNotesLocalState(namespace);return {async read(){return structuredClone(state);},async update(_namespace,work){const next=structuredClone(state);work(next);validateNotesLocalState(next,namespace);state=next;return structuredClone(state);},close(){}};}
  const f=fixture(),a=await f.open(),b=await f.open();let seq=0;const uid=()=>`native-${String(++seq).padStart(8,'0')}`;
  const local=createNotesSyncRuntime({namespace,store:memoryStore(),client:a.client,uid});
  await local.save({...note(),x:99,width:300,floating:true});await local.sync();assert.equal(local.status.pending,0);
  const other=createNotesSyncRuntime({namespace,store:memoryStore(),client:b.client,uid});await other.sync();
  const loaded=await other.list();assert.equal(loaded[0].body,'内容');assert.notEqual(loaded[0].x,99);assert.notEqual(loaded[0].floating,true);
  assert.ok([...f.files.values()].every(text=>!text.includes('"floating"')));local.close();other.close();a.close();b.close();
});
