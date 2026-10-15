import test from 'node:test';
import assert from 'node:assert/strict';
import { completeDirectorCards, directorPreviewPlan, directorSectionStatus, directorSectionEnabled, directorQualitySummary, renderDirectorLive, renderModelDiagnostics, modelFailureText } from '../qianmu-director-live.js';
import { validateCreativePlan } from '../qianmu-creative-contract.js';

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
  assert.equal(JSON.stringify(log),before);assert.match(html,/&lt;img&gt;/);assert.doesNotMatch(html,/failure|正在推演|本次未完整完成|<img>|data-inject|sd-lib-load/);
  assert.doesNotMatch(tasks,/各自人间/);assert.equal(renderDirectorLive({...log,status:'success'}),'');
});

test('all closed creative fields project into ordinary sections without adopting or mutating the raw log', () => {
  const log = { status: 'loading', response: '{"story_status":{"title":"next"},"world_chatter":[{"text":"news"}],"quests":[{"title":"closed"},{"title":"unfinished' };
  const before = JSON.stringify(log), plan = directorPreviewPlan(log);
  assert.equal(plan.story_status.title, 'next'); assert.equal(plan.world_chatter[0].text, 'news');
  assert.equal(plan.quests.length, 1); assert.equal(plan._streamPreview, true);
  assert.equal(JSON.stringify(log), before); assert.equal(directorPreviewPlan({ ...log, status: 'success' }), null);
  for (const status of ['error', 'cancelled']) assert.equal(directorPreviewPlan({ ...log, status }), null);
});

test('failure and interruption reasons belong to the failure panel, never below returned text', () => {
  const log = { status: 'error', error: '回复截断', completion: { finishReason: 'length', interrupted: true } };
  assert.equal(modelFailureText(log), '回复被截断（length）。');
  assert.doesNotMatch(renderModelDiagnostics(log), /结束原因|未完整完成|渠道未提供/);
  assert.match(modelFailureText({ status: 'cancelled' }), /已中断/);
});

test('interruption preserves the original cause, finish reason and quality facts only in the failure panel', () => {
  const log = { status: 'error', error: '本次推演未完整完成。', errorCause: '模型达到输出长度上限', errorCode: 'MODEL_OUTPUT_INCOMPLETE',
    response: '{"quests":[]}', quality: { issues: [{ field: 'quests', missing: 5 }] },
    completion: { interrupted: true, finishReason: 'length', rawTransport: '<unparsed>', compatibility: '兼容渠道信息' } };
  const before = JSON.stringify(log), text = modelFailureText(log);
  assert.equal(text, '回复被截断（length）。\n缺失内容：预演缺 5 条');
  assert.doesNotMatch(text, /原始错误|错误代码|本次推演未完整完成/);
  const failure = renderModelDiagnostics(log, { failure: true }), bottom = renderModelDiagnostics(log);
  assert.match(failure, /原始服务响应[\s\S]*&lt;unparsed&gt;/);
  assert.match(failure, /兼容渠道信息/);
  assert.doesNotMatch(bottom, /unparsed|兼容渠道信息|结束原因|缺失内容/);
  assert.equal(JSON.stringify(log), before);
  assert.equal(renderModelDiagnostics({ status: 'success' }, { failure: true }), '');
});

test('an internal shortfall is stated once while unique parser diagnostics remain expandable', () => {
  const log = { status: 'error', error: '本次推演未完整完成；已收到的条目仍可查看。',
    errorCause: '本次内容未完整达到栏目要求；已收内容可只读查看，缺项已记入日志。', errorCode: 'MODEL_OUTPUT_INCOMPLETE',
    response: '{"quests":[]}', hasValidContent: true, quality: { issues: [{ field: 'quests', missing: 1 }] }, completion: { complete: true, finishReason: 'stop' } };
  assert.equal(modelFailureText(log), '缺失内容：预演缺 1 条');
  assert.doesNotMatch(renderModelDiagnostics(log, { failure: true }), /本次内容|原始错误|错误详情|MODEL_OUTPUT_INCOMPLETE/);
  const malformed = { ...log, error: '模型输出格式有误。', errorCode: undefined, errorCause: 'JSON_PARSE_FAILED::Unexpected token at position 143' };
  assert.equal(modelFailureText(malformed), '模型输出格式有误。\n缺失内容：预演缺 1 条');
  assert.match(renderModelDiagnostics(malformed, { failure: true }), /<details class="sd-log-error-detail"><summary>错误详情<\/summary>[\s\S]*JSON_PARSE_FAILED::Unexpected token at position 143/);
  assert.doesNotMatch(renderModelDiagnostics(malformed), /JSON_PARSE_FAILED|错误详情/);
  assert.equal(modelFailureText({ ...log, hasValidContent: false }), '回复未完整接收。', 'failed raw tokens do not manufacture a missing-content list');
});

