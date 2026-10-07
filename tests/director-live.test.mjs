import test from 'node:test';
import assert from 'node:assert/strict';
import { completeDirectorCards, renderDirectorLive, renderModelDiagnostics } from '../qianmu-director-live.js';

test('only closed known top-level cards are staged; nested fields and incomplete strings never become cards',()=>{
  const first={title:'Read "{quoted}"',objective:'A\nB',extra:{quests:[{title:'must not appear'}]}};
  const prefix='preface\n```json\n{"quests":['+JSON.stringify(first);
  assert.equal(completeDirectorCards(prefix).length,1);assert.deepEqual(completeDirectorCards(prefix)[0].value,first);
  assert.equal(completeDirectorCards(prefix+',{"title":"incomplete').length,1);
  assert.equal(completeDirectorCards('{"world_updates":[{"title":"outer","extra":[1,{"content":"nested"}]}]').length,1);
  assert.deepEqual(completeDirectorCards('{"x":{"quests":[{"title":"nested"}]}}'),[]);
  assert.deepEqual(completeDirectorCards('{"quests":[{"title":"incomplete}'),[]);
});

test('all prefixes preserve exactly those array items that have reached their own closing delimiter',()=>{
  const head='{"quests":[',a=JSON.stringify({title:'一😀',objective:'a\\b'}),b=JSON.stringify({title:'二'});
  const value=head+a+','+b+']}';
  for(let i=0;i<=value.length;i++)assert.equal(completeDirectorCards(value.slice(0,i)).length,Number(i>=head.length+a.length)+Number(i>=head.length+a.length+1+b.length),String(i));
});

test('duplicate fields, unknown content and empty objects cannot masquerade as valid preview revisions',()=>{
  assert.deepEqual(completeDirectorCards('{"quests":[{"title":"a"}],"quests":['),[]);
  assert.deepEqual(completeDirectorCards('{"quests":[{},4,null],"unknown":[{"title":"x"}]}'),[]);
  assert.equal(completeDirectorCards('{"director_comment":["A","B"').length,0);
});

test('preview is read-only, escaped, leaves old plan untouched and disappears only on complete success',()=>{
  const log={id:'<unsafe>',status:'error',error:'<failure>',response:'{"quests":[{"title":"<img>","objective":"正文"}],"npc_updates":[{"name":"角色"}]}'};
  const before=JSON.stringify(log),html=renderDirectorLive(log),tasks=renderDirectorLive(log,{tasksOnly:true});
  assert.equal(JSON.stringify(log),before);assert.match(html,/&lt;img&gt;/);assert.match(html,/&lt;failure&gt;/);assert.doesNotMatch(html,/<img>|data-inject|sd-lib-load/);
  assert.doesNotMatch(tasks,/其他人物动向/);assert.equal(renderDirectorLive({...log,status:'success'}),'');
});

test('new creative fields use current names and stage object extras only after their own closing delimiter',()=>{
  const parallel=JSON.stringify({title:'另一刻',content:'他说了另一句话。',nested:{content:'not an extra card'}});
  const interlude=JSON.stringify({type:'phone',owner:'同事',title:'未读',content:'A：今晚还来吗？\nB：带着笔记。'});
  const prefix='{"character_dynamics":[{"title":"值班","content":"核对交接记录"}],"parallel_scene":';
  for(let i=0;i<=parallel.length;i++)assert.equal(completeDirectorCards(prefix+parallel.slice(0,i)).length,1+Number(i===parallel.length),String(i));
  const cards=completeDirectorCards(prefix+parallel+',"interlude":'+interlude+'}');
  assert.deepEqual(cards.map(card=>card.label),['此间一人','未映之幕','幕间拾趣']);
  const html=renderDirectorLive({id:'one',status:'loading',response:prefix+parallel+',"interlude":'+interlude+'}'});
  assert.match(html,/另一句话/);assert.match(html,/今晚还来/);assert.doesNotMatch(html,/sd-inject|sd-world-media-entry|data-inject/);
});

test('wrong extra shapes, unknown forms, empty content and repeated extra keys are not accepted as cards',()=>{
  for(const raw of [
    '{"parallel_scene":[{"content":"invalid array"}]}',
    '{"interlude":{"type":"unknown","content":"wrong form"}}',
    '{"interlude":{"type":"theater","title":"no body"}}',
    '{"parallel_scene":{"title":"still writing","content":"unfinished',
    '{"parallel_scene":{"content":"first"},"parallel_scene":',
  ])assert.deepEqual(completeDirectorCards(raw),[],raw);
});

test('memory and incomplete creative output are understandable without exposing memory source text',()=>{
  const log={memory:{status:'partial',diagnostics:[{code:'record_source_changed',scope:'characters'}],text:'PRIVATE FULL MEMORY',blocks:[{text:'PRIVATE BLOCK'}]},quality:[
    {field:'character_dynamics',reason:'无效条目',indices:[0]},
    {field:'character_dynamics',reason:'有效内容不足',missing:1},
    {field:'interlude',reason:'缺少小卡',missing:1},
  ]};
  const html=renderModelDiagnostics(log);
  assert.match(html,/部分记忆可用/);assert.match(html,/<details><summary>记忆核对详情/);
  assert.match(html,/此间一人缺 1 条/);assert.match(html,/幕间拾趣缺 1 张/);
  assert.equal(html.match(/此间一人/g).length,1);assert.doesNotMatch(html,/PRIVATE|character_dynamics/);
  for(const status of ['ready','empty','disabled'])assert.doesNotMatch(renderModelDiagnostics({memory:{status,diagnostics:log.memory.diagnostics}}),/记忆|record_source_changed/);
  assert.match(renderModelDiagnostics({memory:{status:'unverified'}}),/记忆暂无法核对/);
  assert.match(renderModelDiagnostics({memory:{status:'unsupported'}}),/尚未适配/);
  assert.match(renderModelDiagnostics({memory:{status:'partial',diagnostics:[{code:'<script>',scope:'<unsafe>'}]}}),/&lt;script&gt;/);
});
