import vm from 'node:vm';
import * as board from '../../qianmu-storyboard.js';
import * as assets from '../../qianmu-storyboard-package-assets.js';
import * as input from '../../qianmu-storyboard-package-input.js';
import * as draft from '../../qianmu-storyboard-package-draft.js';
import * as mutation from '../../qianmu-storyboard-package-mutation.js';
import {storyboardFunctionSource as fn} from './storyboard-form-fixture.mjs';
export function createPackageImportFixture(){
  const e={state:board.createStoryboardDefaults(),store:{},namespace:'st-user:fixture',chatKey:'chat-a',messages:[],notices:[],events:[],confirm:true,choice:null,pending:null};
  const journal={loadMutation:async()=>e.pending&&structuredClone(e.pending),prepareMutation:async row=>{e.events.push('journal');if(e.pending)throw Error('pending');e.pending=structuredClone(row);return structuredClone(row);},
    updateMutation:async(row,phase)=>{e.events.push(phase);e.pending=structuredClone({...row,phase,revision:row.revision+1});return structuredClone(e.pending);},dismissMutation:async()=>{e.pending=null;},close:()=>{}};
  const modules={storyboardPackageAssets:assets,storyboardPackageInput:input,storyboardPackageDraft:draft,storyboardPackageMutation:mutation,storyboardPackageJournal:{createStoryboardPackageJournal:()=>journal},imageAdmission:{resolveImageAccountNamespace:async()=>e.namespace}};
  const noop=()=>{},context=vm.createContext({...board,Blob,structuredClone,JSON,globalThis:null,navigator:{locks:{request:async(name,opts,run)=>run({name})}},storyboardAdmissionEpoch:1,
    storyboardState:()=>e.state,getChatStore:()=>e.store,getChatKey:()=>e.chatKey,storyboardActiveJobs:new Map(),storyboardQueue:[],STORYBOARD_SOURCES:board.STORYBOARD_PROVIDER_REGISTRY,featureRuntime:{load:async name=>modules[name]},
    clone:structuredClone,ctx:()=>({chat:e.messages}),getCharacterName:()=> 'fixture',storyboardGalleryRecords:()=>e.store.storyboardImages||[],storyboardGalleryCollections:()=>e.store.storyboardCollections||[],
    confirmDialog:async()=>typeof e.confirm==='function'?e.confirm():e.confirm,promptInput:async()=>e.choice,storyboardUtilsModule:async()=>({saveBase64AsFile:async(...args)=>{e.events.push('media');if(e.upload)return e.upload(...args);return '/restored.png';}}),
    storyboardSafeUrl:url=>typeof url==='string'&&url.startsWith('/')?url:'',saveSettings:()=>{e.events.push('settings');},saveMetadata:async()=>{e.events.push('metadata');if(e.persist)await e.persist();},
    hashText:text=>text,storyboardScheduleInlineRender:noop,renderModal:noop,toast:(...args)=>e.notices.push(args),
  });context.globalThis=context;
  vm.runInContext(['storyboardImportPackage','storyboardApplyPackageMutation','storyboardRecoverPackageMutation'].map(fn).join('\n'),context);
  return {e,context,journal,modules,import:context.storyboardImportPackage,recover:()=>context.storyboardImportPackage(null,{recoverOnly:true})};
}
