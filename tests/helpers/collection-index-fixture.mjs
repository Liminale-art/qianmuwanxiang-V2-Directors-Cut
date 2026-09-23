import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import {configureStAccountStorage,createConfiguredStAccountStorage} from '../../qianmu-st-account-storage.js';
import {createTextCollectionSession} from '../../qianmu-text-collection-session.js';
import {createTextCollection} from '../../qianmu-text-collection.js';
import {createTextCollectionOriginalStore} from '../../qianmu-text-collection-original.js';

export const namespace='st-user:index-fixture',account='st-user:'+createHash('sha256').update(namespace.slice(8)).digest('hex');
export const record=(i,text='原文'+i)=>createTextCollection({id:'collection-'+String(i).padStart(4,'0'),mode:'full',createdAt:10+i,
  source:{account,chatId:'deleted-chat',messageId:i,replyId:'reply-'+i,charName:'CHAR',userName:'USER',text}});
export const entry=record=>({id:record.id,revision:record.revision,updatedAt:record.updatedAt,deleted:false,record});
const json=(value,status=200)=>new Response(typeof value==='string'?value:JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
export async function collectionIndexFixture(t,records=[record(1)],{version=2}={}){
  const files=new Map(),calls=[],clients=[];let owner=namespace,hook=null,lose=false;
  const fetchImpl=async(url,request={})=>{
    const {origin,pathname:path}=new URL(url);assert.equal(origin,'https://st.fixture.invalid');assert.equal(request.cache,'no-store');assert.equal(request.redirect,'error');
    assert.equal(request.credentials,'same-origin');assert.equal(request.headers.Authorization,undefined);assert.equal(request.headers['X-CSRF-Token'],'fixture');
    const call={path,request};calls.push(call);const intercepted=await hook?.(call);if(intercepted)return intercepted;
    if(path==='/api/files/upload'){
      const {name,data}=JSON.parse(request.body),body=Buffer.from(data,'base64').toString('utf8'),document=JSON.parse(body);files.set(name,body);
      if(lose&&document.schema==='qianmu.st-account-head.v1'&&document.slot==='collections'){lose=false;throw Error('accepted head; lost receipt');}
      return json({path:'/user/files/'+name});
    }
    assert.match(path,/^\/user\/files\/qianmu-v2-[a-f0-9]{64}-[a-z0-9-]+\.json$/,'no backend, directory scan or external endpoint');
    const body=files.get(path.split('/').at(-1));return body===undefined?json({},404):json(body);
  };
  t.mock.method(globalThis,'fetch',fetchImpl);
  const config={resolveNamespace:async()=>owner,isCurrent:()=>true,headers:()=>({'X-CSRF-Token':'fixture'}),fetchImpl,origin:'https://st.fixture.invalid',cryptoImpl:webcrypto};
  configureStAccountStorage(config);const storage=await createConfiguredStAccountStorage();clients.push(storage);
  const originals=createTextCollectionOriginalStore({storage,expectedAccount:account}),descriptors=[];
  if(version===2)for(const row of records)descriptors.push(await originals.preserve(entry(row)));
  await storage.write('collections',{version,expectedAccount:account,revision:records.length,entries:version===2?descriptors:records.map(entry),receipts:[]},{expectedFingerprint:null});
  const open=async()=>{const session=await createTextCollectionSession({...config,fetchImpl:undefined});clients.push(session);return session;};
  t.after(()=>clients.forEach(client=>client.close()));calls.length=0;
  return {files,calls,storage,originals,records,descriptors,open,async readIndex(){return storage.read('collections');},
    async writeIndex(value){const prior=await storage.read('collections');return storage.write('collections',value,{expectedFingerprint:prior.fingerprint});},
    hook(value){hook=value;},setAccount(value){owner=value;},reconfigure(){configureStAccountStorage(config);},loseIndexAck(){lose=true;},
    reset(){calls.length=0;},get bodyReads(){return calls.filter(c=>c.request.method==='GET'&&c.path.includes('-collection-record-')).length;},
    get uploads(){return calls.filter(c=>c.request.method==='POST').length;}};
}
