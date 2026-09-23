import {characterNativeFixture,namespace} from './character-native-fixture.mjs';
import {comfyLibraryIdbFixture,comfyPoolIdbFixture} from './comfy-library-idb-fixture.mjs';
import {createComfyWorkflowStore} from '../../qianmu-comfy-library.js';
import {createComfyPoolStore} from '../../qianmu-comfy-pool-store.js';
import {normalizeComfyAutoPool,COMFY_SELECTION_SCHEMA} from '../../qianmu-comfy-selection.js';
import {pinComfyRouteWorkflow} from '../../qianmu-comfy-route.js';

export {namespace};
export const workflow=label=>({workflow:JSON.stringify({text:{class_type:'CLIPTextEncode',inputs:{text:'%qianmu_prompt%',label}},image:{class_type:'SaveImage',inputs:{images:['text',0]}}}),outputNodeId:'image',parameters:{seed:0,width:512,height:512,count:1},classification:{version:1,visualKinds:['object'],castSizes:['none'],contentClasses:['sfw'],promptFormat:'natural_language',maxSubjects:0}});
export function globalProperty(t,key,value){const old=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});t.after(()=>{if(old)Object.defineProperty(globalThis,key,old);else delete globalThis[key];});}
export async function poolNativeFixture(t){
  const f=await characterNativeFixture(t),workflowLocal=comfyLibraryIdbFixture(),poolLocal=comfyPoolIdbFixture();let at=10;
  const options=local=>({indexedDB:local.indexedDB,keyRange:local.keyRange,native:{createStorage:f.createStorage},now:()=>at});
  const openWorkflow=(local=workflowLocal)=>{const store=createComfyWorkflowStore(options(local));t.after(()=>store.close());return store;};
  const openPool=(local=poolLocal,extra={})=>{const store=createComfyPoolStore({...options(local),...extra});t.after(()=>store.close());return store;};
  const router=(workflows=workflowLocal,pools=poolLocal)=>({open(name,...args){if(name==='qianmu-comfy-workflows')return workflows.indexedDB.open(name,...args);if(name==='qianmu-comfy-pools')return pools.indexedDB.open(name,...args);throw Error('unrelated database');}});
  const configure=(workflows=workflowLocal,pools=poolLocal)=>{f.configure();globalProperty(t,'indexedDB',router(workflows,pools));globalProperty(t,'IDBKeyRange',poolLocal.keyRange);};
  const workflows=openWorkflow(),head=await workflows.save(namespace,{name:'Original workflow',document:workflow('original')}),recipe=await pinComfyRouteWorkflow({namespace,selection:head,createStore:()=>openWorkflow()});
  const pool=normalizeComfyAutoPool({schema:COMFY_SELECTION_SCHEMA,namespace,id:'draft',revision:'draft',enabled:true,styleLock:true,candidates:[{id:'member',enabled:true,priority:0,classification:recipe.document.classification,
    target:{providerId:'comfy',modelId:'comfy-workflow',connectionPresetId:'original-connection',comfyWorkflowBinding:recipe.binding,comfyCharacterEnabled:false,
      comfyReferences:{version:1,enabled:true,namespace,workflowHash:recipe.binding.workflowHash,items:[{url:'/user/images/original-ref.png',name:'ref',mime:'image/png',bytes:12,sha256:'a'.repeat(64)}]}}}]});
  return Object.assign(f,{pool,recipe,workflowHead:head,workflowLocal,poolLocal,workflows,openWorkflow,openPool,configureDefaults:configure,router,time:value=>at=value});
}
