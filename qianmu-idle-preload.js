// Code-only warming: no text reads, DOM construction, database access or model calls.
const LOADERS=[()=>import('./qianmu-text-collection-library.js'),()=>import('./qianmu-prose-assistant-panel.js'),()=>import('./qianmu-text-collection-capture.js')];
export function scheduleQianmuIdlePreload({window=globalThis.window,document=globalThis.document,isCurrent=()=>true,isBusy=()=>false,loaders=LOADERS,now=Date.now,quietMs=5000}={}){
 if(!window?.addEventListener||!document?.addEventListener)return ()=>{};
 let stopped=false,timer=null,idle=null,index=0,running=false,lastActivity=now();
 const activity=()=>{lastActivity=now();};
 const valid=()=>!stopped&&isCurrent()===true;
 const blocked=()=>document.hidden||document.readyState==='loading'||window.navigator?.onLine===false||window.navigator?.connection?.saveData||/^(slow-)?2g$/.test(window.navigator?.connection?.effectiveType||'')||isBusy()||now()-lastActivity<quietMs||window.navigator?.scheduling?.isInputPending?.();
 const schedule=()=>{if(valid()&&index<loaders.length)timer=window.setTimeout(check,quietMs);};
 async function work(deadline){
  idle=null;if(!valid()||running)return;
  if(blocked()||deadline&&deadline.timeRemaining()<8){schedule();return;}
  running=true;const load=loaders[index++];try{await load();}catch{/* An explicit click remains free to retry. */}
  finally{running=false;schedule();}
 }
 function check(){timer=null;if(!valid())return;if(blocked()){schedule();return;}
  if(window.requestIdleCallback)idle=window.requestIdleCallback(work);else void work();
 }
 for(const type of ['pointerdown','keydown','input','wheel'])document.addEventListener(type,activity,{capture:true,passive:true});
 schedule();return ()=>{stopped=true;window.clearTimeout(timer);if(idle!==null)window.cancelIdleCallback?.(idle);for(const type of ['pointerdown','keydown','input','wheel'])document.removeEventListener(type,activity,true);};
}
