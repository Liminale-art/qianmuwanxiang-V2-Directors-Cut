import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {exportFocusWeekImage} from '../qianmu-focus-export.js';
import {focusClockDateKey} from '../qianmu-focus-time.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

function fixture({empty=false,contextAvailable=true,blob=new Blob(['png']),deferred=false,theme='light'}={}) {
  const draws=[],colors=[],notices=[],downloads=[];let creates=0,reads=0,encode;
  const stats={history:empty?[]:[{id:'week'}],minutes:71,count:3,readingMinutes:26,days:[0,5,12,30,0,0,24].map(minutes=>({minutes}))};
  const context={};for(const method of ['beginPath','moveTo','arcTo','closePath','fill','fillRect','fillText'])context[method]=(...args)=>draws.push([method,...args]);
  context.createLinearGradient=(...args)=>{draws.push(['gradient',...args]);return {addColorStop:(...args)=>colors.push(args)};};
  const canvas={getContext:type=>{assert.equal(type,'2d');return contextAvailable?context:null;},toBlob:(callback,type)=>{assert.equal(type,'image/png');encode=callback;if(!deferred)callback(blob);}};
  const c=vm.createContext({exportFocusWeekImage,settings:{theme},THEME_KEYS:['light','dark','summer','candy','kraft','dream'],Date,focusClockDateKey,
    focusClockWeekStats:()=>{reads++;return stats;},focusClockWeekStart:()=>new Date(2026,8,7),
    document:{createElement:tag=>{assert.equal(tag,'canvas');creates++;return canvas;}},
    toast:(...args)=>notices.push(args),ttsDownloadBlob:(...args)=>downloads.push(args)});
  vm.runInContext(section('focusClockExportWeekImage'),c);
  return {c,stats,draws,colors,notices,downloads,canvas,get creates(){return creates;},get reads(){return reads;},finish:value=>encode(value),run:()=>c.focusClockExportWeekImage()};
}

test('an empty week never allocates a canvas or offers a misleading export',async()=>{
  const e=fixture({empty:true});await e.run();assert.equal(e.creates,0);assert.equal(e.reads,1);assert.equal(e.downloads.length,0);assert.equal(e.notices[0][1],'warning');
});

test('missing drawing context and failed PNG encoding report errors without success or downloads',async()=>{
  for(const options of [{contextAvailable:false},{blob:null}]){const e=fixture(options);await e.run();assert.equal(e.downloads.length,0);assert.equal(e.notices.length,1);assert.equal(e.notices[0][1],'error');}
});

test('week image keeps dimensions, seven weekdays, summary values and each existing theme palette',async()=>{
  const themes={light:'#edf2ed',dark:'#18201d',summer:'#eff6df',candy:'#fff0f3',kraft:'#eee3cf',dream:'#eeeafb',unknown:'#edf2ed'};
  for(const [theme,bg] of Object.entries(themes)) {
    const e=fixture({theme}),before=JSON.stringify(e.stats);await e.run();assert.equal(e.canvas.width,1200);assert.equal(e.canvas.height,820);assert.equal(e.colors[0][1],bg);
    const text=e.draws.filter(row=>row[0]==='fillText').map(row=>row[1]);
    assert.deepEqual(text.filter(value=>/^周[一二三四五六日]$/.test(value)),['周一','周二','周三','周四','周五','周六','周日']);
    for(const value of ['71','3','26','专注分钟','完成段数','伴读分钟'])assert.ok(text.includes(value));
    assert.equal(e.downloads[0][1],'千幕-本周专注-2026-09-07.png');assert.equal(e.notices.at(-1)[1],'success');assert.equal(JSON.stringify(e.stats),before);
  }
});

test('PNG completion uses the original week snapshot and only then downloads and reports success',async()=>{
  const e=fixture({deferred:true}),pending=e.run();assert.equal(e.reads,1);assert.equal(e.downloads.length,0);assert.equal(e.notices.length,0);
  e.c.focusClockWeekStart=()=>new Date(2026,8,14);e.c.settings.theme='dark';const blob=new Blob(['finished']);e.finish(blob);await pending;
  assert.equal(e.reads,1);assert.equal(e.downloads[0][0],blob);assert.equal(e.downloads[0][1],'千幕-本周专注-2026-09-07.png');assert.equal(e.notices.at(-1)[1],'success');
});
