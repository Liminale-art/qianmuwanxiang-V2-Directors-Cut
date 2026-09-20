// A detachable entry, not another assistant session. Geometry stays on this device.
export function createProseHive({open,geometry,clamp,palette,theme,outline,applyIcons,mount,canDock,closeWheel,document=globalThis.document,window=globalThis.window}={}) {
  const key='qianmu-prose-hive-device-v1';let state={detached:false,position:null,tone:'dark',edge:0},layer=null,unmount=null,disposed=false;
  try { const saved=JSON.parse(window.localStorage.getItem(key));if(saved&&typeof saved.detached==='boolean')state={...state,...saved}; } catch {}
  const save=()=>{try{window.localStorage.setItem(key,JSON.stringify(state));}catch{/* Geometry failure must not prevent opening the assistant. */}};
  const isolate=event=>event.stopPropagation();
  function remove(){unmount?.();unmount=null;layer?.remove();layer=null;}
  function render(){
    if(disposed)return;remove();if(!state.detached)return;
    const size=geometry(),position=clamp(state.position||{}),colors=palette(),tone=state.tone==='light'?'light':'dark';
    layer=document.createElement('div');layer.className=`qm-prose-hive-layer sd-hive-theme-${theme()}`;layer.dataset.qianmuTransient='';
    const entry=document.createElement('button');entry.type='button';entry.className=`sd-detached-notes-entry is-glass-${tone}`;
    entry.dataset.hiveTone=tone;entry.dataset.hiveEdgeIndex=String(Math.max(0,Math.trunc(Number(state.edge)||0)));
    entry.title='正文助手（拖回千幕归巢）';entry.setAttribute('aria-label','打开正文助手');
    entry.innerHTML=`<i class="fa-solid fa-comments"></i>${outline}`;
    for(const [name,value] of Object.entries({'left':`${position.x}px`,'top':`${position.y}px`,'--sd-notes-entry-width':`${size.width}px`,'--sd-notes-entry-height':`${size.height}px`,'--sd-wheel-glass-fill':colors[tone+'Fill'],'--sd-wheel-icon':colors[tone+'Icon'],'--sd-wheel-edge':colors.edges[Math.max(0,Math.trunc(Number(state.edge)||0))%colors.edges.length]}))entry.style.setProperty(name,value);
    layer.append(entry);document.body.append(layer);applyIcons?.(layer);unmount=mount?.(layer);
    for(const type of ['mousedown','touchstart','click'])entry.addEventListener(type,isolate);
    bindDrag(entry,false);
  }
  function bindDrag(button,fromHive,layout={}){
    button.style.touchAction='none';
    let drag=null,suppressed=false;
    button.addEventListener('pointerdown',event=>{
      if(event.isPrimary===false||(event.button!=null&&event.button!==0))return;
      event.stopPropagation();const rect=button.getBoundingClientRect();drag={id:event.pointerId,x:event.clientX,y:event.clientY,left:rect.left,top:rect.top,moved:false,ready:false};
      try{button.setPointerCapture(event.pointerId);}catch{}
    });
    button.addEventListener('pointermove',event=>{
      if(!drag||event.pointerId!==drag.id)return;event.stopPropagation();
      const dx=event.clientX-drag.x,dy=event.clientY-drag.y,distance=Math.hypot(dx,dy);if(!drag.moved&&distance<=8)return;
      drag.moved=true;event.preventDefault();
      if(fromHive){drag.ready=distance>=Math.max(54,Number(layout.itemSize||36)*1.25);button.style.setProperty('transform',`translate3d(${dx}px,${dy}px,0)`,'important');button.classList.toggle('is-undock-ready',drag.ready);}
      else{const pos=clamp({x:drag.left+dx,y:drag.top+dy});button.style.left=`${pos.x}px`;button.style.top=`${pos.y}px`;button.classList.toggle('is-return-ready',canDock(button));}
    });
    const finish=(event,cancelled=false)=>{
      if(!drag||event.pointerId!==drag.id)return;event.stopPropagation();const previous=drag;drag=null;
      try{button.releasePointerCapture(previous.id);}catch{}
      button.style.removeProperty('transform');button.classList.remove('is-undock-ready','is-return-ready');
      if(!previous.moved)return;suppressed=true;window.setTimeout(()=>{suppressed=false;},0);
      if(cancelled){if(!fromHive)render();return;}
      if(fromHive){if(!previous.ready)return;const size=geometry();state={detached:true,position:clamp({x:event.clientX-size.width/2,y:event.clientY-size.height/2}),tone:button.dataset.hiveTone,edge:Number(button.dataset.hiveEdgeIndex)||0};closeWheel();}
      else{state.position=clamp({x:parseFloat(button.style.left),y:parseFloat(button.style.top)});if(canDock(button))state.detached=false;}
      save();render();
    };
    button.addEventListener('pointerup',event=>finish(event));button.addEventListener('pointercancel',event=>finish(event,true));button.addEventListener('lostpointercapture',event=>finish(event,true));
    button.addEventListener('click',event=>{if(suppressed){event.preventDefault();event.stopImmediatePropagation();return;}if(!fromHive){event.stopPropagation();void open();}},true);
  }
  const resized=()=>{
    const button=layer?.querySelector('button');if(disposed||!button)return;
    const size=geometry(),position=clamp(state.position||{});
    button.style.left=`${position.x}px`;button.style.top=`${position.y}px`;
    button.style.setProperty('--sd-notes-entry-width',`${size.width}px`);button.style.setProperty('--sd-notes-entry-height',`${size.height}px`);
  };window.addEventListener('resize',resized);window.visualViewport?.addEventListener('resize',resized);
  return Object.freeze({render,bind(button,item,layout){if(item?.id==='assistant')bindDrag(button,true,layout);},get detached(){return state.detached;},dispose(){disposed=true;remove();window.removeEventListener('resize',resized);window.visualViewport?.removeEventListener('resize',resized);}});
}