test('old repair responses stay readable as historical evidence without promising current automatic calls', () => {
  const html = renderModelDiagnostics({ repairResponse: '<partial JSON>', response: 'FIRST ORIGINAL' });
  assert.match(html, /历史补写记录 · 独立模型回复/);
  assert.match(html, /&lt;partial JSON&gt;/);
  assert.doesNotMatch(html, /FIRST ORIGINAL|定向补写|<partial JSON>|仅追加一次|额外消耗 token/);
  assert.doesNotMatch(renderModelDiagnostics({}), /历史补写记录/);
});

test('submitted incomplete runs retain readonly cards and show factual section notices from the same log', () => {
  const log = { request: 'sent', status: 'error', response: '{"quests":[{"title":"已收到","description":"来信放在桌上。"}]}',
    creativeOptions: { interludeEnabled: false, parallelSceneEnabled: true, worldChatterEnabled: false },
    quality: { issues: [{ field: 'quests', missing: 4 }, { field: 'story_status', missing: 1 }, { field: 'parallel_scene', missing: 1 }] },
    completion: { finishReason: 'stop', complete: true } };
  const before = JSON.stringify(log), plan = directorPreviewPlan(log);
  assert.equal(plan._streamPreview, true); assert.equal(plan.quests[0].title, '已收到');
  assert.match(directorSectionStatus(plan, 'quests'), /返回不完整/);
  assert.equal(directorSectionStatus(plan, 'parallel_scene'), '本幕返回不完整');
  assert.doesNotMatch(directorSectionStatus(plan, 'parallel_scene'), /截断/);
  assert.equal(directorSectionEnabled(plan, 'interlude', { interludeEnabled: true }), false);
  assert.equal(directorSectionEnabled(plan, 'world_chatter', { worldChatterEnabled: true }), false);
  assert.equal(directorSectionStatus(plan, 'faction_relations'), '', 'an optional absent connection is not a failed section');
  assert.match(directorQualitySummary(log), /命运之脉缺 1 条/);
  assert.doesNotMatch(renderModelDiagnostics(log), /未自动补写|本次内容未完整|命运之脉缺/);
  assert.match(modelFailureText(log), /缺失内容：.*命运之脉缺 1 条/);
  const ended = directorPreviewPlan({ ...log, completion: { finishReason: 'MAX_TOKENS', interrupted: true } });
  assert.equal(directorSectionStatus(ended, 'parallel_scene'), '本幕返回不完整');
  assert.equal(directorSectionStatus(directorPreviewPlan({ ...log, status: 'cancelled' }), 'quests'), '');
  assert.equal(directorSectionStatus(directorPreviewPlan({ ...log, status: 'loading' }), 'quests'), '');
  assert.equal(directorPreviewPlan({ ...log, request: '' }), null, 'no request means no failed-run overlay on saved content');
  assert.equal(directorPreviewPlan({ ...log, status: 'success' }), null);
  assert.equal(JSON.stringify(log), before);
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
  assert.doesNotMatch(html,/记忆|record_source_changed|PRIVATE|character_dynamics|此间一人缺|幕间拾趣缺/);
  assert.doesNotMatch(renderModelDiagnostics({memory:{status:'unsupported',diagnostics:[{code:'unsupported_memory_schema_or_mode'}]}}),/尚未适配|记忆核对/);
  assert.equal(modelFailureText({...log,status:'error'}), '本次推演未完成。');
});

test('structured directions and social cards wait for their outer object and retain nested payloads', () => {
  const values = {
    story_status: { directions: [{ title: '跨城追索', content: '来源核对改变调查范围。' }, { title: '旧案回响', content: '既往裁决进入新的审查。' }] },
    interlude: { type: 'forum', title: '街坊交流', posts: [{ author: '居民', content: '<script>unsafe</script>', replies: [{ author: '店主', content: '新路线' }] }] },
  };
  for (const [field, value] of Object.entries(values)) {
    const prefix = `{"${field}":`, body = JSON.stringify(value);
    for (let i = 0; i < body.length; i++) assert.deepEqual(completeDirectorCards(prefix + body.slice(0, i)), []);
    const log = { status: 'loading', response: prefix + body + '}' };
    assert.deepEqual(directorPreviewPlan(log)[field], value);
    assert.doesNotMatch(renderDirectorLive(log), /<script>/);
  }
  const phone = { type: 'phone', title: '值班群', owner: '同事', messages: [{ sender: '组员', content: '我带钥匙。' }] };
  assert.deepEqual(directorPreviewPlan({ status: 'loading', response: JSON.stringify({ interlude: phone }) }).interlude, phone);
});

