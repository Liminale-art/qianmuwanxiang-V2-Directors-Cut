import test from 'node:test';
import assert from 'node:assert/strict';
import { completeDirectorCards, renderDirectorLive } from '../qianmu-director-live.js';

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
  assert.equal(completeDirectorCards('{"director_comment":["A","B"').length,2);
});

test('preview is read-only, escaped, leaves old plan untouched and disappears only on complete success',()=>{
  const log={id:'<unsafe>',status:'error',error:'<failure>',response:'{"quests":[{"title":"<img>","objective":"正文"}],"npc_updates":[{"name":"角色"}]}'};
  const before=JSON.stringify(log),html=renderDirectorLive(log),tasks=renderDirectorLive(log,{tasksOnly:true});
  assert.equal(JSON.stringify(log),before);assert.match(html,/&lt;img&gt;/);assert.match(html,/&lt;failure&gt;/);assert.doesNotMatch(html,/<img>|data-inject|sd-lib-load/);
  assert.doesNotMatch(tasks,/角色动向/);assert.equal(renderDirectorLive({...log,status:'success'}),'');
});
