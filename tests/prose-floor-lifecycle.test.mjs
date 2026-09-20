import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createProseFloorTools} from '../qianmu-prose-floor-tools.js';

function fixture(){
 const window=new EventTarget(),document=new EventTarget();let opens=0,closes=0;
 window.localStorage={getItem:()=>null};window.setTimeout=setTimeout;window.clearTimeout=clearTimeout;window.navigator={onLine:true};document.hidden=false;
 const tools=createProseFloorTools({window,document,resolveNamespace:async()=> 'fixture-account',isCurrent:()=>true,headers:()=>({}),
  sessionFactory:async()=>{opens++;return {close(){closes++;}};},outboxFactory:()=>({list:async()=>[],close(){}})});
 const enable=()=>tools.configureHive({window,document});
 const settled=async()=>{for(let i=0;i<15;i++)await delay(5);};
 return {tools,window,enable,settled,get opens(){return opens;},get closes(){return closes;}};
}

test('disable then enable restarts automatic recovery exactly once and releases the old listeners',async()=>{
 const f=fixture();try{
  f.enable();f.tools.refresh(null);await f.settled();assert.equal(f.opens,1);
  f.tools.dispose();f.window.dispatchEvent(new Event('online'));await f.settled();assert.equal(f.opens,1);
  f.enable();f.tools.refresh(null);await f.settled();assert.equal(f.opens,2);
  f.window.dispatchEvent(new Event('online'));await f.settled();assert.equal(f.opens,3);assert.equal(f.closes,3);
 }finally{f.tools.dispose();}
});

test('a late lazy import from a disabled lifetime cannot start a second recovery controller',async()=>{
 const f=fixture();try{
  f.enable();f.tools.refresh(null);f.tools.dispose();f.enable();f.tools.refresh(null);f.tools.refresh(null);
  await f.settled();assert.equal(f.opens,1);f.window.dispatchEvent(new Event('online'));await f.settled();assert.equal(f.opens,2);
 }finally{f.tools.dispose();}
});
