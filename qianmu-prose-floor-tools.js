import {createTextCollectionFloorTools} from './qianmu-text-collection-floor.js';
import {createProseAssistantFloorTools} from './qianmu-prose-assistant-floor.js';
export {injectStoryboardMessageButtons} from './qianmu-text-collection-floor.js';

// One host refresh/cleanup path; collection and assistant retain separate state.
export function createProseFloorTools(options){
  const assistant=createProseAssistantFloorTools(options);
  return createTextCollectionFloorTools({...options,extraFloorTools:assistant});
}
