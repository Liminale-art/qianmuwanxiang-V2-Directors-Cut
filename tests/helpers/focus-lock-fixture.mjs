import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {inspectFocusLock} from '../../qianmu-focus-lock.js';
import {focusClockFormat} from '../../qianmu-focus-time.js';
import {storyboardFunctionSource as section} from './storyboard-form-fixture.mjs';

const source=await readFile(new URL('../../index.js',import.meta.url),'utf8');
export const focusDefaults=vm.runInNewContext('('+source.match(/  focusClock: (\{[\s\S]*?^  \}),\r?\n  \/\/ 分镜/m)[1]+')');
export const focusFunctions=['focusClockActiveLock','focusClockBlockExit','focusClockReleaseLock','focusClockReaderReady','focusClockRequestStart','focusClockEnableLock',
  'focusClockStart','focusClockPause','focusClockReset','focusClockComplete','focusClockShowPanel','focusClockEnterReading','focusClockRestoreLock',
  'focusClockPhaseMs','focusClockRemainingMs','focusClockPauseForReadingExit','focusClockResumeReading'].map(section).join('\n');

export function focusFixture(overrides={}){
  let now=100000,sequence=0;const notices=[],calls=[];
  const f=structuredClone(focusDefaults);Object.assign(f,overrides);
  const c=vm.createContext({settings:{enabled:true,focusClock:f},DEFAULT_SETTINGS:{focusClock:structuredClone(focusDefaults)},
    focusClockState:()=>f,focusClockEntryBusy:false,focusClockLockConfirming:false,focusClockLockOwner:'device',focusClockLockGuard:null,
    inspectFocusLock,focusClockFormat,Date:class extends Date{static now(){return now;}},FOCUS_CLOCK_WEEK_ENTRY_LIMIT:160,
    FOCUS_CLOCK_PHASES:{focus:{setting:'focusMinutes',label:'专注'},shortBreak:{setting:'shortBreakMinutes',label:'小憩'},longBreak:{setting:'longBreakMinutes',label:'长休'}},
    readerView:null,readerContentCache:null,activeTab:'focus',document:{querySelector:()=>null,querySelectorAll:()=>[],createElement:()=>({inert:false})},
    coreadBookMeta:id=>id==='book'?{id,title:'Book',progress:20}:null,saveSettings:()=>calls.push('save'),uid:()=>`id-${++sequence}`,
    focusClockVoicePrepareSeq:0,focusClockCancelVoiceWork:()=>{},focusClockVoiceContext:()=>({enabled:false}),focusClockPrimeSound:()=>{},focusClockUpdateDom:()=>{},
    startFocusClockRuntime:()=>{},focusClockPlayCompletionAlert:async()=>{},focusClockPrepareVoiceCues:async()=>{},
    focusClockAttachLock:()=>calls.push('attach'),focusClockOwnerId:()=> 'device',confirmDialog:async()=>true,
    isModalOpen:()=>true,renderModal:()=>calls.push('render'),toast:message=>notices.push(message),
    ensureCoreadReaderRuntime:async()=>{},refreshReaderPortal:()=>{},openModal:()=>calls.push('open'),
    coreadSaveProgress:()=>calls.push('progress'),coreadPendingChatImages:()=>[],unmountReaderPortal:()=>calls.push('unmount'),
    coreadOpenBook:async()=>{},console});
  vm.runInContext(focusFunctions,c);
  return {c,f,notices,calls,setNow:value=>now=value};
}
