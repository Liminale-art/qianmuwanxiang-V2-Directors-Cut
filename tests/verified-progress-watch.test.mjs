import test from 'node:test';import assert from 'node:assert/strict';
import {createVerifiedProgressWatch} from '../qianmu-verified-progress-watch.js';
function clock(){let time=0,id=0;const tasks=new Map();return {tasks,setTimer:(run,ms)=>{const key=++id;tasks.set(key,{at:time+ms,run});return key;},clearTimer:key=>tasks.delete(key),tick(ms){const end=time+ms;while(true){const next=[...tasks].filter(([,row])=>row.at<=end).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];if(!next)break;time=next[1].at;tasks.delete(next[0]);next[1].run();}time=end;}};}
test('verified progress renews the idle deadline but never the finite total deadline',()=>{
  const c=clock(),events=[],watch=createVerifiedProgressWatch({...c,idleMs:100,totalMs:350,onTimeout:kind=>events.push(kind)});
  for(let at=0;at<4;at++){c.tick(80);watch.progress();}assert.deepEqual(events,[]);c.tick(30);assert.deepEqual(events,['total']);assert.equal(c.tasks.size,0);watch.progress();c.tick(500);assert.equal(events.length,1);
});
test('no progress expires once and stopping releases both timers',()=>{
  const c=clock(),events=[],watch=createVerifiedProgressWatch({...c,idleMs:100,totalMs:1000,onTimeout:kind=>events.push(kind)});c.tick(99);assert.equal(events.length,0);c.tick(1);assert.deepEqual(events,['idle']);assert.equal(c.tasks.size,0);
  const next=createVerifiedProgressWatch({...c,idleMs:100,onTimeout:()=>assert.fail('stopped')});next.stop();next.stop();c.tick(2000000);assert.equal(c.tasks.size,0);watch.stop();
});
test('caller durations cannot disable the absolute half-hour bound or create a busy zero-delay timer',()=>{
  const c=clock(),events=[],watch=createVerifiedProgressWatch({...c,idleMs:Infinity,totalMs:Infinity,onTimeout:kind=>events.push(kind)});
  for(let at=0;at<18;at++){c.tick(99999);watch.progress();}c.tick(18);assert.deepEqual(events,['total']);assert.equal(c.tasks.size,0);
  const other=clock();createVerifiedProgressWatch({...other,idleMs:-1,totalMs:-1,onTimeout:()=>{}});assert.ok([...other.tasks.values()].every(row=>row.at>=100));
});
