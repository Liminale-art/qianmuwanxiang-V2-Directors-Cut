// Only validated, live-scope progress may renew the idle deadline. A separate
// hard deadline always remains; this never retries work or extends authority.
export function createVerifiedProgressWatch({idleMs,totalMs=1800000,onTimeout,setTimer=setTimeout,clearTimer=clearTimeout}={}){
  if(typeof onTimeout!=='function')throw new TypeError('Missing timeout handler');
  const idle=Math.max(100,Math.min(300000,Number(idleMs)||180000)),total=Math.max(idle,Math.min(1800000,Number(totalMs)||1800000));
  let idleTimer,hardTimer,stopped=false;
  const stop=()=>{if(stopped)return;stopped=true;clearTimer(idleTimer);clearTimer(hardTimer);};
  const expire=kind=>{if(stopped)return;stop();onTimeout(kind);};
  const progress=()=>{if(stopped)return;clearTimer(idleTimer);idleTimer=setTimer(()=>expire('idle'),idle);};
  hardTimer=setTimer(()=>expire('total'),total);progress();return Object.freeze({progress,stop});
}
