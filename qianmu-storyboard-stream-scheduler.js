import {storyboardStableStreamBoundary} from './qianmu-storyboard-stream-source.js?v=1.59.256';

// One explicit compiler pass. A boolean return alone cannot distinguish a
// harmless wait from an exhausted format-repair batch. No extra repair budget.
export async function runStoryboardStreamPass(api,stream){
  let status='failed',outcome=null;
  try{
    await api.compile(null,{quiet:true,automatic:true,stream:{...stream,trackAttempt:true},
      onStreamOutcome:value=>{status=value?.status||'failed';},
      onPrepared:async prepared=>{try{outcome=await api.submit(prepared);}catch(error){outcome=error?.streamOutcome||outcome;throw error;}}});
  }catch(_){status='failed';}
  const queued=Number.isSafeInteger(outcome?.queued)&&outcome.queued>=0?outcome.queued:0;
  if(outcome?.failed)status='failed';
  else if(status==='ready')status=queued?'advanced':'waiting';
  if(!['busy','waiting','advanced','cancelled','failed'].includes(status))status='failed';
  return Object.freeze({status,queued});
}

// One borrowed reply lifetime. The host adapter owns identity/edit events and
// explicitly supplies pulses, idle wakeups and one final handoff. This module
// installs no event listener, does not poll, and never reads a token argument.
export function createStoryboardStreamScheduler(d){
  const controller=new AbortController(),setTimer=d.setTimer||setTimeout,clearTimer=d.clearTimer||clearTimeout,now=d.now||Date.now;
  const interval=Number.isFinite(d.intervalMs)?Math.max(0,Math.min(10000,d.intervalMs)):2500;
  const limit=Number.isSafeInteger(d.maxPasses)?Math.max(1,Math.min(4,d.maxPasses)):3;
  let closed=false,finishing=false,failed=false,dirty=false,timer=null,pending=null,finalPromise=null;
  let passes=0,queued=0,lastStarted=-Infinity,lastPrefix='';
  const current=()=>{try{return !closed&&!controller.signal.aborted&&d.isCurrent()===true;}catch(_){return false;}};
  const clear=()=>{if(timer!==null)clearTimer(timer);timer=null;};
  const stop=()=>{failed=true;dirty=false;clear();};
  function schedule(){
    if(!current()||finishing||failed||!dirty||passes>=limit||pending||timer!==null||d.busy())return;
    timer=setTimer(()=>{timer=null;void drain().catch(()=>stop());},Math.max(120,interval-(now()-lastStarted)));
  }
  async function drain(){
    if(!current()||finishing||failed||pending||passes>=limit||!dirty)return;
    if(d.busy())return; // An explicit idle wakeup, not a retry timer, resumes this.
    let raw;
    try{raw=d.read();}catch(_){stop();return;}
    if(typeof raw!=='string'||lastPrefix&&!raw.startsWith(lastPrefix)){stop();return;}
    const boundary=storyboardStableStreamBoundary(raw),prefix=boundary?raw.slice(0,boundary).trimEnd():'';
    dirty=false;if(!prefix||prefix===lastPrefix)return;
    const previous=lastPrefix;lastPrefix=prefix;passes++;lastStarted=now();
    // Reserve synchronously, before calling any asynchronous compiler code.
    const operation=Promise.resolve().then(()=>current()?d.run({signal:controller.signal}):{status:'cancelled',queued:0});
    pending=operation;
    try{
      const result=await operation;
      if(!current())return;
      queued+=Number.isSafeInteger(result?.queued)&&result.queued>0?result.queued:0;
      if(result?.status==='busy'){passes--;lastPrefix=previous;dirty=true;return;}
      if(!['waiting','advanced'].includes(result?.status)){stop();return;}
    }catch(_){stop();}
    finally{if(pending===operation)pending=null;}
    schedule();
  }
  const finalize=()=>{
    if(finalPromise)return finalPromise;
    finishing=true;dirty=false;clear();
    finalPromise=(async()=>{
      // Wait for the already-started pass, so its occupied slots are visible to
      // the final compiler. Never submit both against the same empty allowance.
      if(pending)try{await pending;}catch(_){}
      if(!current()||failed)return false;
      if(lastPrefix){let raw;try{raw=d.read();}catch(_){return false;}if(typeof raw!=='string'||!raw.startsWith(lastPrefix))return false;}
      return Boolean(await d.finish({signal:controller.signal}));
    })().catch(()=>false);
    return finalPromise;
  };
  return Object.freeze({
    pulse(){if(!current()||finishing||failed)return;dirty=true;schedule();},
    wake(){schedule();},finalize,
    close(){closed=true;dirty=false;clear();controller.abort();},
    get status(){return Object.freeze({closed,finishing,failed,passes,queued,pending:Boolean(pending),scheduled:timer!==null});},
  });
}
