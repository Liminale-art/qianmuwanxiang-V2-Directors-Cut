import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import {resolveImageAccountNamespace,invalidateImageAccountIdentity} from '../../qianmu-account-identity.js';
import {configureStAccountStorage,createConfiguredStAccountStorage} from '../../qianmu-st-account-storage.js';
import {createTextCollectionSession} from '../../qianmu-text-collection-session.js';
import {createTextCollection} from '../../qianmu-text-collection.js';
import {createTextCollectionOriginalStore} from '../../qianmu-text-collection-original.js';

// The real ST emitter replays APP_READY, including to listeners registered
// after startup. A DOM-ready flag or an initial account flag is insufficient.
export function readySource(initial=false){
  const rows=new Map();let emitted=initial;
  return {on(type,fn){let set=rows.get(type);if(!set)rows.set(type,set=new Set());set.add(fn);if(type==='APP_READY'&&emitted)fn();},
    removeListener(type,fn){rows.get(type)?.delete(fn);},
    emit(){emitted=true;for(const fn of rows.get('APP_READY')||[])fn();},
    get listeners(){return rows.get('APP_READY')?.size||0;}};
}
export const singleUser=()=>({currentUser:null,accountsEnabled:false,getCurrentUserHandle:()=>'default-user'});

// All endpoints are in-memory. Unlike a fixed namespace fixture, every native
// session/storage guard calls the actual production identity resolver here.
// No private content, handles or API keys are written to stdout or disk.
export async function identityNativeFixture({ready=true}={}){
  const globals=new Map(['fetch','SillyTavern'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const user=singleUser(),source=readySource(ready),files=new Map(),clients=[],counts={identityHTTP:0,fileGET:0,filePOST:0};let status=200;
  const context={eventSource:source,eventTypes:{APP_READY:'APP_READY'}};
  Object.defineProperty(globalThis,'SillyTavern',{configurable:true,value:{getContext:()=>context}});
  const identityFetch=async(url,options)=>{
    assert.equal(url,'/api/users/me');assert.equal(options.credentials,'same-origin');assert.equal(options.cache,'no-store');counts.identityHTTP++;
    return Response.json({handle:'default-user'});
  };
  const resolveNamespace=()=>resolveImageAccountNamespace({loadUser:async()=>user,fetchImpl:identityFetch});
  const fetchImpl=async(url,request={})=>{
    const {origin,pathname:path}=new URL(url);assert.equal(origin,'https://st.fixture.invalid');
    assert.equal(request.cache,'no-store');assert.equal(request.redirect,'error');assert.equal(request.credentials,'same-origin');
    assert.equal(request.headers.Authorization,undefined);assert.equal(request.headers['X-CSRF-Token'],'fixture');
    counts[request.method==='POST'?'filePOST':'fileGET']++;
    if(status!==200)return Response.json({}, {status});
    if(path==='/api/files/upload'){
      const {name,data}=JSON.parse(request.body);files.set(name,Buffer.from(data,'base64').toString('utf8'));return Response.json({path:'/user/files/'+name});
    }
    assert.match(path,/^\/user\/files\/qianmu-v2-[a-f0-9]{64}-[a-z0-9-]+\.json$/);
    const text=files.get(path.split('/').at(-1));return text===undefined?Response.json({}, {status:404}):new Response(text,{headers:{'content-type':'application/json'}});
  };
  Object.defineProperty(globalThis,'fetch',{configurable:true,writable:true,value:fetchImpl});
  invalidateImageAccountIdentity();
  const config={resolveNamespace,isCurrent:()=>true,headers:()=>({'X-CSRF-Token':'fixture'}),fetchImpl,origin:'https://st.fixture.invalid',cryptoImpl:webcrypto};
  configureStAccountStorage(config);const storage=await createConfiguredStAccountStorage();clients.push(storage);
  const account='st-user:'+createHash('sha256').update('default-user').digest('hex');
  const records=Array.from({length:2},(_,i)=>createTextCollection({id:'identity-record-'+(i+1),mode:'full',createdAt:10+i,
    source:{account,chatId:'fixture',messageId:i,replyId:'reply-'+i,charName:'CHAR',userName:'USER',text:'Synthetic fixture '+i}}));
  const original=createTextCollectionOriginalStore({storage,expectedAccount:account}),entries=[];
  for(const record of records)entries.push(await original.preserve({id:record.id,revision:record.revision,updatedAt:record.updatedAt,deleted:false,record}));
  await storage.write('collections',{version:2,expectedAccount:account,revision:2,entries,receipts:[]},{expectedFingerprint:null});
  const reset=()=>{for(const key of Object.keys(counts))counts[key]=0;};reset();invalidateImageAccountIdentity();
  return {records,storage,counts,resolveNamespace,reset,setStatus(value){status=value;},
    async open(){const session=await createTextCollectionSession({...config,fetchImpl:undefined});clients.push(session);return session;},
    close(){clients.forEach(client=>client.close());invalidateImageAccountIdentity();for(const [key,value] of globals)if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}};
}

export async function measureIdentityNativeCosts({ready}={}){
  const fixture=await identityNativeFixture({ready}),rows=[];
  const step=async(name,work)=>{fixture.reset();await work();rows.push({operation:name,...fixture.counts});};
  let session;
  try{
    await step('cold-list',async()=>{session=await fixture.open();await session.list();});
    await step('detail',()=>session.get(fixture.records[0].id));
    await step('reopened-list',async()=>{session.close();session=await fixture.open();await session.list();});
    await step('delete-one',()=>session.prepareDelete(fixture.records[0].id,1).submit());
    return rows;
  }finally{fixture.close();}
}
