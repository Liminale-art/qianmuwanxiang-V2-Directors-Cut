import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {focusFixture} from './helpers/focus-lock-fixture.mjs';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

// Characterize the current transition boundary before moving it. No duplicate state algorithm.
function fixture(overrides={}) {
  const e=focusFixture({autoStartNext:false,...overrides}), trace=[];
  vm.runInContext(section('focusClockSetPhase'),e.c);
  for(const [name,label] of [['focusClockCancelVoiceWork','cancel'],['focusClockPrimeSound','prime'],['saveSettings','save'],['focusClockUpdateDom','paint']]) e.c[name]=()=>trace.push(label);
  e.c.startFocusClockRuntime=options=>{assert.equal(options.prepareVoice,false);trace.push('runtime');};
  e.c.focusClockVoiceContext=()=>({enabled:true});
  e.c.focusClockPrepareVoiceCues=token=>trace.push(`prepare:${token}`);
  e.c.focusClockPlayCompletionAlert=cue=>trace.push(`alert:${cue?.text||''}`);
  e.c.focusClockVoiceBindingActive=key=>key==='current';
  return {...e,trace};
}

test('the controller allocates without reading state and each action uses the current normalized owner once',()=>{
  const {c,f}=fixture();let reads=0,current=f;
  c.focusClockState=()=>{reads++;return current;};
  const controller=c.focusClockSession();assert.equal(reads,0);
  c.focusClockStart();assert.equal(reads,1);const firstToken=f.sessionToken;
  current={...f,status:'idle',sessionToken:'',sessionVoiceCues:[],history:[]};
  c.focusClockStart();assert.equal(reads,2);assert.equal(c.focusClockSession(),controller);
  assert.equal(f.sessionToken,firstToken);assert.notEqual(current.sessionToken,firstToken);
  c.focusClockReset();assert.equal(reads,3);assert.equal(current.status,'idle');assert.equal(f.status,'running');
});

test('phase selection resets only an idle round and never changes a paused/running session',()=>{
  const {c,f,trace}=fixture();c.focusClockSetPhase('longBreak');
  assert.equal(f.phase,'longBreak');assert.equal(f.remainingMs,15*60000);assert.equal(f.sessionPlannedMs,f.remainingMs);
  assert.deepEqual(trace,['cancel','save']);
  for(const status of ['idle','paused','running']){
    f.status=status;const before=JSON.stringify(f);trace.length=0;
    c.focusClockSetPhase(status==='idle'?'invalid':'focus');
    assert.equal(JSON.stringify(f),before);assert.deepEqual(trace,[]);
  }
});

test('start persists a single round before starting its ticker and resumes the same identity after pause',()=>{
  const {c,f,trace,setNow}=fixture();c.focusClockStart();
  assert.equal(f.endsAt,100000+25*60000);assert.equal(f.sessionStartedAt,100000);
  const token=f.sessionToken;assert.ok(token);assert.deepEqual(trace,['cancel','prime','save','runtime','paint',`prepare:${token}`]);
  const started=JSON.stringify(f);trace.length=0;c.focusClockStart();assert.equal(JSON.stringify(f),started);assert.deepEqual(trace,[]);
  setNow(160000);c.focusClockPause();assert.equal(f.sessionElapsedMs,60000);assert.equal(f.remainingMs,24*60000);
  f.sessionVoiceCues=[{type:'complete',played:false,cacheKey:'ready'}];
  setNow(900000);trace.length=0;c.focusClockStart();
  assert.equal(f.endsAt,900000+24*60000);assert.equal(f.sessionToken,token);assert.equal(f.sessionStartedAt,100000);
  assert.equal(f.sessionElapsedMs,60000);assert.deepEqual(trace,['prime','save','runtime','paint']);
});

test('unready reading cannot start or allocate a session; a ready book freezes its starting metadata',()=>{
  const {c,f,trace}=fixture({activity:'reading',bookId:'book'});
  const before=JSON.stringify(f);c.focusClockStart();assert.equal(JSON.stringify(f),before);assert.deepEqual(trace,[]);
  c.activeTab='coread';c.readerView={bookId:'book'};c.readerContentCache={bookId:'book'};c.document.querySelector=()=>({isConnected:true});
  c.focusClockStart();assert.equal(f.sessionBookId,'book');assert.equal(f.sessionProgressStart,20);assert.equal(f.task,'阅读《Book》');
  c.coreadBookMeta=()=>({id:'book',title:'Changed',progress:75});
  assert.equal(f.sessionProgressStart,20);assert.equal(f.task,'阅读《Book》');
});

