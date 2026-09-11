import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createFocusVoiceDrawer} from '../qianmu-focus-drawer.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

function fixture() {
  const portals=[], notices=[], cue={id:'cue-a',speaker:'甲',text:'陪伴',cacheKey:'audio'};
  let rows=[cue], resolve;
  const pending=new Promise(done=>{resolve=done;});
  const modal={appendChild:portal=>{portal.isConnected=true;}};
  const document={getElementById:()=>modal,createElement:()=>{
    const listeners=new Map(), icon={};
    const button={disabled:false,querySelector:()=>icon,closest:()=>({dataset:{cueId:cue.id}}),
      addEventListener:(name,fn)=>listeners.set(name,fn)};
    const portal={isConnected:false,button,remove(){this.isConnected=false;},
      querySelector:()=>null,querySelectorAll:selector=>selector==='.sd-focus-cue-regen'?[button]:[],
      click:()=>listeners.get('click')({currentTarget:button})};
    portals.push(portal);return portal;
  }};
  const c=vm.createContext({document,MODAL_ID:'modal',focusClockVoiceDrawer:null,focusLibraryRuntime:null,createFocusVoiceDrawer,
    focusClockVoiceDrawerRows:()=>rows,toast:(...args)=>notices.push(args),htmlEscape:String,
    formatDateTime:()=>'',applyQianmuIcons:()=>{},setQianmuIconClass:()=>{},
    focusClockSyncVoiceDrawerFavorites:async()=>{},focusClockRegenerateVoiceCue:()=>pending});
  vm.runInContext(['focusClockDrawer','focusClockCloseVoiceDrawer','focusClockOpenVoiceDrawer'].map(section).join('\n'),c);
  return {c,portals,notices,resolve,setRows:value=>{rows=value;}};
}

test('drawer construction and unused close are inert; a missing host panel does not read records or create DOM',()=>{
  const calls=[];
  const drawer=createFocusVoiceDrawer({getModal:()=>{calls.push('root');return null;},
    rowsForView:()=>{throw Error('records must not be read');},document:{createElement:()=>{throw Error('no host');}}});
  assert.equal(Object.isFrozen(drawer),true);assert.deepEqual(calls,[]);
  drawer.close();drawer.close();assert.deepEqual(calls,[]);
  drawer.open();assert.deepEqual(calls,['root']);
});

test('closing removes only its own portal once without reading records or stopping shared audio',()=>{
  const e=fixture();let reads=0,removes=0;const rows=e.c.focusClockVoiceDrawerRows;
  e.c.focusClockVoiceDrawerRows=()=>{reads++;return rows();};
  e.c.ttsStopPlayback=()=>{throw Error('closing UI must not stop narration');};
  e.c.focusClockOpenVoiceDrawer();const portal=e.portals[0],remove=portal.remove;
  portal.remove=()=>{removes++;remove.call(portal);};
  e.c.focusClockCloseVoiceDrawer();e.c.focusClockCloseVoiceDrawer();
  assert.equal(reads,1);assert.equal(removes,1);assert.equal(portal.isConnected,false);
});

test('an empty voice drawer closes its predecessor without creating an empty dialog',()=>{
  const e=fixture();e.c.focusClockOpenVoiceDrawer();e.setRows([]);e.c.focusClockOpenVoiceDrawer();
  assert.equal(e.portals.length,1);assert.equal(e.portals[0].isConnected,false);
  assert.equal(e.portals.some(portal=>portal.isConnected),false);assert.equal(e.notices[0][1],'info');
});

test('a regeneration refreshes its still-open drawer and preserves the busy button until replacement',async()=>{
  const e=fixture();e.c.focusClockOpenVoiceDrawer();const old=e.portals[0],run=old.click();
  assert.equal(old.button.disabled,true);assert.equal(e.portals.length,1);
  e.resolve(true);await run;
  assert.equal(old.isConnected,false);assert.equal(e.portals.length,2);
  assert.equal(e.portals[1].isConnected,true);
});

test('a delayed regeneration cannot reopen a closed drawer, replace a newer drawer, or resurrect a removed page',async()=>{
  for(const action of ['close','replace','remove']) {
    const e=fixture();e.c.focusClockOpenVoiceDrawer();const old=e.portals[0],run=old.click();
    if(action==='close')e.c.focusClockCloseVoiceDrawer();
    if(action==='replace')e.c.focusClockOpenVoiceDrawer();
    if(action==='remove')old.remove(); // Host rerender removes DOM before the stored pointer is cleared.
    const count=e.portals.length,current=e.portals.find(portal=>portal.isConnected);
    e.resolve(true);await run;
    assert.equal(e.portals.length,count,action);
    assert.equal(e.portals.find(portal=>portal.isConnected),current,action);
  }
});
