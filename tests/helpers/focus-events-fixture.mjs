import vm from 'node:vm';
import {bindFocusClockPage} from '../../qianmu-focus-events.js';
import {focusFixture} from './focus-lock-fixture.mjs';
import {storyboardFunctionSource as section} from './storyboard-form-fixture.mjs';

export function focusEventsFixture(overrides={}) {
  const env=focusFixture(overrides),{c}=env,nodes=new Map(),trace=[];
  let voice={characterKey:'character:A',providerId:'minimax',chatKey:'chatA'},confirmed=true;
  function node(selector,props={}) {
    const handlers=new Map(),el={value:'',dataset:{},...props,
      addEventListener:(type,fn)=>{if(!handlers.has(type))handlers.set(type,[]);handlers.get(type).push(fn);},
      fire:async(type,event={})=>{await Promise.all((handlers.get(type)||[]).map(fn=>fn({target:el,...event})));},
      count:type=>(handlers.get(type)||[]).length};nodes.set(selector,el);return el;
  }
  const root={querySelector:s=>nodes.get(s),querySelectorAll:s=>nodes.has(s)?[nodes.get(s)]:[]};
  Object.assign(c,{bindFocusClockPage,focusClockVoiceContext:()=>voice,saveSettings:()=>trace.push('save'),renderModal:()=>trace.push('render'),
    focusClockSyncPreviewButton:()=>trace.push('sync'),focusClockOpenVoiceDrawer:()=>trace.push('drawer'),
    focusClockRequestStart:()=>trace.push('start'),focusClockPause:()=>trace.push('pause'),focusClockReset:()=>trace.push('reset'),
    focusClockPrimeSound:()=>trace.push('prime'),focusClockResetMedia:()=>trace.push('media'),focusClockPlayDoneSound:opts=>trace.push(opts.selectionChanged?'selection':['play',opts.preview]),
    focusClockSetVoiceEnabled:enabled=>trace.push(['enabled',enabled]),focusClockBindVoice:(...args)=>trace.push(['bind',...args]),
    confirmDialog:async()=>confirmed,coread:()=>({books:[{id:'book',title:'Book'}]}),coreadCompanionChoices:()=>[{avatar:'A'}],
    FOCUS_CLOCK_RELATIONS:{neutral:{}},FOCUS_CLOCK_SOUND_PRESETS:{bell:{}},FOCUS_CLOCK_VOICE_FREQUENCIES:{low:{}},focusClockDateKey:stamp=>stamp||'today'});
  vm.runInContext(section('bindFocusClockEvents'),c);
  return {...env,node,root,trace,bind:()=>c.bindFocusClockEvents(root),setVoice:value=>{voice=value;},confirm:value=>{confirmed=value;}};
}
