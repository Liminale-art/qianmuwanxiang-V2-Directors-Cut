// Code-only warming: no text reads, DOM construction, database access or model calls.
import {loadLocalChunk} from './qianmu-feature-runtime.js?v=1.59.385';
export const QIANMU_IDLE_CHUNKS=Object.freeze([
 './qianmu-prose-assistant-panel.js','./qianmu-prose-assistant-native.js?v=1.59.385',
 './qianmu-text-collection-library.js','./qianmu-character-archive-view.js?v=1.59.385',
 './qianmu-vibe-library-view.js?v=1.59.385','./qianmu-ensemble-ui.js?v=1.59.385',
 './qianmu-comfy-library-view.js?v=1.59.385','./qianmu-comfy-pool-view.js?v=1.59.385',
 './qianmu-comfy-route.js?v=1.59.385','./qianmu-text-collection-capture.js',
]);
const LOADERS=QIANMU_IDLE_CHUNKS.map(url=>()=>loadLocalChunk(url));
export function scheduleQianmuIdlePreload({window=globalThis.window,document=globalThis.document,isCurrent=()=>true,isBusy=()=>false,loaders=LOADERS,now=Date.now,quietMs=5000}={}){
 if(!window?.addEventListener||!document?.addEventListener)return ()=>{};
 let stopped=false,timer=null,idle=null,index=0,running=false,lastActivity=now();
 const activity=()=>{lastActivity=now();};
 const valid=()=>!stopped&&isCurrent()===true;
 const blocked=()=>document.hidden||document.readyState==='loading'||window.navigator?.onLine===false||window.navigator?.connection?.saveData||/^(slow-)?2g$/.test(window.navigator?.connection?.effectiveType||'')||isBusy()||now()-lastActivity<quietMs||window.navigator?.scheduling?.isInputPending?.();
 function stop(){if(stopped)return;stopped=true;window.clearTimeout(timer);if(idle!==null)window.cancelIdleCallback?.(idle);for(const type of ['pointerdown','keydown','input','wheel'])document.removeEventListener(type,activity,{capture:true});window.removeEventListener('pagehide',stop);}
 const schedule=(delay=quietMs)=>{if(!valid()||index>=loaders.length){stop();return;}timer=window.setTimeout(check,delay);};
 async function work(deadline){
  idle=null;if(!valid()){stop();return;}if(running)return;
  if(blocked()||deadline&&deadline.timeRemaining()<8){schedule();return;}
  running=true;const load=loaders[index++];try{await load();}catch{/* An explicit click remains free to retry. */}
  // Once the page is quiet, take another idle slot instead of adding a new
  // five-second waterfall per module. Activity/streaming is checked each time.
  finally{running=false;schedule(0);}
 }
 function check(){timer=null;if(!valid()){stop();return;}if(blocked()){schedule();return;}
  if(window.requestIdleCallback)idle=window.requestIdleCallback(work);else void work();
 }
 for(const type of ['pointerdown','keydown','input','wheel'])document.addEventListener(type,activity,{capture:true,passive:true});
 window.addEventListener('pagehide',stop);schedule();return stop;
}
