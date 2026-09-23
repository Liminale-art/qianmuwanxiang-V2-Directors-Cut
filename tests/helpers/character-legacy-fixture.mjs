import assert from 'node:assert/strict';
import {createLocalCharacterArchiveStore} from '../../qianmu-character-archive-store.js';
import {characterNativeBackup,characterNativeBytes} from '../../qianmu-character-native-contract.js';
import {namespace,document} from './character-native-fixture.mjs';

export function legacyPacket({optional=true,count=1}={}) {
  const archives=Array.from({length:count},(_,i)=>{
    const value=document(`Legacy ${i}`);if(!optional){delete value.ageStatus;delete value.imagegen.preview;}
    return {head:{id:`old-${i}`,revision:`rev-${i}`,version:3,category:'char',name:value.name,aliases:value.aliases,cover:'',bytes:characterNativeBytes(value),createdAt:0,updatedAt:20},document:value};
  });
  const bindings=[{category:'char',subjectKey:'char:legacy.png',scope:'default',chatKey:'',archiveId:count?'old-0':'',revision:'binding-default',updatedAt:1},
    {category:'char',subjectKey:'char:legacy.png',scope:'chat',chatKey:'test-chat',archiveId:'',revision:'binding-unbound',updatedAt:2}];
  return characterNativeBackup(namespace,archives,bindings);
}
// Readonly atomic IDB protocol double, using the real local store implementation.
// All fixtures are synthetic in-memory objects; any attempted write is an error.
export function characterLegacyFixture(t,packet=legacyPacket()) {
  const reads=[],clients=[],state={heads:[],documents:[],bindings:[],usage:[]};let closes=0,opened=0;
  function replace(value){
    state.heads=value.archives.map(({head})=>({...structuredClone(head),namespace,key:JSON.stringify([namespace,head.id])}));
    state.documents=value.archives.map(({head,document})=>({key:JSON.stringify([namespace,head.id]),namespace,revision:head.revision,document:structuredClone(document)}));
    state.bindings=value.bindings.map(row=>({...structuredClone(row),namespace,key:JSON.stringify([namespace,row.category,row.subjectKey,row.scope,row.chatKey])}));
    state.usage=[{key:namespace,...value.usage}];
  }
  replace(packet);
  const keyRange={only:value=>({only:value}),bound:(low,high)=>({low,high})};
  const matches=(value,range)=>range.only!==undefined?value===range.only:value>=range.low&&value<=range.high;
  const database={close(){closes++;},transaction(_names,mode){
    assert.equal(mode,'readonly');const snapshot=structuredClone(state);let pending=0,aborted=false;
    const tx={abort(){aborted=true;queueMicrotask(()=>tx.onabort?.());},objectStore(name){
      function request(kind,value){reads.push({name,kind});const result={};pending++;
        queueMicrotask(()=>{if(aborted)return;result.result=structuredClone(value);result.onsuccess?.();pending--;
          if(!pending)queueMicrotask(()=>{if(!aborted&&!pending)tx.oncomplete?.();});});return result;
      }
      return {get:key=>request('get',snapshot[name].find(row=>row.key===key)),
        getAllKeys:(range,limit)=>request('keys',snapshot[name].filter(row=>matches(row.key,range)).map(row=>row.key).sort().slice(0,limit)),
        index(index){assert.equal(index,'namespace');return {
          getAll:(range,limit)=>request('index',snapshot[name].filter(row=>matches(row.namespace,range)).slice(0,limit)),
          count:range=>request('count',snapshot[name].filter(row=>matches(row.namespace,range)).length)};}};
    }};return tx;
  }};
  const indexedDB={open(){opened++;const request={};queueMicrotask(()=>{request.result=database;request.onsuccess?.();});return request;}};
  const createLocal=()=>{const store=createLocalCharacterArchiveStore({indexedDB,keyRange});clients.push(store);return store;};
  t.after(()=>clients.forEach(store=>store.close()));
  return {state,reads,replace,createLocal,indexedDB,keyRange,get opened(){return opened;},get closes(){return closes;}};
}
