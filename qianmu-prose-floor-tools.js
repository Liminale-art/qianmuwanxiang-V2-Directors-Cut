import {createProseAssistantFloorTools} from './qianmu-prose-assistant-floor.js?v=1.59.409';
import {createProseHive} from './qianmu-prose-hive.js';
import {configureStAccountStorage} from './qianmu-st-account-storage.js';
import {scheduleQianmuIdlePreload} from './qianmu-idle-preload.js';
import {createProseAssistantRenameCoordinator} from './qianmu-prose-assistant-rename.js';
import {loadLocalChunk} from './qianmu-feature-runtime.js?v=1.59.409';
import {createTextCollectionHost} from './qianmu-text-collection-host.js';
export {injectStoryboardMessageButtons} from './qianmu-prose-floor-entries.js';

// One host refresh/cleanup path for the assistant and detached hive.
export function createProseFloorTools(options){
  configureStAccountStorage({resolveNamespace:options.resolveNamespace,isCurrent:options.isCurrent,headers:options.headers||(()=>({}))});
  let renames=null;const bindRenames=()=>{renames??=createProseAssistantRenameCoordinator(options);renames.refresh();};
  const assistant=createProseAssistantFloorTools({...options,assistantHistoryFactory:async input=>{await renames?.settled(input.source);return options.assistantHistoryFactory?options.assistantHistoryFactory(input):(await loadLocalChunk('./qianmu-prose-assistant-native.js?v=1.59.409')).openNativeProseAssistantHistory(input);}});
  let hive=null,disposed=false,stopPreload=null,collection=null;
  const collectionHost=()=>collection??=createTextCollectionHost(options);
  return Object.freeze({openAssistant:()=>assistant.openAssistant(),
    openCollection:()=>collectionHost().open(),
    exportCollection:button=>collectionHost().exportBackup(button),
    importCollection:(file,input)=>collectionHost().importBackup(file,input),
    clearCollection:config=>collectionHost().clear(config),
    collectionStorageSummary:async valid=>{try{return await collectionHost().summary(valid)??{status:'unavailable'};}catch{return {status:'unavailable'};}},
    collectionClick:event=>collection?.handleClick(event)===true,
    refreshCollection:root=>collectionHost().refresh(root),
    refresh(root){bindRenames();assistant.bindRoot(root);collectionHost().refresh(root);},
    get assistantBusy(){return assistant.busy;},
    assistantStorageSummary:valid=>assistant.storageSummary(valid),
    cleanupAssistant:(...args)=>assistant.cleanupStorage(...args),
    get assistantDetached(){return hive?.detached===true;},
    configureHive(config){disposed=false;bindRenames();hive?.dispose();hive=createProseHive({...config,open:()=>assistant.openAssistant(),applyIcons:options.applyIcons});stopPreload?.();stopPreload=scheduleQianmuIdlePreload({...options,isBusy:()=>{const stream=options.getContext?.().streamingProcessor;return stream&&!stream.isStopped&&!stream.isFinished;}});},
    renderHive(){hive?.render();},bindHive(...args){hive?.bind(...args);},
    dispose(){disposed=true;renames?.close();renames=null;stopPreload?.();stopPreload=null;hive?.dispose();hive=null;assistant.disposeFloor();collection?.dispose();collection=null;}});
}
