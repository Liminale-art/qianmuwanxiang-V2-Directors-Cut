import test from 'node:test';
import assert from 'node:assert/strict';
import {clampImageView,zoomImageAt,bindImageZoom} from '../qianmu-image-zoom.js';

const geometry={width:300,height:500,viewWidth:320,viewHeight:568};
test('zoom stays between fit and 6x, clamps panning, and fits fully when reset',()=>{
  assert.deepEqual(clampImageView({scale:0,x:100,y:100},geometry),{scale:1,x:0,y:0});
  assert.deepEqual(clampImageView({scale:50,x:5000,y:-5000},geometry),{scale:6,x:740,y:-1216});
  assert.deepEqual(zoomImageAt({scale:2,x:60,y:40},1,{x:200,y:200},geometry),{scale:1,x:0,y:0});
});
test('cursor zoom keeps the touched image point stable until an edge is reached',()=>{
  assert.deepEqual(zoomImageAt({scale:1,x:0,y:0},2,{x:30,y:-20},geometry),{scale:2,x:-30,y:20});
  const prior={scale:2,x:40,y:-40},point={x:20,y:15},next=zoomImageAt(prior,3,point,geometry);
  assert.equal((point.x-next.x)/next.scale,(point.x-prior.x)/prior.scale);
  assert.equal((point.y-next.y)/next.scale,(point.y-prior.y)/prior.scale);
});

function fixture(){
  const listeners=new Map(),classes=new Set(),captures=new Set(),style={};let live=true,stale=0,observed=0,disconnected=0;
  const make=(name)=>({style,dataset:{},classList:{toggle:(key,value)=>value?classes.add(key):classes.delete(key),remove:key=>classes.delete(key)},
    addEventListener:(type,fn)=>listeners.set(name+':'+type,fn),removeEventListener:(type,fn)=>{if(listeners.get(name+':'+type)===fn)listeners.delete(name+':'+type);},
    getBoundingClientRect:()=>({left:0,top:0,width:320,height:568}),offsetWidth:300,offsetHeight:500,
    setPointerCapture:id=>captures.add(id),releasePointerCapture:id=>captures.delete(id)});
  const stage=make('stage'),image=make('image'),steps=[],events=[];
  const bound=bindImageZoom(stage,image,{isCurrent:()=>live,onStale:()=>stale++,onStep:value=>steps.push(value),observeResize:class{observe(){observed++;}disconnect(){disconnected++;}}});
  const fire=(type,values={})=>{const event={target:{closest:()=>null},clientX:160,clientY:284,pointerId:1,pointerType:'touch',button:0,preventDefault(){events.push('prevent:'+type);},stopPropagation(){},...values};listeners.get('stage:'+type)?.(event);};
  return {bound,fire,stage,image,steps,listeners,captures,events,classes,dead:()=>{live=false;},stats:()=>({stale,observed,disconnected})};
}
test('wheel zoom and pointer pan are local; pointer cancellation never changes frame',()=>{
  const e=fixture();e.fire('wheel',{deltaY:-200,deltaMode:0});assert.ok(e.bound.getState().scale>1);
  e.fire('pointerdown');e.fire('pointermove',{clientX:190});assert.ok(e.bound.getState().x>0);
  e.fire('pointercancel',{clientX:190});assert.deepEqual(e.steps,[]);assert.equal(e.captures.size,0);
  e.fire('pointerdown');assert.equal(e.captures.size,1);e.bound.reset();assert.equal(e.captures.size,0);assert.deepEqual(e.bound.getState(),{scale:1,x:0,y:0});
});
test('two fingers pinch; releasing then moving one finger cannot swipe to another frame',()=>{
  const e=fixture();e.fire('pointerdown',{pointerId:1,clientX:120});e.fire('pointerdown',{pointerId:2,clientX:200});
  e.fire('pointermove',{pointerId:1,clientX:80});e.fire('pointermove',{pointerId:2,clientX:240});assert.equal(e.bound.getState().scale,2);
  e.fire('pointerup',{pointerId:2,clientX:240});e.fire('pointermove',{pointerId:1,clientX:270});e.fire('pointerup',{pointerId:1,clientX:270});assert.deepEqual(e.steps,[]);
  e.bound.reset();e.fire('pointerdown',{clientX:260});e.fire('pointerup',{clientX:90});assert.deepEqual(e.steps,[1]);
});
test('buttons do not zoom, stale owners cannot transform, and disposal removes observers and captures',()=>{
  const e=fixture();e.fire('wheel',{deltaY:-200,deltaMode:0,target:{closest:()=>({})}});assert.equal(e.bound.getState().scale,1);
  e.dead();e.fire('wheel',{deltaY:-200,deltaMode:0});assert.equal(e.bound.getState().scale,1);assert.equal(e.stats().stale,1);
  e.bound.dispose();e.bound.dispose();assert.equal(e.listeners.size,0);assert.equal(e.captures.size,0);assert.equal(e.stats().disconnected,1);assert.equal(e.image.style.transform,'');
});
