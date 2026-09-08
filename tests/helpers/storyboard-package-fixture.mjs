import vm from 'node:vm';
import assert from 'node:assert/strict';
import * as board from '../../qianmu-storyboard.js';
import * as assets from '../../qianmu-storyboard-package-assets.js';
import * as input from '../../qianmu-storyboard-package-input.js';
import * as draft from '../../qianmu-storyboard-package-draft.js';
import * as mutation from '../../qianmu-storyboard-package-mutation.js';
import {createStoryboardPackageStage} from '../../qianmu-storyboard-package-stage.js';
import {parseNovelVibeFile,vibeFilePreview} from '../../qianmu-vibe-file.js';
import {storyboardFunctionSource as fn} from './storyboard-form-fixture.mjs';
export function createPackageImportFixture(){
  const e={state:board.createStoryboardDefaults(),store:{},namespace:'st-user:fixture',chatKey:'chat-a',messages:[],notices:[],events:[],confirm:true,choice:null,pending:null,files:new Map(),checkpoints:new Map()};
  const locks={request:async(name,opts,run)=>run({name})};
  const assetStore={inventory:async namespace=>{const heads=[...e.files.values()].map(a=>({namespace,assetId:a.assetId,bytes:a.bytes,previewBytes:vibeFilePreview(a.document)?.size||0}));return {heads,usage:{bytes:heads.reduce((n,a)=>n+a.bytes,0),previewBytes:heads.reduce((n,a)=>n+a.previewBytes,0),limit:e.assetLimit??512*1048576}};},
    load:async(ns,id)=>e.files.get(id)||null,putFile:async(ns,text)=>{if(e.failAsset)throw Error('asset write interrupted');const [a]=await parseNovelVibeFile(text);e.events.push('asset');e.files.set(a.assetId,a);},close:()=>{e.assetClosed=true;}};
  const journal={loadResource:async()=>e.resource||null,dismissResource:async row=>{assert.deepEqual(row,e.resource);e.resource=null;},loadMutation:async()=>e.pending&&structuredClone(e.pending),prepareMutation:async row=>{e.events.push('journal');if(e.pending)throw Error('pending');e.pending=structuredClone(row);return structuredClone(row);},
    updateMutation:async(row,phase)=>{e.events.push(phase);e.pending=structuredClone({...row,phase,revision:row.revision+1});return structuredClone(e.pending);},dismissMutation:async()=>{e.pending=null;},close:()=>{},
    list:async namespace=>[...e.checkpoints.values()].filter(row=>row.namespace===namespace),dismissCheckpoint:async row=>{e.checkpoints.delete(row.key);},
    prepare:async d=>{const key=JSON.stringify([d.namespace,d.chatHash,d.fileHash]);let row=e.checkpoints.get(key);if(!row){row={...d,key,version:1,phase:'prepared',revision:1,createdAt:1,updatedAt:1};e.checkpoints.set(key,row);}return structuredClone(row);},
    checkpoint:async(row,phase)=>{const next={...row,phase,revision:row.revision+1};e.checkpoints.set(row.key,next);return structuredClone(next);}};
  const modules={storyboardPackageAssets:assets,storyboardPackageInput:input,storyboardPackageDraft:draft,storyboardPackageMutation:mutation,storyboardPackageJournal:{createStoryboardPackageJournal:()=>journal},
    storyboardPackageStage:{createStoryboardPackageStage:args=>createStoryboardPackageStage({...args,locks})},storyboardPackageStore:{createVibeAssetStore:()=>assetStore},imageAdmission:{resolveImageAccountNamespace:async()=>e.namespace}};
  const noop=()=>{},context=vm.createContext({...board,Blob,structuredClone,JSON,globalThis:null,navigator:{locks:{request:async(name,opts,run)=>run({name})}},storyboardAdmissionEpoch:1,
    storyboardState:()=>e.state,getChatStore:()=>e.store,getChatKey:()=>e.chatKey,storyboardActiveJobs:new Map(),storyboardQueue:[],STORYBOARD_SOURCES:board.STORYBOARD_PROVIDER_REGISTRY,featureRuntime:{load:async name=>modules[name]},
    clone:structuredClone,ctx:()=>({chat:e.messages}),getCharacterName:()=> 'fixture',storyboardGalleryRecords:()=>e.store.storyboardImages||[],storyboardGalleryCollections:()=>e.store.storyboardCollections||[],
    confirmDialog:async(...args)=>{e.lastConfirmation=args;return typeof e.confirm==='function'?e.confirm():e.confirm;},promptInput:async()=>e.choice,storyboardUtilsModule:async()=>({saveBase64AsFile:async(...args)=>{e.events.push('media');if(e.upload)return e.upload(...args);return '/restored.png';}}),
    storyboardSafeUrl:url=>typeof url==='string'&&url.startsWith('/')?url:'',saveSettings:()=>{e.events.push('settings');},saveMetadata:async()=>{e.events.push('metadata');if(e.persist)await e.persist();},
    hashText:text=>text,storyboardScheduleInlineRender:noop,renderModal:noop,toast:(...args)=>e.notices.push(args),
  });context.globalThis=context;
  vm.runInContext(['storyboardImportPackage','storyboardApplyPackageMutation','storyboardRecoverPackageMutation'].map(fn).join('\n'),context);
  return {e,context,journal,modules,import:context.storyboardImportPackage,recover:()=>context.storyboardImportPackage(null,{recoverOnly:true})};
}
