import {createTextCollectionFloorTools} from './qianmu-text-collection-floor.js';
import {createProseAssistantFloorTools} from './qianmu-prose-assistant-floor.js';
import {createProseHive} from './qianmu-prose-hive.js';
import {configureStAccountStorage} from './qianmu-st-account-storage.js';
import {scheduleQianmuIdlePreload} from './qianmu-idle-preload.js';
export {injectStoryboardMessageButtons} from './qianmu-text-collection-floor.js';

// One host refresh/cleanup path; collection and assistant retain separate state.
export function createProseFloorTools(options){
  configureStAccountStorage({resolveNamespace:options.resolveNamespace,isCurrent:options.isCurrent,headers:options.headers||(()=>({}))});
  const assistant=createProseAssistantFloorTools({...options,assistantHistoryFactory:options.assistantHistoryFactory||(async input=>(await import('./qianmu-prose-assistant-native.js')).openNativeProseAssistantHistory(input))});
  const collection=createTextCollectionFloorTools({...options,extraFloorTools:assistant});let hive=null,autosave=null,loading=null,disposed=false,generation=0,stopPreload=null;
  const start=()=>{if(disposed||autosave||loading)return;const owner=generation;const pending=import('./qianmu-text-collection-autosave.js').then(module=>{if(!disposed&&generation===owner){autosave=module.createCollectionAutosave(options);autosave.start();}}).catch(()=>{}).finally(()=>{if(loading===pending)loading=null;});loading=pending;};
  return Object.freeze({...collection,openAssistant:()=>assistant.openAssistant(),
    refresh(root){start();collection.refresh(root);},openLibrary(...args){start();return collection.openLibrary(...args);},
    get restoreBusy(){return collection.restoreBusy;},get assistantBusy(){return collection.assistantBusy;},
    get assistantDetached(){return hive?.detached===true;},
    configureHive(config){disposed=false;hive?.dispose();hive=createProseHive({...config,open:()=>assistant.openAssistant(),applyIcons:options.applyIcons});stopPreload?.();stopPreload=scheduleQianmuIdlePreload({...options,isBusy:()=>{const stream=options.getContext?.().streamingProcessor;return stream&&!stream.isStopped&&!stream.isFinished;}});},
    renderHive(){hive?.render();},bindHive(...args){hive?.bind(...args);},
    dispose(){disposed=true;generation++;stopPreload?.();stopPreload=null;autosave?.close();autosave=null;loading=null;hive?.dispose();hive=null;collection.dispose();}});
}
