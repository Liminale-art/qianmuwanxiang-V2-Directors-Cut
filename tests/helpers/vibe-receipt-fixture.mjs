import assert from 'node:assert/strict';
import {createVibeEncodingStore} from '../../qianmu-vibe-encoding-store.js';
import {prepareNovelVibeEncoding} from '../../qianmu-vibe-encoding.js';
import {createVibeReviewSegment} from '../../qianmu-vibe-history.js';
import {namespace} from './character-native-fixture.mjs';

export async function receiptInput({status='unknown',section='current',information=0,reviewCount=0,undefinedDelivery=false}={}){
  const image='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';
  const prepared=await prepareNovelVibeEncoding({version:1,provider:'novel',baseUrl:'https://relay.example',model:'nai-diffusion-4-full',image,information});
  const receipt={key:JSON.stringify([namespace,prepared.cacheKey]),namespace,cacheKey:prepared.cacheKey,identity:prepared.identity,attemptId:'original-attempt',status,revision:1,createdAt:0,updatedAt:1.25,
    sourceAssetRef:{version:1,namespace,id:'a'.repeat(64)},delivery:{version:1,transport:'direct',channelKey:'b'.repeat(64)}};
  if(status==='ready')receipt.assetRef={version:1,namespace,id:'c'.repeat(64)};
  if(status==='reviewed')receipt.feeReview={version:1,method:'local-user',confirmation:'d'.repeat(64),previousStatus:'unknown',at:1};
  const segments=[];let previous=null;
  for(let at=0;at<reviewCount;at+=32){const reviews=Array.from({length:Math.min(32,reviewCount-at)},(_,i)=>({attemptId:`older-attempt-${at+i}`,
    ...(undefinedDelivery?{delivery:undefined}:{}),feeReview:{version:1,method:'local-user',confirmation:'d'.repeat(64),previousStatus:'unknown',at:1}}));
    const segment=await createVibeReviewSegment(namespace,receipt.cacheKey,previous,reviews);segments.push(segment);previous={version:1,id:segment.id,count:segment.count};}
  if(previous)receipt.reviewArchive=previous;return {namespace,section,receipt,segments};
}

// Existing five-table IDB protocol double: one consistent readonly transaction.
// Writes/upgrades are forbidden; assertions execute the real legacy store.
export function receiptLegacyFixture(inputs=[]){
  const rows=structuredClone(inputs),bytes=value=>Buffer.byteLength(JSON.stringify(value));
  const current=rows.filter(x=>x.section==='current').map(x=>x.receipt),archived=rows.filter(x=>x.section==='archived').map(x=>x.receipt),segments=rows.flatMap(x=>x.segments);
  const state={tables:{receipts:current,archive:archived,reviewSegments:segments,
    archiveUsage:archived.length?[{namespace,count:archived.length,bytes:archived.reduce((n,r)=>n+bytes(r),0)}]:[],
    reviewUsage:segments.length?[{namespace,count:segments.length,bytes:segments.reduce((n,r)=>n+bytes(r),0),reviews:segments.reduce((n,r)=>n+r.reviews.length,0)}]:[]},transactions:[],reads:[],error:false};
  const indexedDB={open(){const req={};queueMicrotask(()=>{if(state.error){req.onerror?.();return;}
    req.result={close(){},transaction(names,mode){assert.equal(mode,'readonly');state.transactions.push({names,mode});
      const snapshot=structuredClone(state.tables);let pending=0,ended=false;
      const tx={abort(){if(ended)return;ended=true;queueMicrotask(()=>tx.onabort?.());}};
      const ask=work=>{const request={};pending++;queueMicrotask(()=>{if(ended)return;request.result=structuredClone(work());request.onsuccess?.();if(--pending===0)queueMicrotask(()=>{if(!ended)tx.oncomplete?.();});});return request;};
      tx.objectStore=name=>({get:id=>ask(()=>snapshot[name].find(row=>row.key===id||row.namespace===id)),index:index=>({getAll:(id,limit)=>{
        state.reads.push({name,index,limit});return ask(()=>snapshot[name].filter(row=>index==='receipt'?row.namespace===id[0]&&row.cacheKey===id[1]:row.namespace===id).slice(0,limit));}})});return tx;
    }};req.onsuccess?.();});return req;}};
  const keyRange={only:value=>value};return {state,indexedDB,keyRange,open:()=>createVibeEncodingStore({indexedDB,keyRange})};
}
