// Device-only geometry; no conversation content is stored here.
export function bindProseAssistantWindow(panel,{handle,storageKey,initial={},margin=10,minWidth=280,minHeight=220,defaultWidth=.88,defaultHeight=.68,maxDefaultWidth=540,maxDefaultHeight=600,resizeSelector='[data-pa-resize]',onPersist=()=>{}}={}){
 const view=panel.ownerDocument.defaultView,viewport=view.visualViewport,listeners=[];let gesture=null,closed=false,touched=false;
 const listen=(node,type,fn)=>{node?.addEventListener(type,fn);listeners.push(()=>node?.removeEventListener(type,fn));};
  function fit(value={},anchorY=null){const x=viewport?.offsetLeft||0,y=viewport?.offsetTop||0,w=viewport?.width||view.innerWidth,h=viewport?.height||view.innerHeight;
  const number=(v,f)=>Number.isFinite(v)?v:f,maxW=Math.max(1,w-margin*2),maxH=Math.max(1,h-margin*2),boundedMinWidth=Math.min(minWidth,maxW),boundedMinHeight=Math.min(minHeight,maxH);
  let width=Math.max(boundedMinWidth,Math.min(maxW,number(value.width,Math.min(w*defaultWidth,maxDefaultWidth))));
  let height=Math.max(boundedMinHeight,Math.min(maxH,number(value.height,Math.min(h*defaultHeight,maxDefaultHeight))));
  const nextX=Math.max(x+margin,Math.min(x+w-margin-width,number(value.x,x+(w-width)/2)));
  if(anchorY!==null){
   const fixedY=Math.max(y+margin,Math.min(y+h-margin-boundedMinHeight,number(anchorY,y+(h-height)/2)));
   height=Math.min(height,Math.max(boundedMinHeight,y+h-margin-fixedY));
   return {width,height,x:nextX,y:fixedY};
  }
  return {width,height,x:nextX,y:Math.max(y+margin,Math.min(y+h-margin-height,number(value.y,y+(h-height)/2)))};
 }
 const readSaved=()=>{let stored={};try{if(storageKey){const value=JSON.parse(view.localStorage.getItem(storageKey)||'{}');if(value&&typeof value==='object'&&!Array.isArray(value))stored=value;}}catch{}for(const [key,value]of Object.entries(initial||{}))if(value!==null&&value!==undefined&&Number.isFinite(Number(value)))stored[key]=Number(value);return {...stored};};
 let saved=readSaved();
 let box=fit(saved),preferred={...box};const paint=()=>{panel.style.setProperty('left',`${box.x}px`,'important');panel.style.setProperty('top',`${box.y}px`,'important');panel.style.setProperty('width',`${box.width}px`,'important');panel.style.setProperty('height',`${box.height}px`,'important');};paint();
 const persist=()=>{touched=true;try{if(storageKey)view.localStorage.setItem(storageKey,JSON.stringify(box));}catch{}try{onPersist({...box});}catch{}};
 function finish(event,cancelled=false){if(!gesture||event?.pointerId!==undefined&&event.pointerId!==gesture.id)return;const last=gesture;gesture=null;try{last.node.releasePointerCapture(last.id);}catch{}if(cancelled)box=fit(last.initial);else preferred={...box};paint();if(!cancelled)persist();}
 function start(event,resize){if(gesture||event.isPrimary===false||event.button!==undefined&&event.button!==0||!resize&&event.target.closest('button,input,select,textarea'))return;gesture={id:event.pointerId,x:event.clientX,y:event.clientY,initial:{...box},node:event.currentTarget,resize};try{event.currentTarget.setPointerCapture(event.pointerId);}catch{}event.preventDefault();}
 function move(event){if(!gesture||event.pointerId!==gesture.id)return;const dx=event.clientX-gesture.x,dy=event.clientY-gesture.y;box=gesture.resize?fit({...gesture.initial,width:gesture.initial.width+dx,height:gesture.initial.height+dy},gesture.initial.y):fit({...gesture.initial,x:gesture.initial.x+dx,y:gesture.initial.y+dy});paint();event.preventDefault();}
 const resize=panel.querySelector(resizeSelector);
 for(const [node,type] of [[handle,false],[resize,true]]){listen(node,'pointerdown',event=>start(event,type));listen(node,'pointermove',move);listen(node,'pointerup',event=>finish(event));listen(node,'pointercancel',event=>finish(event,true));listen(node,'lostpointercapture',event=>finish(event,true));}
 // Pointer capture normally retargets these events to the handle. Keep a
 // window-level fallback as well so ST hosts that swallow capture still drag.
 listen(view,'pointermove',move); listen(view,'pointerup',event=>finish(event)); listen(view,'pointercancel',event=>finish(event,true));
 listen(resize,'keydown',event=>{const step=event.shiftKey?32:8,delta={ArrowLeft:[-step,0],ArrowRight:[step,0],ArrowUp:[0,-step],ArrowDown:[0,step]}[event.key];if(!delta)return;event.preventDefault();box=fit({...box,width:box.width+delta[0],height:box.height+delta[1]},box.y);preferred={...box};paint();persist();});
 const adjust=()=>{if(!closed){box=fit(preferred);paint();}};listen(view,'resize',adjust);listen(viewport,'resize',adjust);listen(viewport,'scroll',adjust);
 const dispose=()=>{if(closed)return;finish(undefined,false);closed=true;listeners.splice(0).forEach(remove=>remove());};
 // Show/drag/resize immediately without borrowing another account's geometry.
 // Only attach account-local preferences after the live identity is confirmed.
 dispose.setStorageKey=key=>{if(closed||typeof key!=='string'||!key)return;storageKey=key;if(gesture){touched=true;return;}if(touched){persist();return;}box=fit(readSaved());preferred={...box};paint();};
 return dispose;
}
