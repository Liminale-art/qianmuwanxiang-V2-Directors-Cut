import test from 'node:test';
import assert from 'node:assert/strict';
import {applyPreparedConfig} from '../qianmu-config-apply.js';
import {createConfigUndoSlot} from '../qianmu-config-undo.js';
import {createConfigUndoAction} from '../qianmu-config-undo-action.js';
import {createStorageCleanupSession} from '../qianmu-storage-cleanup-session.js';
import {applyCoreadPackageData,finishCoreadPackageImport} from '../qianmu-reader-package.js';

// Real module coordination with in-memory originals, not a server persistence test.
function fixture(){
  const old={theme:'before',coread:{books:[{id:'book',title:'before',progress:5,hasCover:false}]}};
  let current=old;const host={settings:old},undo=createConfigUndoSlot(),state={transfer:false,saves:0,confirm:()=>true};
  const originals=new Map([['book',{fullText:'old original'}]]),notices=[];
  const activity=()=>({transfer:state.transfer}),save=()=>state.saves++,notify=(...args)=>notices.push(args);
  const options={host,slot:'settings',setCurrent:value=>{current=value;},save,layoutStorage:()=>null,layoutKey:'layout',afterApply(){},inject(){},render(){}};
  assert.equal(applyPreparedConfig({...options,owner:old,prepared:{theme:'imported',coread:{books:[]}},undo}).status,'applied');
  const undoRestore=createConfigUndoAction({undo,current:()=>current,activity,confirm:()=>state.confirm(),notify,applyOptions:()=>options});
  const cleanup=createStorageCleanupSession({owner:()=>current,scope:()=>1,epoch:()=>1,activity});
  const writer={async putBookWithCover(id,record){originals.set(id,structuredClone(record));}};
  async function restore(){
    const owner=current,reader=owner.coread;state.transfer=true;
    const check=()=>assert.equal(current,owner,'a replaced configuration must not receive old reader state');
    try{
      const progress=await applyCoreadPackageData({books:[{meta:{id:'book',title:'restored',progress:42},fullText:'new original'}]},
        {blobStore:writer,coread:()=>reader,isPlainObject:value=>!!value&&typeof value==='object'&&!Array.isArray(value),base64ToBlob:()=>assert.fail('no media in fixture'),check,onBookIndexed:save,warn(){}});
      finishCoreadPackageImport({reader,progress,hasPrefs:false,check,save,refresh(){},notify});return progress;
    }finally{state.transfer=false;}
  }
  return {current:()=>current,undo,undoRestore,cleanup,restore,writer,originals,state,notices};
}

test('a later reader restoration invalidates configuration undo without rolling back its original',async()=>{
  const f=fixture();assert.equal(f.undo.available(f.current()),true);
  assert.equal((await f.restore()).ok,1);const saves=f.state.saves;
  assert.equal((await f.undoRestore()).status,'stale');assert.equal(f.state.saves,saves);
  assert.equal(f.current().coread.books[0].progress,42);assert.equal(f.originals.get('book').fullText,'new original');
});

test('pending reader storage blocks both cleanup and configuration undo until the operation settles',async()=>{
  const f=fixture(),write=f.writer.putBookWithCover;let release;
  f.writer.putBookWithCover=async(...args)=>{await new Promise(resolve=>release=resolve);return write(...args);};
  const pending=f.restore();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.cleanup.begin({isConnected:true}),null);assert.equal((await f.undoRestore()).status,'blocked');
  assert.equal(f.originals.get('book').fullText,'old original');release();await pending;
  const token=f.cleanup.begin({isConnected:true});assert.ok(token);token.release();
  assert.equal((await f.undoRestore()).status,'stale');assert.equal(f.originals.get('book').meta.progress,42);
});

test('a reader write rejected before commit keeps the previous original and the unchanged configuration undo usable',async()=>{
  const f=fixture();f.writer.putBookWithCover=async()=>{throw Error('synthetic precommit failure');};
  const progress=await f.restore();assert.equal(progress.failed,1);assert.equal(progress.ok,0);
  assert.equal(f.undo.available(f.current()),true);const result=await f.undoRestore();
  assert.equal(result.status,'applied');assert.equal(result.persistence,'requested','host save scheduling is not durable acknowledgement');
  assert.equal(f.current().theme,'before');assert.equal(f.current().coread.books[0].progress,5);
  assert.deepEqual(f.originals.get('book'),{fullText:'old original'});
});

test('a confirmation opened before reader restoration cannot later erase the newly restored shelf',async()=>{
  const f=fixture();let approve;f.state.confirm=()=>new Promise(resolve=>approve=resolve);
  const pending=f.undoRestore();assert.equal(typeof approve,'function');await f.restore();approve(true);
  assert.equal((await pending).status,'stale');assert.equal(f.current().coread.books[0].progress,42);
  assert.equal(f.originals.get('book').fullText,'new original');
});
