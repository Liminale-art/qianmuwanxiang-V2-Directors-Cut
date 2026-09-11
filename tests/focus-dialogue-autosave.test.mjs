import test from 'node:test';
import assert from 'node:assert/strict';
import {createFocusDialogueLibrary} from '../qianmu-focus-dialogue.js';
import {createFocusDialogueAutosave} from '../qianmu-focus-dialogue-autosave.js';
const row={characterKey:'character:A.png',speaker:'甲',text:'',moments:['focus:complete']};
async function fixture(){
  const account={focusClock:{}};let id=0;
  const library=createFocusDialogueLibrary({owner:()=>account,legacy:async()=>[],save(){},uid:()=>String(++id)});
  const data=await library.snapshot();return {library,data,account,editor:options=>createFocusDialogueAutosave({library,data,row,guard:async()=>{},...options})};
}
test('blank new drafts never create records; subsequent typing creates only one stable record',async()=>{
  const f=await fixture(),e=f.editor();e.update({text:' '});await e.flush();assert.equal((await f.library.snapshot()).rows.length,0);
  e.update({text:'你'});await e.flush();e.update({text:'你好'});await e.flush();const data=await f.library.snapshot();assert.equal(data.rows.length,1);assert.equal(data.rows[0].text,'你好');
});
test('slow writes drain the latest input in sequence without duplicating a new row',async()=>{
  const f=await fixture();let release,started;const ready=new Promise(r=>started=r);let calls=0,active=0,max=0;
  const e=f.editor({library:{put:async(...args)=>{max=Math.max(max,++active);if(!calls++){started();await new Promise(r=>release=r);}try{return await f.library.put(...args);}finally{active--;}}}});
  e.update({text:'旧'});const first=e.flush();await ready;e.update({text:'新的中文',moments:['focus:mid']});const second=e.flush();release();await Promise.all([first,second]);
  const data=await f.library.snapshot();assert.equal(max,1);assert.equal(data.rows.length,1);assert.equal(data.rows[0].text,'新的中文');assert.deepEqual(data.rows[0].moments,['focus:mid']);
});
test('clearing an existing line or disabling every stage persists and cannot be randomly played',async()=>{
  const f=await fixture(),e=f.editor();e.update({text:'你好'});await e.flush();e.update({text:''});await e.flush();
  assert.equal((await f.library.snapshot()).rows.length,1);assert.equal((await f.library.snapshot()).rows[0].text,'');
  const select=()=>f.library.lines({characterKey:row.characterKey,phase:'focus',specs:[{type:'complete'}]});assert.deepEqual(await select(),['']);
  e.update({text:'关闭',moments:[]});await e.flush();assert.deepEqual(await select(),['']);
});
test('a competing edit is never silently overwritten or retried with a newer revision',async()=>{
  const f=await fixture(),e=f.editor();e.update({text:'正在输入'});await f.library.put({...row,text:'另一个窗口'},f.data.revision);
  await assert.rejects(e.flush(),/已变化/);await assert.rejects(e.flush(),/已变化/);assert.equal((await f.library.snapshot()).rows[0].text,'另一个窗口');
});
test('a disposed editor or changed account guard cannot write pending text',async()=>{
  for(const mode of ['dispose','guard']){const f=await fixture(),e=f.editor({guard:async()=>{if(mode==='guard')throw Error('账户已变化');}});e.update({text:'旧账户'});if(mode==='dispose')e.dispose();await assert.rejects(e.flush());assert.equal((await f.library.snapshot()).rows.length,0);}
});
test('save failures are exposed and the same valid draft can be retried',async()=>{
  const f=await fixture();let fail=true;const e=f.editor({library:{put:(...args)=>{if(fail)throw Error('write unavailable');return f.library.put(...args);}}});e.update({text:'保留输入'});
  await assert.rejects(e.flush(),/unavailable/);fail=false;await e.flush();assert.equal((await f.library.snapshot()).rows[0].text,'保留输入');
});
