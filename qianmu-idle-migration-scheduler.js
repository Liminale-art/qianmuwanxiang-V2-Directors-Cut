// Shared scheduling only: importing a library's idle policy must not load a
// different library's migration, backup or document codecs on its first open.
export function scheduleCollectionMigrationSteps({window,document,isCurrent,isBusy=()=>false,step,onFinish=()=>{},now=Date.now}={}){
  let stopped=false,timer=null,idle=null,running=false,lastActivity=now();
  const activity=()=>{lastActivity=now();};
  const blocked=()=>document.hidden||document.readyState==='loading'||window.navigator?.onLine===false
    ||window.navigator?.connection?.saveData||/^(slow-)?2g$/.test(window.navigator?.connection?.effectiveType||'')
    ||now()-lastActivity<5000||window.navigator?.scheduling?.isInputPending?.()||isBusy();
  function stop(cause){if(stopped)return;stopped=true;window.clearTimeout(timer);if(idle!==null)window.cancelIdleCallback?.(idle);
    for(const type of ['pointerdown','keydown','input','wheel'])document.removeEventListener(type,activity,true);
    window.removeEventListener('pagehide',pagehide);onFinish(cause);}
  const pagehide=()=>stop(new Error('page closed'));
  const schedule=delay=>{if(!stopped)timer=window.setTimeout(tick,delay);};
  async function work(deadline){
    idle=null;if(stopped||running)return;
    try{if(!isCurrent()){stop(new Error('scope changed'));return;}
      if(blocked()||deadline&&deadline.timeRemaining()<8){schedule(5000);return;}
      running=true;const result=await step();if(result.done)stop();else schedule(750);}
    catch(cause){stop(cause);}finally{running=false;}
  }
  function tick(){timer=null;if(stopped)return;try{if(!isCurrent()){stop(new Error('scope changed'));return;}
    if(blocked()){schedule(5000);return;}
    if(window.requestIdleCallback)idle=window.requestIdleCallback(work);else return work();}catch(cause){stop(cause);}}
  for(const type of ['pointerdown','keydown','input','wheel'])document.addEventListener(type,activity,{capture:true,passive:true});
  window.addEventListener('pagehide',pagehide);schedule(5000);return stop;
}
