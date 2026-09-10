import vm from 'node:vm';
import {createFocusVoiceCache} from '../../qianmu-focus-voice-cache.js';
import { createFocusClockRuntime } from '../../qianmu-focus-runtime.js';
import { storyboardFunctionSource } from './storyboard-form-fixture.mjs';

// Characterization seam: only this loader changes when the runtime becomes a real module.
const source = ['focusClockCancelEntry','focusClockRuntimeTick','startFocusClockRuntime','stopFocusClockRuntime'].map(storyboardFunctionSource).join('\n');

export function focusRuntimeFixture(overrides = {}) {
  const events = () => {
    const listeners = new Map();
    return {
      visibilityState:'visible', listeners,
      addEventListener(type,fn) { if (!listeners.has(type)) listeners.set(type,new Set()); listeners.get(type).add(fn); },
      removeEventListener(type,fn) { listeners.get(type)?.delete(fn); },
      dispatch(type) { for (const fn of [...(listeners.get(type) || [])]) fn(); },
      count() { return [...listeners.values()].reduce((sum,set)=>sum+set.size,0); },
    };
  };
  const document=events(),window=events(),timers=new Map(),trace=[],prepared=[],seen=[];
  let nextId=0, state={status:'running',phase:'focus',sessionToken:'original',sessionVoiceCues:[],remainingMs:1000,...overrides};
  const c=vm.createContext({document,window,createFocusClockRuntime,focusClockRuntime:null,focusClockEntryEpoch:0,focusClockLockConfirming:false,
    focusClockLockGuard:{dispose:()=>trace.push('unlock')},focusClockVoiceCache:createFocusVoiceCache({available:()=>false,read:async()=>null}),
    setInterval:(fn,ms)=>{const id=++nextId;timers.set(id,{fn,ms});return id;},clearInterval:id=>timers.delete(id),
    focusClockState:()=>state,focusClockRemainingMs:value=>value.remainingMs,
    focusClockMaybePlayMidCue:value=>seen.push(value),focusClockUpdateDom:()=>trace.push('paint'),
    focusClockComplete:()=>{trace.push('complete');state.status='idle';},
    focusClockVoiceContext:()=>({enabled:true}),focusClockPrepareVoiceCues:token=>prepared.push(token),
    focusClockCancelVoiceWork:()=>trace.push('cancel'),focusClockResetMedia:()=>trace.push('media'),
    focusClockCloseVoiceDrawer:()=>{},
  });
  c.focusClockVoiceCache.remember('cached',{});
  vm.runInContext(source,c);
  return {c,document,window,timers,trace,prepared,seen,get state(){return state;},setState:value=>{state=value;}};
}
