import vm from 'node:vm';
import * as centerView from '../../qianmu-reader-center-view.js';
import {normalizeCoreadSource} from '../../qianmu-reader.js';
import {storyboardFunctionSource as section} from './storyboard-form-fixture.mjs';

export const coreadCenterFunctions=['renderMemSwitch','renderCoreadCenterStatus','renderCoreadSpoilerGuard',
  'coreadGuideSteps','coreadGuideCurrent','coreadGuideTargetClass','renderCoreadGuide','renderCoreadPackBar'].map(section).join('\n');

export function createCoreadCenterFixture(){
  const trace=[],inputs={meta:{title:'Book<&',progress:60},fallback:{progress:40},safe:[{id:1}]};
  const c=vm.createContext({...centerView,COREAD_MEMORY_ENABLED:true,coreadGuideStep:null,
    readerDialog:{bookId:'book',readBoundary:{progress:12.5},slices:[{id:1},{id:2},{id:3}]},
    coreadBookMeta:id=>{trace.push(['meta',id]);return inputs.meta;},
    coreadCurrentReadBoundarySync:id=>{trace.push(['boundary',id]);return inputs.fallback;},
    coreadSafeSlices:(rows,boundary,memory)=>{trace.push(['safe',rows,boundary,memory]);return inputs.safe;},
    htmlEscape:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;')});
  vm.runInContext(coreadCenterFunctions,c);return {c,trace,inputs};
}

export const coreadRecordsFunctions=['coreadBoundBuckets','renderMemRecordsTab'].map(section).join('\n');
export function createCoreadRecordsFixture(){
  const f=createCoreadCenterFixture(),{c,trace,inputs}=f;
  inputs.store={coreadBound:['one','two']};
  c.getChatStore=()=>{trace.push(['store']);return inputs.store;};
  c.reader={normalizeCoreadSource};c.coreadWorldSyncBusy=false;
  c.DEFAULT_DISTILL_TEXT_PROMPT='fixture distill';c.DEFAULT_MAINLINE_SUMMARY_PROMPT='fixture mainline';
  Object.assign(c.readerDialog,{messages:Array.from({length:8},()=>({text:'fixture'})),cursor:3});
  c.coreadGuideTargetClass=target=>{trace.push(['guide',target]);return target==='records'?' sd-reader-tour-target':'';};
  const m={worldSyncMode:'none',summaryItems:[],summaryPresets:[],spoilerProtection:true};
  vm.runInContext(coreadRecordsFunctions,c);return {...f,m};
}
