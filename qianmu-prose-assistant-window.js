// Device-only geometry; no conversation content is stored here.
export function bindProseAssistantWindow(panel,{handle,storageKey}={}){
 const view=panel.ownerDocument.defaultView,viewport=view.visualViewport,listeners=[];let gesture=null,closed=false;
 const listen=(node,type,fn)=>{node?.addEventListener(type,fn);listeners.push(()=>node?.removeEventListener(type,fn));};
 function fit(value={}){const x=viewport?.offsetLeft||0,y=viewport?.offsetTop||0,w=viewport?.width||view.innerWidth,h=viewport?.height||view.innerHeight;
  const number=(v,f)=>Number.isFinite(v)?v:f,maxW=Math.max(1,w-20),maxH=Math.max(1,h-20);
  const width=Math.max(Math.min(280,maxW),Math.min(maxW,number(value.width,Math.min(w*.88,540))));
  const height=Math.max(Math.min(220,maxH),Math.min(maxH,number(value.height,Math.min(h*.68,600))));
  return {width,height,x:Math.max(x+10,Math.min(x+w-10-width,number(value.x,x+(w-width)/2))),y:Math.max(y+10,Math.min(y+h-10-height,number(value.y,y+(h-height)/2)))};
 }
 let saved={};try{saved=JSON.parse(view.localStorage.getItem(storageKey)||'{}')||{};}catch{}
 let box=fit(saved),preferred={...box};const paint=()=>{for(const [name,value] of Object.entries({left:box.x,top:box.y,width:box.width,height:box.height}))panel.style[name]=`${value}px`;};paint();
 const persist=()=>{try{view.localStorage.setItem(storageKey,JSON.stringify(box));}catch{}};
 function finish(event,cancelled=false){if(!gesture||event?.pointerId!==undefined&&event.pointerId!==gesture.id)return;const last=gesture;gesture=null;try{last.node.releasePointerCapture(last.id);}catch{}if(cancelled)box=fit(last.initial);else preferred={...box};paint();if(!cancelled)persist();}
 function start(event,resize){if(gesture||event.isPrimary===false||event.button!==undefined&&event.button!==0||!resize&&event.target.closest('button,input,select,textarea'))return;gesture={id:event.pointerId,x:event.clientX,y:event.clientY,initial:{...box},node:event.currentTarget,resize};try{event.currentTarget.setPointerCapture(event.pointerId);}catch{}event.preventDefault();}
 function move(event){if(!gesture||event.pointerId!==gesture.id)return;const dx=event.clientX-gesture.x,dy=event.clientY-gesture.y;box=fit(gesture.resize?{...gesture.initial,width:gesture.initial.width+dx,height:gesture.initial.height+dy}:{...gesture.initial,x:gesture.initial.x+dx,y:gesture.initial.y+dy});paint();event.preventDefault();}
 const resize=panel.querySelector('[data-pa-resize]');
 for(const [node,type] of [[handle,false],[resize,true]]){listen(node,'pointerdown',event=>start(event,type));listen(node,'pointermove',move);listen(node,'pointerup',event=>finish(event));listen(node,'pointercancel',event=>finish(event,true));listen(node,'lostpointercapture',event=>finish(event,true));}
 listen(resize,'keydown',event=>{const step=event.shiftKey?32:8,delta={ArrowLeft:[-step,0],ArrowRight:[step,0],ArrowUp:[0,-step],ArrowDown:[0,step]}[event.key];if(!delta)return;event.preventDefault();box=fit({...box,width:box.width+delta[0],height:box.height+delta[1]});preferred={...box};paint();persist();});
 const adjust=()=>{if(!closed){box=fit(preferred);paint();}};listen(view,'resize',adjust);listen(viewport,'resize',adjust);listen(viewport,'scroll',adjust);
 return ()=>{closed=true;finish(undefined,true);listeners.splice(0).forEach(remove=>remove());};
}
