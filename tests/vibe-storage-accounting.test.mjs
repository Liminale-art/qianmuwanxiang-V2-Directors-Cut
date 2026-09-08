import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeVibeAssetMetadata} from '../qianmu-vibe-storage-accounting.js';
import {validateVibeStorageSummary} from '../qianmu-vibe-storage-summary.js';
import {createVibeStorageOperations} from '../qianmu-vibe-storage.js';
const namespace='st-user:vibe-accounting',id='a'.repeat(64),key=JSON.stringify([namespace,id]),size=row=>Buffer.byteLength(JSON.stringify(row));
function fixture(){const head={key,namespace,assetId:id,bytes:1048576,previewBytes:69,summary:{name:'测试',type:'image',variants:[]}};
  return {heads:[head],usage:{key:namespace,count:1,bytes:head.bytes,previewBytes:69},documentKeys:[key],previewKeys:[key]};}
test('Vibe headers and record wrappers are counted without reading or re-escaping original file contents',()=>{
  const rows=fixture(),result=summarizeVibeAssetMetadata(namespace,rows);
  assert.equal(result.count,4);assert.equal(result.bytes,size(rows.heads[0])+size(rows.usage)+size({key,namespace,serialized:null})-4+size({key,namespace,blob:null})-4);
  assert.ok(result.bytes<2000);assert.doesNotMatch(JSON.stringify(result),/测试|serialized|data:image/);
});
test('fresh and emptied stores are distinct, and legacy absent preview counters are not synthesized into stored byte cost',()=>{
  const rows={heads:[],usage:undefined,documentKeys:[],previewKeys:[]};assert.deepEqual(summarizeVibeAssetMetadata(namespace,rows),{bytes:0,count:0});
  rows.usage={key:namespace,count:0,bytes:0};assert.deepEqual(summarizeVibeAssetMetadata(namespace,rows),{bytes:size(rows.usage),count:1});
  const old=fixture();delete old.usage.previewBytes;delete old.heads[0].previewBytes;old.previewKeys=[];
  const result=summarizeVibeAssetMetadata(namespace,old);assert.equal(result.count,3);assert.equal(result.bytes,size(old.heads[0])+size(old.usage)+size({key,namespace,serialized:null})-4);
});
test('missing and stray file or preview keys, missing counters, duplicate heads and alien account data refuse false complete totals',()=>{
  for(const change of [r=>r.documentKeys=[],r=>r.documentKeys.push('stray'),r=>r.previewKeys=[],r=>r.previewKeys.push('stray'),r=>r.usage=undefined,r=>r.usage.bytes++,r=>r.heads[0].namespace='other',r=>r.heads.push(r.heads[0]),r=>r.usage.count++,r=>r.usage.previewBytes++]){
    const rows=fixture();change(rows);assert.throws(()=>summarizeVibeAssetMetadata(namespace,rows),{code:'vibe_file_index'});
  }
});
test('Vibe summary v2 cannot present a v1 or incomplete metadata count as fully inventoried',()=>{
  const summary={version:2,status:'ready',namespace,bytes:30,assets:{bytes:10,count:1,originalCount:1,encodingCount:0},previews:{bytes:0,count:0},records:{bytes:10,count:1,archivedCount:0,pendingCount:1,reviewCount:0},metadata:{bytes:10,count:3,assetBytes:8,ledgerBytes:2}};
  assert.deepEqual(validateVibeStorageSummary(summary,namespace),summary);
  for(const change of [r=>r.version=1,r=>delete r.metadata,r=>r.metadata.bytes++,r=>r.metadata.count=3076,r=>r.metadata.body='private',r=>r.assets.body='large file',r=>r.receipts=[],r=>r.bytes--]){const copy=structuredClone(summary);change(copy);assert.throws(()=>validateVibeStorageSummary(copy,namespace));}
});
test('metadata changes invalidate an earlier cleanup confirmation and missing metadata never authorizes deletion',async()=>{
  let meta={bytes:10,count:4},clears=0;
  const store={inventory:async()=>({heads:fixture().heads,usage:{count:1,bytes:1048576,previewBytes:69,limit:512*1048576},metadata:meta}),remove:async()=>clears++};
  const encodings={inventory:async()=>({receipts:[],archived:{bytes:0,count:0},metadata:{bytes:0,count:0}})},locks={request:async(_name,_options,work)=>work({})};
  const ops=createVibeStorageOperations({store,encodings,locks}),snapshot=await ops.inventory(namespace);meta={bytes:11,count:4};
  await assert.rejects(ops.remove(namespace,[id],snapshot.fingerprint,true),/已变化/);assert.equal(clears,0);
  meta=null;await assert.rejects(ops.inventory(namespace),/元数据/);assert.equal(clears,0);
});
