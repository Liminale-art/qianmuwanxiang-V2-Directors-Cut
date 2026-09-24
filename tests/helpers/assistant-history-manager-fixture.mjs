import {createHash} from 'node:crypto';
import {streamCheckpointTransport} from './stream-checkpoint-fixture.mjs';
import {createAssistantHistoryManager} from '../../qianmu-assistant-history-manager.js';
export const sha=value=>createHash('sha256').update(value).digest('hex');
export const account='st-user:'+sha('alice'),namespace='st-user:alice';
export async function assistantManagerFixture(t,count=2){
 const transport=streamCheckpointTransport(namespace),store=await transport.createStorage({maxBytes:4*1024*1024+2048});t.after(()=>store.close());
 const f={transport,store,live:true,owner:namespace,records:[],writes:0,closes:0,loads:0};
 f.add=async(id,rows=[{id:1,user:'问题 '+id,assistant:'完整回答 '+id,status:'complete',reference:null}])=>{
  const key=id==='offstage'?JSON.stringify(['qianmu-prose-assistant-offstage-v1',account]):JSON.stringify(['qianmu-prose-assistant-v2',account,'char:A.png',{kind:'character',chatId:id,avatar:'A.png'},null]);
  const slot='assistant-'+sha(key),state={version:1,namespace:key,revision:1,updatedAt:100,rows},result=await store.write(slot,state,{expectedFingerprint:null});const record={slot,state,result};f.records.push(record);return record;
 };
 for(let i=0;i<count;i++)await f.add('Chat-'+i);
 f.loadPage=async({offset=0,snapshot=null})=>{
  f.loads++;const sorted=[...transport.files].sort(([a],[b])=>a.localeCompare(b)),stamp=sha(JSON.stringify(sorted));if(snapshot&&snapshot!==stamp)throw Error('catalogue changed');
  const heads=sorted.map(([,text])=>JSON.parse(text)).filter(row=>row.schema==='qianmu.st-account-head.v1');
  const entries=heads.slice(offset,offset+8).map(head=>({version:1,scope:head.scope,slot:head.slot,fingerprint:head.fingerprint,bytes:Buffer.byteLength(transport.files.get(`qianmu-v2-${head.scope}-${head.slot}-${head.fingerprint}.json`))}));
  return {namespace,status:'ready',ok:true,version:1,expectedAccount:account,scope:store.scope,offset,snapshot:stamp,total:heads.length,nextOffset:offset+entries.length<heads.length?offset+entries.length:null,entries};
 };
 f.options={resolveNamespace:async()=>f.owner,isCurrent:()=>f.live,loadPage:input=>f.loadPage(input),now:()=>200,
  storageFactory:async options=>{const native=await transport.createStorage(options);return {...native,close(){f.closes++;native.close();},async write(...args){f.writes++;if(f.beforeWrite)await f.beforeWrite(...args);const result=await native.write(...args);if(f.afterWrite)await f.afterWrite(...args);return result;}};}};
 f.manager=await createAssistantHistoryManager(f.options);t.after(()=>f.manager.close());return f;
}
