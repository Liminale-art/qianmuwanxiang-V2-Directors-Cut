import test from 'node:test';
import assert from 'node:assert/strict';
import {createCoreadApiFixture} from './helpers/coread-center-fixture.mjs';

test('shared switches retain native checkbox markup and the caller truth value',()=>{
  const {c}=createCoreadApiFixture();
  for(const on of [true,false,undefined,0,1]){
    const html=c.renderMemSwitch('fixture-toggle',on);
    assert.match(html,/<label class="sd-reader-mtoggle"><input type="checkbox" class="fixture-toggle"/);
    assert.match(html,/sd-reader-mtoggle-track[\s\S]*sd-reader-mtoggle-thumb/);
    assert.equal(html.includes(' checked'),!!on);
  }
});

test('model choices keep a missing current model visible without mutating or duplicating the fetched list',()=>{
  const {c}=createCoreadApiFixture();
  for(const kind of ['summary','vector','rerank']){
    const models=Object.freeze(['first','second']),m=Object.freeze({[kind+'Models']:models,[kind+'Model']:'current<&"'});
    const html=c.renderMemModelRow(kind,m,'hint<&');
    assert.ok(html.includes(`data-kind="${kind}"`));assert.match(html,/value="current&lt;&amp;&quot;" selected/);
    assert.ok(html.indexOf('value="current')<html.indexOf('value="first"'));assert.match(html,/hint&lt;&amp;/);
    assert.deepEqual(models,['first','second']);assert.equal((html.match(/ selected/g)||[]).length,1);
    const selected=c.renderMemModelRow(kind,{[kind+'Models']:models,[kind+'Model']:'second'},'');
    assert.equal((selected.match(/value="second"/g)||[]).length,1);assert.match(selected,/— 选择模型 —/);
    assert.match(c.renderMemModelRow(kind,{},''),/<option value="" disabled selected>— 先拉取模型列表 —<\/option>/);
    assert.match(c.renderMemModelRow(kind,{[kind+'Model']:'saved'},''),/value="saved" selected/);
  }
});

test('empty profiles return early and populated profiles retain order, selected ID and display-name fallbacks',()=>{
  const {c}=createCoreadApiFixture();
  const empty={summaryProfiles:[]};Object.defineProperty(empty,'summaryProfileSel',{get(){throw Error('empty list must return before reading selection');}});
  assert.equal(c.renderMemProfileRow('summary',empty),'');
  for(const kind of ['summary','vector','rerank']){
    const profiles=Object.freeze([Object.freeze({id:'named"',name:'Name<&'}),Object.freeze({id:'model',model:'fallback-model'}),Object.freeze({id:'empty'})]);
    const m=Object.freeze({[kind+'Profiles']:profiles,[kind+'ProfileSel']:'model'}),before=JSON.stringify(m);
    const html=c.renderMemProfileRow(kind,m);
    assert.ok(html.includes(`sd-reader-mem-profile" data-kind="${kind}"`));assert.match(html,/value="named&quot;">Name&lt;&amp;/);
    assert.match(html,/value="model" selected>fallback-model/);assert.match(html,/value="empty">未命名/);
    assert.ok(html.indexOf('named&quot;')<html.indexOf('value="model"'));assert.match(html,/sd-reader-mem-profile-del/);
    assert.equal(JSON.stringify(m),before);
  }
});

test('API action rows preserve their distinct channel routing attributes without initiating work',()=>{
  const {c}=createCoreadApiFixture();
  for(const kind of ['summary','vector','rerank']){
    const html=c.renderMemApiActions(kind),buttons=[...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map(x=>x[0]);
    assert.equal(buttons.length,3);
    for(const [i,type,label]of [[0,'test','测试连接'],[1,'fetch','拉取模型'],[2,'save','保存预设']]){
      assert.ok(buttons[i].includes(`sd-reader-mem-${type}" data-kind="${kind}"`));assert.ok(buttons[i].includes(label));
      assert.match(buttons[i],/type="button"/);
    }
  }
});

test('summary card composes the actual shared controls in order and preserves zero values and password escaping',()=>{
  const {c}=createCoreadApiFixture(),calls=[];
  for(const name of ['renderMemSwitch','renderMemProfileRow','renderMemModelRow','renderMemApiActions']){
    const original=c[name];c[name]=(...args)=>{calls.push([name,...args]);return original(...args);};
  }
  const m=Object.freeze({summaryStream:false,summaryProfiles:Object.freeze([]),summaryModel:'saved',summaryApiUrl:'https://fixture.invalid/?a=1&b=2',summaryApiKey:'fixture"<&',summaryTemperature:0,summaryMaxTokens:0,summaryContextChars:0});
  const before=JSON.stringify(m),html=c.renderSummaryApiCard(m);
  assert.deepEqual(calls.map(x=>x[0]),['renderMemSwitch','renderMemProfileRow','renderMemModelRow','renderMemApiActions']);
  assert.deepEqual(calls[0].slice(1),['sd-reader-sum-stream',false]);assert.equal(calls[1][1],'summary');assert.equal(calls[1][2],m);assert.equal(calls[2][2],m);
  assert.match(html,/sd-reader-summary-apikey" type="password"[^>]*value="fixture&quot;&lt;&amp;"/);
  assert.match(html,/a=1&amp;b=2/);assert.match(html,/value="saved" selected/);
  for(const field of ['temp','maxtok','ctx'])assert.match(html,new RegExp('sd-reader-sum-'+field+'"[^>]*value="0"'));
  assert.equal(JSON.stringify(m),before);
});
