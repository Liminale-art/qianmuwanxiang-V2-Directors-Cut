import vm from 'node:vm';
import * as centerView from '../../qianmu-reader-center-view.js';
import {normalizeCoreadSource} from '../../qianmu-reader.js';
import {uniqueClean} from '../../qianmu-storyboard-utils.js';
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

export const coreadApiFunctions=['renderMemModelRow','renderMemProfileRow','renderMemApiActions','renderSummaryApiCard'].map(section).join('\n');
export function createCoreadApiFixture(){
  const f=createCoreadCenterFixture();vm.runInContext(coreadApiFunctions,f.c);return f;
}

export const coreadInjectFunctions=['coreadSliceSourceLabel','coreadSliceSourceClass','renderMemInjectTab'].map(section).join('\n');
export function createCoreadInjectFixture(){
  const f=createCoreadCenterFixture(),{c,trace,inputs}=f;
  c.reader={normalizeCoreadSource};c.uniqueClean=uniqueClean;c.COREAD_DEFAULT_DICT='default';c.coreadCurrentDictId='';
  Object.assign(inputs,{recent:[],recall:[],dict:{},bound:[]});
  c.coreadRecentSlices=(n,pool)=>{trace.push(['recent',n,pool]);return inputs.recent;};
  c.coreadRecallSlices=(query,n,exclude,pool)=>{trace.push(['recall',query,n,exclude,pool]);return inputs.recall;};
  c.coreadActiveDict=pool=>{trace.push(['dict',pool]);return inputs.dict;};
  c.coreadBoundDicts=()=>{trace.push(['bound']);return inputs.bound;};
  c.readerDialog.messages=[];
  const m={recallScanMessages:2,recentInject:1,recallCount:3,rerankTopN:4,mainlineFeedback:false,mainlineRecall:0,mainlineRecent:0,mainlineDepth:0,dictBooks:[{id:'default',name:'默认词册',pairs:{}}]};
  vm.runInContext(coreadInjectFunctions,c);return {...f,m};
}
