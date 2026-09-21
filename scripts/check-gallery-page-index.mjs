// Synthetic, in-memory maintenance check. No user chat, media, disk writes,
// remote calls or timing claims about real ST/VPS/phone environments.
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {GALLERY_PAGE_INDEX_LIMITS as LIMIT,encodeGalleryIndexPage,encodeGalleryIndexManifest,createGalleryPageIndexReader} from '../qianmu-gallery-page-index.js';

const source={namespace:'st-user:synthetic-scale',ownerKey:'char:Synthetic.png',chatKey:'synthetic-gallery'};
for(const count of [1000,10000,50000]){
  const started=performance.now(),files=new Map(),pages=[];
  for(let offset=0;offset<count;offset+=LIMIT.rows){
    const rows=Array.from({length:Math.min(LIMIT.rows,count-offset)},(_,index)=>{
      const number=count-offset-index;
      return {recordId:`synthetic-${number}`,createdAt:number,label:`合成画面 ${number}`,tags:number%3===0?['厨房','室内']:['室内'],record:{sha256:'a'.repeat(64),bytes:2048}};
    });
    const page=await encodeGalleryIndexPage(source,rows);files.set(page.reference.sha256,page.text);pages.push(page.descriptor);
  }
  const head=await encodeGalleryIndexManifest(source,pages),builtMs=performance.now()-started;
  let reads=0,bytes=0;
  const reader=await createGalleryPageIndexReader({source,head,guard:async()=>true,readPage:async ref=>{reads++;bytes+=ref.bytes;return files.get(ref.sha256);}});
  try{
    const at=performance.now(),first=await reader.page();assert.equal(first.rows.length,24);assert.equal(first.total,count);assert.equal(reads,1);
    const firstResult={metadataPages:reads,metadataBytes:bytes,rows:first.rows.length,localMs:Number((performance.now()-at).toFixed(3))};
    reads=0;bytes=0;const missing=await reader.page({tags:['missing']});assert.ok(reads<=LIMIT.scanPages);assert.ok(missing.scanned<=LIMIT.rows*LIMIT.scanPages);
    console.log(JSON.stringify({scope:'synthetic-memory-only-not-ST',records:count,headBytes:head.reference.bytes,pages:pages.length,
      first:firstResult,unmatchedFilter:{metadataPages:reads,metadataBytes:bytes,rows:missing.rows.length,scanned:missing.scanned,hasMore:missing.hasMore},
      originalReads:0,recordBodyReads:0,buildLocalMs:Number(builtMs.toFixed(3)),proof:'integrity-only-not-durable'}));
  }finally{reader.close();}
}
