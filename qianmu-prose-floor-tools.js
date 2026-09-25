import {createTextCollectionFloorTools} from './qianmu-text-collection-floor.js';
import {createProseAssistantFloorTools} from './qianmu-prose-assistant-floor.js?v=1.59.378';
import {createProseHive} from './qianmu-prose-hive.js';
import {configureStAccountStorage} from './qianmu-st-account-storage.js';
import {scheduleQianmuIdlePreload} from './qianmu-idle-preload.js';
import {createProseAssistantRenameCoordinator} from './qianmu-prose-assistant-rename.js';
import {loadLocalChunk} from './qianmu-feature-runtime.js?v=1.59.378';
export {injectStoryboardMessageButtons} from './qianmu-text-collection-floor.js';

// One host refresh/cleanup path; collection and assistant retain separate state.
export function createProseFloorTools(options){
  configureStAccountStorage({resolveNamespace:options.resolveNamespace,isCurrent:options.isCurrent,headers:options.headers||(()=>({}))});
  let renames=null;const bindRenames=()=>{renames??=createProseAssistantRenameCoordinator(options);renames.refresh();};
  const assistant=createProseAssistantFloorTools({...options,assistantHistoryFactory:async input=>{await renames?.settled(input.source);return options.assistantHistoryFactory?options.assistantHistoryFactory(input):(await loadLocalChunk('./qianmu-prose-assistant-native.js?v=1.59.378')).openNativeProseAssistantHistory(input);}});
  const collection=createTextCollectionFloorTools({...options,extraFloorTools:assistant});let hive=null,autosave=null,loading=null,disposed=false,generation=0,stopPreload=null;
  const start=()=>{if(disposed||autosave||loading)return;const owner=generation;const pending=import('./qianmu-text-collection-autosave.js').then(module=>{if(!disposed&&generation===owner){autosave=module.createCollectionAutosave(options);autosave.start();}}).catch(()=>{}).finally(()=>{if(loading===pending)loading=null;});loading=pending;};
  return Object.freeze({...collection,openAssistant:()=>assistant.openAssistant(),
    refresh(root){bindRenames();start();collection.refresh(root);},openLibrary(...args){start();return collection.openLibrary(...args);},
    get restoreBusy(){return collection.restoreBusy;},get assistantBusy(){return collection.assistantBusy;},
    get assistantDetached(){return hive?.detached===true;},
    configureHive(config){disposed=false;bindRenames();hive?.dispose();hive=createProseHive({...config,open:()=>assistant.openAssistant(),applyIcons:options.applyIcons});stopPreload?.();stopPreload=scheduleQianmuIdlePreload({...options,isBusy:()=>{const stream=options.getContext?.().streamingProcessor;return stream&&!stream.isStopped&&!stream.isFinished;}});},
    renderHive(){hive?.render();},bindHive(...args){hive?.bind(...args);},
    dispose(){disposed=true;generation++;renames?.close();renames=null;stopPreload?.();stopPreload=null;autosave?.close();autosave=null;loading=null;hive?.dispose();hive=null;collection.dispose();}});
}
