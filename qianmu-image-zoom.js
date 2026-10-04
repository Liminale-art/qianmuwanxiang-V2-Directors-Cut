// Local image viewing only; never reads media metadata or starts network work.
export function clampImageView(value, geometry) {
  const scale=Math.max(1,Math.min(6,Number(value.scale)||1));
  const bound=(image,viewport)=>Math.max(0,(image*scale-viewport)/2);
  const x=bound(geometry.width,geometry.viewWidth),y=bound(geometry.height,geometry.viewHeight);
  return {scale,x:Math.max(-x,Math.min(x,Number(value.x)||0)),y:Math.max(-y,Math.min(y,Number(value.y)||0))};
}

export function zoomImageAt(value, scale, point, geometry) {
  const next=Math.max(1,Math.min(6,Number(scale)||1)),ratio=next/value.scale;
  return clampImageView({scale:next,x:point.x-(point.x-value.x)*ratio,y:point.y-(point.y-value.y)*ratio},geometry);
}

export function bindImageZoom(stage,image,{isCurrent=()=>true,onStale=()=>{},onStep=()=>{},observeResize=globalThis.ResizeObserver}={}) {
  let disposed=false,state={scale:1,x:0,y:0},geometry={width:0,height:0,viewWidth:0,viewHeight:0},center={x:0,y:0};
  let gesture=null,suppressClick=false;const pointers=new Map(),listeners=[];
  const on=(node,type,handler,options)=>{node.addEventListener(type,handler,options);listeners.push(()=>node.removeEventListener(type,handler,options));};
  const valid=()=>{if(disposed)return false;if(!isCurrent()){onStale();return false;}return true;};
  const paint=()=>{
    image.style.transform=`translate3d(${state.x}px,${state.y}px,0) scale(${state.scale})`;
    stage.dataset.imageZoom=String(state.scale);stage.classList.toggle('is-zoomed',state.scale>1.001);
  };
  const measure=()=>{
    if(!valid())return;
    const box=stage.getBoundingClientRect();
    geometry={width:image.offsetWidth,height:image.offsetHeight,viewWidth:box.width,viewHeight:box.height};
    center={x:box.left+box.width/2,y:box.top+box.height/2};state=clampImageView(state,geometry);paint();
  };
  const position=event=>({x:event.clientX-center.x,y:event.clientY-center.y});
  const begin=()=>{
    const points=[...pointers.values()];
    if(points.length>=2){const a=points[0],b=points[1];gesture={kind:'pinch',state:{...state},mid:{x:(a.x+b.x)/2,y:(a.y+b.y)/2},distance:Math.max(1,Math.hypot(a.x-b.x,a.y-b.y))};suppressClick=true;}
    else if(points.length)gesture={kind:'pan',state:{...state},start:points[0],last:points[0],swipe:state.scale<=1.001};
    else gesture=null;
  };
  on(stage,'wheel',event=>{
    if(event.target.closest('button')||!valid())return;event.preventDefault();event.stopPropagation();measure();
    const units=event.deltaMode===1?16:event.deltaMode===2?geometry.viewHeight:1;
    state=zoomImageAt(state,state.scale*Math.exp(-Math.max(-600,Math.min(600,event.deltaY*units))*.002),position(event),geometry);paint();
  },{passive:false});
  on(stage,'pointerdown',event=>{
    if(event.target.closest('button')||event.pointerType==='mouse'&&event.button!==0||!valid())return;
    if(!pointers.size){measure();suppressClick=false;}
    event.preventDefault();event.stopPropagation();pointers.set(event.pointerId,position(event));
    try{stage.setPointerCapture(event.pointerId);}catch(_){}begin();
  });
  on(stage,'pointermove',event=>{
    if(!pointers.has(event.pointerId)||!valid())return;event.preventDefault();event.stopPropagation();pointers.set(event.pointerId,position(event));
    if(gesture?.kind==='pinch'){
      const [a,b]=[...pointers.values()];if(!b)return;
      const mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2},scale=Math.max(1,Math.min(6,gesture.state.scale*Math.hypot(a.x-b.x,a.y-b.y)/gesture.distance)),ratio=scale/gesture.state.scale;
      state=clampImageView({scale,x:mid.x-(gesture.mid.x-gesture.state.x)*ratio,y:mid.y-(gesture.mid.y-gesture.state.y)*ratio},geometry);paint();
    }else if(gesture){
      const point=position(event);gesture.last=point;const dx=point.x-gesture.start.x,dy=point.y-gesture.start.y;
      if(Math.hypot(dx,dy)>7)suppressClick=true;
      if(!gesture.swipe){state=clampImageView({...gesture.state,x:gesture.state.x+dx,y:gesture.state.y+dy},geometry);paint();}
    }
  });
  const finish=(event,cancel=false)=>{
    if(!pointers.has(event.pointerId))return;
    const lastGesture=gesture,wasSingle=pointers.size===1;pointers.delete(event.pointerId);
    try{stage.releasePointerCapture(event.pointerId);}catch(_){}
    if(!cancel&&wasSingle&&lastGesture?.kind==='pan'&&lastGesture.swipe&&valid()){
      const end=position(event),dx=end.x-lastGesture.start.x,dy=end.y-lastGesture.start.y;
      if(Math.abs(dx)>48&&Math.abs(dx)>Math.abs(dy)*1.5){suppressClick=true;onStep(dx<0?1:-1);}
    }
    // A remaining finger after a pinch can pan, but must never become a page swipe.
    begin();if(gesture&&suppressClick)gesture.swipe=false;
  };
  on(stage,'pointerup',event=>finish(event));on(stage,'pointercancel',event=>finish(event,true));
  on(stage,'lostpointercapture',event=>{if(pointers.has(event.pointerId))finish(event,true);});
  on(stage,'click',event=>{if(suppressClick&&!event.target.closest('button')){event.preventDefault();event.stopPropagation();suppressClick=false;}},true);
  on(image,'dragstart',event=>event.preventDefault());
  on(stage,'dblclick',event=>{if(event.target.closest('button')||!valid())return;event.preventDefault();measure();state=zoomImageAt(state,state.scale>1?1:2,position(event),geometry);paint();});
  on(image,'load',measure);const observer=typeof observeResize==='function'?new observeResize(measure):null;observer?.observe(stage);
  measure();
  return {reset(){if(valid()){state={scale:1,x:0,y:0};for(const id of pointers.keys())try{stage.releasePointerCapture(id);}catch(_){}pointers.clear();gesture=null;measure();}},
    getState:()=>({...state}),dispose(){if(disposed)return;disposed=true;observer?.disconnect();listeners.forEach(remove=>remove());
      for(const id of pointers.keys())try{stage.releasePointerCapture(id);}catch(_){}pointers.clear();gesture=null;image.style.transform='';delete stage.dataset.imageZoom;stage.classList.remove('is-zoomed');}};
}