test('pause at the deadline settles the completed round instead of creating a zero-time resumable round',()=>{
  const {c,f,trace,setNow}=fixture();c.focusClockStart();setNow(f.endsAt);trace.length=0;c.focusClockPause();
  assert.equal(f.status,'idle');assert.equal(f.phase,'shortBreak');assert.equal(f.history.length,1);
  assert.equal(f.history[0].durationMs,25*60000);assert.equal(trace.filter(x=>x==='save').length,1);
  assert.equal(trace.filter(x=>x==='runtime').length,1);
});

test('reset cancels the current session but preserves completed records, cycle and user preferences',()=>{
  const saved={id:'history',kind:'focus'};
  const {c,f,trace}=fixture({history:[saved],focusCycle:2,task:'Keep me',voiceEnabledByChat:{scope:true}});
  c.focusClockStart();trace.length=0;c.focusClockReset();
  assert.equal(f.status,'idle');assert.equal(f.endsAt,0);assert.equal(f.sessionStartedAt,0);assert.equal(f.sessionElapsedMs,0);
  assert.equal(f.sessionBookId,'');assert.equal(f.sessionToken,'');assert.equal(f.sessionVoiceCues.length,0);
  assert.equal(f.history[0],saved);assert.equal(f.focusCycle,2);assert.equal(f.task,'Keep me');assert.equal(f.voiceEnabledByChat.scope,true);
  assert.deepEqual(trace,['cancel','save','runtime','paint']);
});

test('completion archives book progress and only eligible voice snapshots without retaining live cue objects',()=>{
  const {c,f,trace,setNow}=fixture();c.focusClockStart();
  f.sessionBookId='book';f.sessionProgressStart=12;
  const played={cacheKey:'mid',text:'earlier',type:'mid',played:true};
  const completion={cacheKey:'end',text:'finished',type:'complete',played:false,voiceBindingKey:'current'};
  const stale={cacheKey:'old',text:'wrong character',type:'complete',played:false,voiceBindingKey:'stale'};
  f.sessionVoiceCues=[played,stale,completion];setNow(f.endsAt+1000);trace.length=0;c.focusClockComplete();
  const row=f.history[0];assert.equal(row.bookId,'book');assert.equal(row.progressStart,12);assert.equal(row.progressEnd,20);
  assert.equal(row.voiceText,'finished');assert.equal(row.voiceCues.length,2);assert.ok(row.voiceCues.every(cue=>cue.played));
  assert.notEqual(row.voiceCues[0],played);assert.notEqual(row.voiceCues[1],completion);assert.equal(completion.played,false);
  assert.equal(f.lastCompletionId,row.id);assert.equal(f.sessionVoiceCues.length,0);assert.equal(f.sessionBookId,'');
  assert.deepEqual(trace,['cancel','save','runtime','alert:finished']);
  const before=JSON.stringify(f);trace.length=0;c.focusClockComplete();assert.equal(JSON.stringify(f),before);assert.deepEqual(trace,[]);
});

test('rest completion auto-starts reading only when its page is ready and creates no focus history for rest',async()=>{
  for(const ready of [false,true]){
    const {c,f,setNow,trace}=fixture({phase:'shortBreak',status:'running',endsAt:101000,autoStartNext:true,activity:'reading',bookId:'book'});
    if(ready){c.activeTab='coread';c.readerView={bookId:'book'};c.readerContentCache={bookId:'book'};c.document.querySelector=()=>({isConnected:true});}
    setNow(101000);c.focusClockComplete();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.phase,'focus');assert.equal(f.history.length,0);
    assert.equal(f.status,ready?'running':'idle');assert.equal(f.sessionBookId,ready?'book':'');
    assert.equal(Boolean(f.sessionToken),ready);assert.equal(f.endsAt,ready?101000+25*60000:0);
    assert.equal(trace.filter(x=>x.startsWith('prepare:')).length,ready?1:0);
  }
});

test('completed focus rounds select the configured long rest cadence and cap only stored history',()=>{
  const {c,f,setNow}=fixture({history:Array.from({length:160},(_,i)=>({id:`old-${i}`,kind:'focus'}))});
  for(let round=1;round<=4;round++){
    c.focusClockStart();setNow(f.endsAt);c.focusClockComplete();
    assert.equal(f.focusCycle,round);assert.equal(f.phase,round===4?'longBreak':'shortBreak');assert.equal(f.history.length,160);
    if(round<4){c.focusClockStart();setNow(f.endsAt);c.focusClockComplete();assert.equal(f.phase,'focus');assert.equal(f.focusCycle,round);}
  }
  assert.ok(f.history.slice(0,4).every(row=>row.id.startsWith('id-')));
});
