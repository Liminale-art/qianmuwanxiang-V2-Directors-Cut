import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {renderFocusClockView,updateFocusClockView} from '../qianmu-focus-view.js';
import {focusFixture} from './helpers/focus-lock-fixture.mjs';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function viewFixture(overrides={}) {
  const env=focusFixture(overrides),{c,f}=env,trace=[];
  const data={books:[],today:[],week:{days:Array.from({length:7},()=>({minutes:0})),history:[],minutes:0,count:0,readingMinutes:0},
    voice:{hasCharacter:true,voice:{voiceId:'A'},enabled:true,characterName:'甲',options:[],selected:'',relation:'neutral'},characters:[],rows:[]};
  Object.assign(c,{renderFocusClockView,updateFocusClockView,htmlEscape:escape,focusClockState:()=>{trace.push('state');return f;},
    focusClockTodayHistory:state=>{assert.equal(state,f);trace.push('today');return data.today;},
    focusClockWeekStats:state=>{assert.equal(state,f);trace.push('week');return data.week;},
    focusClockWeekStart:()=>new Date(2026,8,7),coread:()=>{trace.push('books');return {books:data.books};},
    focusClockVoiceContext:state=>{assert.equal(state,f);trace.push('voice:'+state.bookId);return data.voice;},
    coreadCompanionChoices:()=>data.characters,focusClockVoiceDrawerRows:()=>data.rows,
    getTtsProvider:()=>({label:'TTS'}),ttsProviderId:()=> 'minimax',FOCUS_CLOCK_RELATIONS:{neutral:{label:'普通'}},
    FOCUS_CLOCK_VOICE_FREQUENCIES:{low:{label:'低',chance:.3}},FOCUS_CLOCK_SOUND_PRESETS:{bell:{label:'铃声'}}});
  vm.runInContext(['renderFocusClockTab','focusClockUpdateDom'].map(section).join('\n'),c);
  return {...env,data,trace,render:()=>c.renderFocusClockTab()};
}
function control(html,name) {
  const tag=[...html.matchAll(/<(?:button|select|input)\b[^>]*>/g)].map(match=>match[0]).find(tag=>(tag.match(/class="([^"]*)"/)?.[1]||'').split(/\s+/).includes(name));
  assert.ok(tag,`missing ${name}`);return tag;
}
const disabled=(html,name)=>/\bdisabled(?:\s|>)/.test(control(html,name));

test('unconfigured role switch remains usable and setup help disappears after its first presentation',()=>{
  const {f,data,render}=viewFixture();data.voice.voice=null;data.voice.enabled=false;
  assert.equal(disabled(render(),'sd-focus-voice-enabled'),false);assert.match(render(),/sd-focus-voice-setup-tip/);
  f.voiceSetupTipSeen=true;assert.doesNotMatch(render(),/选择一次音色后按角色保存/);
  data.voice.enabled=true;assert.match(render(),/请选择音色/);
});

test('phase and session state lock only the existing controls, while voice-off always remains reachable',()=>{
  for(const phase of ['focus','shortBreak','longBreak'])for(const status of ['idle','running','paused']) {
    const {c,data,render}=viewFixture({phase,status,endsAt:160000});const html=render();
    assert.equal(disabled(html,'sd-focus-phase'),status!=='idle');assert.equal(disabled(html,'sd-focus-voice-speaker'),status!=='idle');
    assert.equal(disabled(html,'sd-focus-voice-enabled'),false);assert.equal(disabled(html,'sd-focus-task'),status==='running');
    assert.match(html,new RegExp('</i>'+(status==='idle'?'开始':status==='running'?'暂停':'继续')+'</button>'));
    data.voice.voice=null;assert.equal(disabled(render(),'sd-focus-voice-enabled'),false);
    c.focusClockActiveLock=()=>({});const locked=render();assert.equal(disabled(locked,'sd-focus-main'),true);assert.equal(disabled(locked,'sd-focus-reset'),true);
  }
});

test('missing reading selection keeps legacy first-book repair before resolving its voice context',()=>{
  const {f,data,trace,render}=viewFixture({activity:'reading',bookId:'gone'});data.books=[{id:'book',title:'Book'},null];
  const html=render();assert.equal(f.bookId,'book');assert.match(html,/sd-focus-open-reading/);assert.match(html,/readonly/);
  assert.ok(trace.indexOf('books')<trace.indexOf('voice:book'));assert.equal(trace.filter(x=>x==='state').length,1);
  data.books=[];const empty=render();assert.equal(f.bookId,'');assert.doesNotMatch(empty,/sd-focus-open-reading/);assert.match(empty,/书架还是空的/);
});

test('task, book, voice and completion text stay escaped and history controls reflect only available records',()=>{
  const {f,data,render}=viewFixture({activity:'reading',bookId:'book'}),unsafe='"><img src=x onerror=bad>';
  data.books=[{id:'book',title:unsafe}];data.voice.characterName=unsafe;data.voice.options=[{key:unsafe,label:unsafe}];
  const row={id:'done',task:unsafe,activity:'reading',durationMs:60000,finishedAt:100000,progressStart:10,progressEnd:20,voiceText:unsafe,note:unsafe};
  f.history=[row];f.lastCompletionId='done';data.today=[row];data.week.history=[row];data.rows=[row];
  const html=render();assert.doesNotMatch(html,/<img/);assert.match(html,/&lt;img/);assert.match(html,/10% → 20%/);
  assert.match(html,/sd-focus-clear-history/);assert.equal(disabled(html,'sd-focus-week-export'),false);assert.doesNotMatch(control(html,'sd-focus-voice-drawer-open'),/\bhidden/);
  data.today=[];data.week.history=[];data.rows=[];const empty=render();assert.doesNotMatch(empty,/sd-focus-clear-history/);assert.equal(disabled(empty,'sd-focus-week-export'),true);
  assert.match(control(empty,'sd-focus-voice-drawer-open'),/\bhidden/);assert.match(empty,/sd-focus-finale-card/);
});

test('timer repaint updates existing surfaces and drawer counts without rebuilding or resetting them',()=>{
  const {c,f,data}=viewFixture({status:'running',endsAt:130000,sessionPlannedMs:60000});
  const time={},mini={},ring={style:{setProperty:(key,value)=>{ring[key]=value;}},setAttribute:(key,value)=>{ring[key]=value;}},count={};
  const drawer={querySelector:()=>count};const nodes={'.sd-focus-time':[time],'.sd-reader-focus-mini':[mini],'.sd-focus-ring':[ring],'.sd-focus-voice-drawer-open':[drawer]};
  c.document.querySelectorAll=selector=>nodes[selector];data.rows=[{},{}];c.focusClockUpdateDom();
  assert.equal(time.textContent,'00:30');assert.equal(mini.textContent,'00:30');assert.equal(ring['--sd-focus-angle'],'180.00deg');assert.equal(ring['aria-valuenow'],'50');
  assert.equal(drawer.hidden,false);assert.equal(count.textContent,'2');f.status='idle';data.rows=[];c.focusClockUpdateDom();assert.equal(mini.textContent,'专注');assert.equal(drawer.hidden,true);
});
