import test from 'node:test';
import assert from 'node:assert/strict';
import {focusEventsFixture as fixture} from './helpers/focus-events-fixture.mjs';

test('binding another tab is inert and a fresh focus page binds one main action',async()=>{
  const e=fixture(),main=e.node('.sd-focus-main');e.c.activeTab='coread';e.bind();assert.equal(main.count('click'),0);assert.deepEqual(e.trace,[]);
  e.c.activeTab='focus';e.bind();e.trace.length=0;await main.fire('click');assert.deepEqual(e.trace,['start','render']);
});

test('task change saves trimmed text without repainting the edit control; main action consumes latest text',async()=>{
  const e=fixture({status:'running'}),task=e.node('.sd-focus-task',{value:'  '+ 'a'.repeat(130)+'  '}),main=e.node('.sd-focus-main');e.bind();e.trace.length=0;
  await task.fire('change');assert.equal(e.f.task.length,120);assert.deepEqual(e.trace,['save']);
  task.value=' new ';e.trace.length=0;await main.fire('click');assert.equal(e.f.task,'new');assert.deepEqual(e.trace,['pause','render']);
});

test('duration edits keep limits and update idle planned time, but daily target does not reset a running deadline',async()=>{
  const e=fixture(),input=e.node('.sd-focus-setting',{value:'999',dataset:{focusSetting:'focusMinutes'}});e.bind();e.trace.length=0;
  await input.fire('change');assert.equal(e.f.focusMinutes,240);assert.equal(e.f.remainingMs,240*60000);assert.equal(e.f.sessionPlannedMs,e.f.remainingMs);
  e.f.status='running';e.f.endsAt=123456;input.dataset.focusSetting='dailyGoal';input.value='0';await input.fire('change');assert.equal(e.f.endsAt,123456);assert.ok(e.f.dailyGoal>=1&&e.f.dailyGoal<=24);
});

test('preview consumes unsaved URL before playing and preserves an unchanged preview without reset',async()=>{
  const e=fixture(),url=e.node('.sd-focus-sound-url',{value:' https://example.test/sound.mp3 '}),play=e.node('.sd-focus-sound-preview');e.bind();e.trace.length=0;
  await play.fire('click');assert.equal(e.f.soundUrl,url.value.trim());assert.deepEqual(e.trace,['media','save',['play',true]]);
  e.trace.length=0;await play.fire('click');assert.deepEqual(e.trace,[['play',true]]);
});

test('old displayed identity cannot toggle a new role voice and selection passes its original binding identity',async()=>{
  const e=fixture(),toggle=e.node('.sd-focus-voice-enabled',{checked:false}),speaker=e.node('.sd-focus-voice-speaker',{value:'voice'});e.bind();e.trace.length=0;
  e.setVoice({characterKey:'character:B',providerId:'doubao',chatKey:'chatB'});await toggle.fire('change');assert.deepEqual(e.trace,['render']);
  e.trace.length=0;await speaker.fire('change');assert.deepEqual(e.trace,[['bind','voice','character:A','minimax'],'render']);
});

test('reset cancellation does nothing, and confirmed clear affects only today with matching completion references',async()=>{
  const e=fixture({status:'running',lastCompletionId:'now',history:[{id:'now',finishedAt:'today'},{id:'old',finishedAt:'yesterday'}]}),reset=e.node('.sd-focus-reset'),clear=e.node('.sd-focus-clear-history');e.bind();e.trace.length=0;
  e.confirm(false);await reset.fire('click');await clear.fire('click');assert.deepEqual(e.trace,[]);assert.equal(e.f.history.length,2);
  e.confirm(true);await clear.fire('click');assert.deepEqual(Array.from(e.f.history,x=>x.id),['old']);assert.equal(e.f.lastCompletionId,'');assert.deepEqual(e.trace,['save','render']);
});

test('an old end confirmation cannot reset a different round, phase, state owner or disabled plugin',async()=>{
  for(const change of ['round','phase','owner','disabled']) {
    const e=fixture({status:'running',sessionToken:'old',phase:'focus'}),button=e.node('.sd-focus-reset');let resolve;
    e.c.confirmDialog=()=>new Promise(r=>{resolve=r;});e.bind();e.trace.length=0;
    const pending=button.fire('click');
    if(change==='round')e.f.sessionToken='new';
    if(change==='phase')e.f.phase='shortBreak';
    if(change==='owner')e.c.settings.focusClock={...e.f};
    if(change==='disabled')e.c.settings.enabled=false;
    resolve(true);await pending;assert.deepEqual(e.trace,[],change);
  }
});

test('same-round confirmation after pausing still ends that round, and idle reset does not open a confirmation',async()=>{
  const e=fixture({status:'running',sessionToken:'same'}),button=e.node('.sd-focus-reset');let resolve,confirmations=0;
  e.c.confirmDialog=()=>{confirmations++;return new Promise(r=>{resolve=r;});};e.bind();e.trace.length=0;
  const pending=button.fire('click');e.f.status='paused';resolve(true);await pending;assert.deepEqual(e.trace,['reset','render']);
  e.f.status='idle';e.trace.length=0;await button.fire('click');assert.equal(confirmations,1);assert.deepEqual(e.trace,['reset','render']);
});
