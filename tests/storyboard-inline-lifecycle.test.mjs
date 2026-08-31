import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  STORYBOARD_SCHEMA_VERSION,
  createStoryboardDefaults,
  normalizeStoryboardState,
} from '../qianmu-storyboard.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

assert.equal(STORYBOARD_SCHEMA_VERSION, 10);
const defaults = createStoryboardDefaults();
assert.deepEqual(defaults.automation, { autoCapture: true, autoGenerate: true });
assert.equal(defaults.promptCompiler.enabled, true);
const normalized = normalizeStoryboardState({
  schemaVersion: 4,
  automation: { autoCapture: true, autoGenerate: true },
  shotPlans: [{
    id: 'plan-a', chatKey: 'chat-a', floor: 4, revisionId: 'rev-a', status: 'prompt_ready',
    shots: [{ id: 'shot-a', prompt: 'a quiet room', status: 'queued' }],
  }],
});
assert.equal(normalized.shotPlans[0].status, 'prompt_ready');
assert.equal(normalized.shotPlans[0].shots[0].status, 'queued');

// Inline nodes are DOM-only siblings of .mes_text: no message mutation or regex dependency.
assert.match(source, /正文镜头节点|Keep the frame outside \.mes_text/);
assert.match(source, /text\.insertAdjacentElement\('afterend', wrapper\)/);
const inlineRender = source.slice(source.indexOf('function storyboardRenderInlineImages'), source.indexOf('function storyboardScheduleInlineRender'));
assert.doesNotMatch(inlineRender, /\.mes\s*=|ctx\(\)\.chat\[[^\]]+\]\.mes\s*=/);
assert.match(source, /if \(!storyboardState\(\)\.enabled\)[\s\S]*sd-storyboard-inline, \.sd-storyboard-message-action/);

// One lifecycle survives refreshes from prompt preparation through generation and completion.
for (const status of ['compiling', 'prompt_ready', 'queued', 'generating', 'completed', 'failed', 'cancelled', 'orphaned']) {
  assert.match(source, new RegExp(`['\"]${status}['\"]`));
}
assert.match(source, /createStoryboardWorkflowTicket/);
assert.match(source, /storyboardSetPlanStatus\(plan, 'generating'/);
assert.match(source, /storyboardSetPlanStatus\(plan, 'completed'/);
assert.match(source, /storyboardReconcileShotPlans/);

// Only completed images enter the immersive chat surface; the title appears only while folded.
assert.match(source, /刻瞬于光/);
assert.match(source, /STORYBOARD_INLINE_MARK/);
assert.match(source, /sd-storyboard-inline-reel/);
assert.match(source, /records\.map\(storyboardInlineRecordMarkup\)/);
assert.match(source, /storyboardCollapsedInlineFloors\.has\(floor\)/);
assert.match(source, /data-storyboard-chat-action="collapse"/);
assert.match(source, /data-storyboard-chat-action="expand"/);
assert.match(source, /data-storyboard-chat-action="toggle-actions"/);
assert.match(source, /figure\.classList\.toggle\('actions-open', open\)/);
assert.match(css, /sd-storyboard-inline-title/);
assert.match(css, /figure\.actions-open \.sd-storyboard-inline-actions/);

// Redraw reuses the accepted prompt; re-extraction is a separate explicit camera action.
assert.match(source, /原楼层原地编辑时保留已接受的旧图/);
assert.match(source, /function storyboardRedrawRecord[\s\S]*snapshot\.promptMode = 'manual'[\s\S]*snapshot\.promptLocked = true/);
assert.doesNotMatch(source, /shouldRecompile = !promptLocked/);
assert.match(source, /function storyboardChooseCaptureMode[\s\S]*智能选取画面[\s\S]*指定正文段落/);
assert.match(source, /原正文楼层已删除，未发起生图请求/);
assert.match(source, /linkState === 'inactive_swipe'/);

// New installations expose two compact automation tags under one capsule master switch.
assert.match(source, /sd-storyboard-capsule-switch/);
assert.match(source, /sd-storyboard-auto-capture[\s\S]*自动提取生成词/);
assert.match(source, /sd-storyboard-auto-generate[\s\S]*自动生图/);
assert.doesNotMatch(source, /sd-storyboard-auto-flow/);
assert.match(source, /function storyboardHandleAutomaticCapture/);
assert.match(source, /state\.enabled \|\| !state\.automation\?\.autoCapture \|\| !state\.promptCompiler\?\.enabled/);
assert.match(source, /storyboardGenerate\(null, \{ plan, automatic: true \}\)/);
assert.match(source, /data-storyboard-chat-action="edit"/);
assert.match(source, /data-storyboard-chat-action="redraw"/);

console.log('Storyboard inline lifecycle contract OK');
