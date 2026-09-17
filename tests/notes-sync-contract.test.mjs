import test from 'node:test';
import assert from 'node:assert/strict';
import {NOTES_SYNC_LIMITS,notesSyncMutationId,notesSyncNoteInput,notesSyncRecord,notesSyncWriteRequest,notesSyncListResponse,notesSyncWriteResponse,notesSyncConflictResponse,notesSyncErrorPayload} from '../qianmu-notes-sync-contract.js';

const expectedAccount='st-user:'+'a'.repeat(64);
const note=()=>({title:'  标题  ',body:'正文\n第二行\t😄',pinned:false,createdAt:1});
const row=()=>({id:'便笺一',...note(),updatedAt:2,revision:1,deleted:false});
const input=()=>({version:1,expectedAccount,id:'便笺一',baseRevision:0,note:note(),deleted:false,mutationId:'mutation-0001'});

test('plain originals are preserved exactly, pinned is independent from persistence, and geometry is rejected',()=>{
  assert.deepEqual(notesSyncWriteRequest(input()),input());assert.deepEqual(notesSyncNoteInput(note()),note());assert.deepEqual(notesSyncRecord(row()),row());
  assert.equal(notesSyncNoteInput({...note(),body:'😄'.repeat(20000)}).body.length,40000);
  for(const field of ['x','y','width','height','floating','minimized','zOrder','account','path','namespace','token']){
    assert.throws(()=>notesSyncNoteInput({...note(),[field]:'forbidden'}));assert.throws(()=>notesSyncWriteRequest({...input(),[field]:'forbidden'}));
  }
});
test('limits reject whole requests without trimming, coercion or silent truncation',()=>{
  for(const patch of [{title:'x'.repeat(121)},{body:'x'.repeat(20001)},{body:'bad\0text'},{body:'\ud800'},{createdAt:-1},{createdAt:NaN},{pinned:1},{body:2}])assert.throws(()=>notesSyncNoteInput({...note(),...patch}));
  for(const patch of [{id:''},{id:' bad'},{id:'bad\nname'},{id:'x'.repeat(121)},{id:'\udfff'},{version:2},{expectedAccount:'st-user:alice'},{baseRevision:-1},{baseRevision:0.1},{deleted:'yes'},{note:null}])assert.throws(()=>notesSyncWriteRequest({...input(),...patch}));
  for(const value of ['short','../path/name','with whitespace','x'.repeat(121),1])assert.throws(()=>notesSyncMutationId(value));
  assert.equal(notesSyncMutationId('a'.repeat(120)),'a'.repeat(120));
});
test('tombstones cannot contain original text, remain versioned and are not deleted from the full directory',()=>{
  const deleted={...row(),title:'',body:'',pinned:false,deleted:true};
  assert.deepEqual(notesSyncRecord(deleted),deleted);
  for(const patch of [{title:'old'},{body:'old'},{pinned:true},{revision:0}])assert.throws(()=>notesSyncRecord({...deleted,...patch}));
  assert.throws(()=>notesSyncWriteRequest({...input(),deleted:true}));
  assert.equal(notesSyncWriteRequest({...input(),baseRevision:1,deleted:true}).deleted,true);
  assert.deepEqual(notesSyncListResponse({ok:true,version:1,expectedAccount,revision:1,notes:[deleted]}).notes,[deleted]);
});
test('full directory validates every row, duplicate identities, future revisions and bounded record counts',()=>{
  const result={ok:true,version:1,expectedAccount,revision:1,notes:[row()]};assert.deepEqual(notesSyncListResponse(result),result);
  for(const patch of [{notes:[row(),row()]},{revision:0},{notes:[{...row(),geometry:{}}]},{notes:Array(NOTES_SYNC_LIMITS.notes+1).fill(row())},{root:'/server'},{expectedAccount:'user'},{ok:false}])assert.throws(()=>notesSyncListResponse({...result,...patch}));
  assert.deepEqual(notesSyncListResponse({...result,revision:0,notes:[]}).notes,[]);
});
test('write acknowledgements and conflicts have exact distinct shapes and errors never expose private paths',()=>{
  const ack={ok:true,version:1,expectedAccount,revision:1,note:row()};assert.deepEqual(notesSyncWriteResponse(ack),ack);
  assert.throws(()=>notesSyncWriteResponse({...ack,revision:2}));assert.throws(()=>notesSyncWriteResponse({...ack,extras:1}));
  const conflict={ok:false,version:1,code:'notes_sync_conflict',message:'changed',writeState:'not_started',expectedAccount,revision:2,note:row()};
  assert.deepEqual(notesSyncConflictResponse(conflict),conflict);assert.equal(notesSyncConflictResponse({...conflict,note:null}).note,null);
  for(const patch of [{revision:0},{writeState:'unconfirmed'},{code:'other'},{note:{...row(),body:4}}])assert.throws(()=>notesSyncConflictResponse({...conflict,...patch}));
  const hidden=notesSyncErrorPayload(Object.assign(Error('C:/private/secret'),{writeState:'unconfirmed'}));assert.equal(hidden.status,503);assert.equal(hidden.body.writeState,'unconfirmed');assert.doesNotMatch(JSON.stringify(hidden),/private|secret/);
});
