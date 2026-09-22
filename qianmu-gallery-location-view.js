import {createGalleryLocation} from './qianmu-gallery-location.js';

const fail=message=>{throw Error(message);};
const clean=value=>String(value??'').replace(/\s+/g,' ').trim();
// Only ST's chat scroller moves. The parent dialog closes only once the exact
// target is present and reverified; failed loads leave its preview available.
export async function revealGalleryLocation(input,{document,loadHost,confirmLarge,beforeReveal=()=>{},signal,
  frame=()=>new Promise(done=>document.defaultView.requestAnimationFrame(()=>done())),timeoutMs=45000}={}){
  const lifetime=new AbortController();
  let lease,timer,cancel,ended=false;const stopped=new Promise((_,reject)=>{cancel=()=>{ended=true;lifetime.abort();lease?.close();reject(Error('正文定位已取消或超时'));};});
  const active=()=>{if(ended||signal?.aborted)fail('正文定位已取消');};
  signal?.addEventListener('abort',cancel,{once:true});timer=setTimeout(cancel,Math.min(60000,Math.max(1,timeoutMs)));
  try{return await Promise.race([(async()=>{
    active();const opened=await createGalleryLocation({...input,signal:lifetime.signal});if(ended){opened.close();active();}lease=opened;
    let position=lease.assertCurrent();const chat=document.getElementById('chat');if(!chat)fail('ST 正文容器尚未就绪');
    const target=()=>{active();const matches=[...chat.querySelectorAll(`.mes[mesid="${position.floor}"], .mes[data-message-id="${position.floor}"]`)];
      if(matches.length>1)fail('正文界面出现重复楼层，未定位');return matches[0];};
    let row=target();if(!row){
      let first=input.getContext().chat.length;
      for(const node of chat.querySelectorAll('.mes')){const raw=node.getAttribute('mesid')??node.getAttribute('data-message-id'),id=Number(raw);
        if(raw!==null&&String(raw).trim()&&Number.isSafeInteger(id)&&id>=0)first=Math.min(first,id);}
      const count=Math.max(1,first-position.floor);
      if(count>300){if(typeof confirmLarge!=='function'||!await confirmLarge(count)){active();return {status:'cancelled'};}active();position=await lease.verify();}
      const host=await loadHost();active();await lease.verify();active();if(typeof host?.showMoreMessages!=='function')fail('当前 ST 未提供历史楼层加载接口');
      await host.showMoreMessages(count);active();await frame();active();position=await lease.verify();row=target();
    }
    if(!row?.isConnected||!chat.contains(row))fail('原楼层尚未呈现，未关闭画面或猜跳');
    let focus=row;
    if(position.paragraphIndex!==null){const text=row.querySelector('.mes_text'),matches=[...(text?.querySelectorAll('p,li,blockquote')||[])].filter(node=>clean(node.textContent)===clean(position.paragraphText));
      if(matches.length===1)focus=matches[0];}
    active();lease.assertCurrent();beforeReveal();active();await frame();active();lease.assertCurrent();
    const verified=await lease.verify();active();
    if(verified.floor!==position.floor||verified.paragraphText!==position.paragraphText||target()!==row
      ||!row.isConnected||!focus.isConnected||!chat.contains(focus)||document.getElementById('chat')!==chat)fail('正文界面已变化，未滚动到旧位置');
    const area=chat.getBoundingClientRect(),box=focus.getBoundingClientRect();
    chat.scrollTo({top:Math.max(0,chat.scrollTop+box.top-area.top-Math.max(0,(chat.clientHeight-box.height)/2)),behavior:'auto'});
    return {status:'located',floor:position.floor,paragraph:focus!==row,kind:position.kind,readOnly:true};
  })(),stopped]);}finally{ended=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);lifetime.abort();lease?.close();}
}
