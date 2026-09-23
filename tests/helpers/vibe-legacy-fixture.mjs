import assert from 'node:assert/strict';
import {createLocalVibeAssetStore} from '../../qianmu-vibe-asset-store.js';
import {parseNovelVibeFile,vibeDigest,vibeFilePreview} from '../../qianmu-vibe-file.js';
import {namespace} from './character-native-fixture.mjs';

export async function vibeInput(name='Original',{preview=true}={}){
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';
  const document={identifier:'novelai-vibe-transfer',version:1,type:'image',id:await vibeDigest(png),image:png,name,
    thumbnail:`data:image/png;base64,${png}`,encodings:{v4full:{zero:{encoding:btoa('encoded'),params:{information_extracted:0}}}},importInfo:{strength:0,information_extracted:0}};
  const [asset]=await parseNovelVibeFile(JSON.stringify(document)),blob=preview?vibeFilePreview(document):null;
  return {asset,blob,head:{key:JSON.stringify([namespace,asset.assetId]),namespace,assetId:asset.assetId,bytes:asset.bytes,summary:asset.summary,createdAt:1.25,...(preview?{previewBytes:blob.size}:{})}};
}

// Runs the real IDB adapter with readonly atomic transactions. Any attempted
// mutation of an old browser record fails the test, including during migration.
export function vibeLegacyFixture(t,inputs=[]){
  const state={heads:[],documents:[],previews:[],usage:[]},reads=[],clients=[];
  function replace(values){state.heads=values.map(row=>structuredClone(row.head));state.documents=values.map(row=>({key:row.head.key,namespace,serialized:row.asset.serialized}));
    state.previews=values.filter(row=>row.blob).map(row=>({key:row.head.key,namespace,blob:row.blob}));state.usage=values.length?[{key:namespace,count:values.length,
      bytes:values.reduce((n,row)=>n+row.head.bytes,0),previewBytes:values.reduce((n,row)=>n+(row.head.previewBytes??0),0)}]:[];}
  replace(inputs);const keyRange={only:value=>({only:value}),bound:(low,high)=>({low,high})};
  const matches=(value,range)=>range.only!==undefined?value===range.only:value>=range.low&&value<=range.high;
  const indexedDB={open(name){assert.equal(name,'qianmu-vibe-assets');const request={};queueMicrotask(()=>{
    request.result={close(){},transaction(names,mode){assert.equal(mode,'readonly');const snapshot=structuredClone(state);let pending=0,aborted=false;
      const tx={abort(){aborted=true;queueMicrotask(()=>tx.onabort?.());},objectStore(name){
        const ask=(kind,value)=>{reads.push({name,kind});const result={};pending++;queueMicrotask(()=>{if(aborted)return;result.result=structuredClone(value);result.onsuccess?.();pending--;
          if(!pending)queueMicrotask(()=>{if(!aborted&&!pending)tx.oncomplete?.();});});return result;};
        return {get:key=>ask('get',snapshot[name].find(row=>row.key===key)),getAllKeys:(range,limit)=>ask('keys',snapshot[name].filter(row=>matches(row.key,range)).map(row=>row.key).sort().slice(0,limit)),
          index:()=>({getAll:(range,limit)=>ask('index',snapshot[name].filter(row=>matches(row.namespace,range)).slice(0,limit)),count:range=>ask('count',snapshot[name].filter(row=>matches(row.namespace,range)).length)})};
      }};return tx;}};request.onsuccess?.();});return request;}};
  const open=()=>{const store=createLocalVibeAssetStore({indexedDB,keyRange});clients.push(store);return store;};t.after(()=>clients.forEach(store=>store.close()));
  return {state,reads,replace,indexedDB,keyRange,open};
}