test('phone feeds stage their own closed posts payload without requiring chat messages or changing the source', () => {
  for (const view_type of ['moments', 'microblog']) {
    const value = { type: 'phone', view_type, owner: '值班员', title: '午后动态', posts: [
      { author: '摊主', handle: '旧街口', content: '<img src=x onerror=alert(1)>灯修好了。', time: '12:20', replies: [{ author: '邻居', content: '晚点经过看看。' }] },
    ] };
    const prefix = '{"interlude":', body = JSON.stringify(value), before = JSON.stringify(value);
    for (let i = 0; i < body.length; i++) assert.deepEqual(completeDirectorCards(prefix + body.slice(0, i)), [], `${view_type}/${i}`);
    const cards = completeDirectorCards(prefix + body + '}');
    assert.equal(cards.length, 1); assert.equal(cards[0].field, 'interlude'); assert.deepEqual(cards[0].value, value);
    assert.ok(cards[0].lines.includes(value.posts[0].content), 'feed contents reach readonly generic preview lines');
    const log = { request: 'sent', status: 'error', response: prefix + body + '}',
      creativeOptions: { interludeEnabled: true, interludeType: 'phone', phoneViewType: view_type },
      quality: { issues: [{ field: 'interlude', missing: 1, reason: '手机动态须至少有 6 帖' }] } };
    const plan = directorPreviewPlan(log);
    assert.deepEqual(plan.interlude, value); assert.equal(directorSectionStatus(plan, 'interlude'), '本幕返回不完整');
    assert.equal(directorQualitySummary(log), '幕间拾趣缺 1 张');
    const html = renderDirectorLive(log, { fields: ['interlude'] });
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;灯修好了。/);
    assert.doesNotMatch(html, /<img|data-inject|sd-inject|sd-lib-load|12 条|messages/);
    assert.equal(JSON.stringify(value), before);
    assert.equal(directorSectionStatus(directorPreviewPlan({ ...log, status: 'cancelled' }), 'interlude'), '');
    assert.equal(directorSectionStatus(directorPreviewPlan({ ...log, status: 'error', quality: { issues: [] } }), 'interlude'), '');
  }
});

test('phone preview requires content from the selected page while retaining legacy chat records', () => {
  for (const view_type of ['moments', 'microblog']) {
    for (const posts of [[], [{ content: '  ' }], [{ title: 'only a heading' }]]) {
      const value = { type: 'phone', view_type, title: '动态', owner: '同事', posts, messages: [{ content: 'wrong-page content' }] };
      assert.deepEqual(completeDirectorCards(JSON.stringify({ interlude: value })), []);
    }
  }
  for (const view_type of [undefined, 'chat']) {
    const value = { type: 'phone', title: '值班群', owner: '同事', ...(view_type ? { view_type } : {}), messages: [{ sender: '组员', content: '我带钥匙。' }] };
    const cards = completeDirectorCards(JSON.stringify({ interlude: value }));
    assert.equal(cards.length, 1); assert.ok(cards[0].lines.includes('我带钥匙。'));
    assert.deepEqual(completeDirectorCards(JSON.stringify({ interlude: { ...value, messages: [], posts: [{ content: 'wrong-page content' }] } })), []);
  }
});

test('phone feed shortfalls use the actual feed quota without manufacturing posts or reusing chat-message limits', () => {
  for (const view_type of ['moments', 'microblog']) {
    const options = { interludeEnabled: true, interludeType: 'phone', phoneViewType: view_type };
    const posts = Array.from({ length: 6 }, (_, i) => ({ author: `街坊${i}`, content: `第${i}条日常动态。`, time: `12:${String(i).padStart(2, '0')}`,
      replies: i < 2 ? [{ author: '邻居', content: '下回一起。' }] : [] }));
    const full = { interlude: { type: 'phone', view_type, owner: '值班员', title: '午后动态', posts } };
    assert.equal(validateCreativePlan(full, options).some(issue => issue.field === 'interlude'), false);
    const partial = { interlude: { ...full.interlude, posts: posts.slice(0, 5) } }, before = JSON.stringify(partial);
    const issues = validateCreativePlan(partial, options).filter(issue => issue.field === 'interlude');
    assert.equal(issues.length, 1); assert.equal(issues[0].missing, 1); assert.match(issues[0].reason, /至少有 6 条/);
    assert.doesNotMatch(issues[0].reason, /12|消息/);
    const log = { status: 'error', request: 'sent', response: JSON.stringify(partial), quality: { issues }, creativeOptions: options };
    assert.equal(directorPreviewPlan(log).interlude.posts.length, 5);
    assert.equal(directorQualitySummary(log), '幕间拾趣缺 1 张');
    assert.equal(directorSectionStatus(directorPreviewPlan(log), 'interlude'), '本幕返回不完整');
    assert.equal(JSON.stringify(partial), before);
  }
});
