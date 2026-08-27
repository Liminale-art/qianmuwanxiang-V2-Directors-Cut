import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  STORYBOARD_SCHEMA_VERSION,
  createStoryboardDefaults,
  normalizeStoryboardState,
} from '../qianmu-storyboard.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

assert.equal(STORYBOARD_SCHEMA_VERSION, 5);
const defaults = createStoryboardDefaults();
assert.deepEqual(defaults.automation, { autoCapture: false, autoGenerate: false });
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

// The current floor gets a minimal empty node; completed images remain directly visible.
assert.match(source, /刻瞬于光/);
assert.match(source, /STORYBOARD_INLINE_ICONS/);
assert.match(source, /sd-storyboard-inline-reel/);
assert.match(source, /records\.map\(storyboardInlineRecordMarkup\)/);
assert.match(source, /data-storyboard-chat-action="toggle-actions"/);
assert.match(source, /figure\.classList\.toggle\('actions-open', open\)/);
assert.match(css, /sd-storyboard-inline-title/);
assert.match(css, /sd-storyboard-inline-breathe/);
assert.match(css, /figure\.actions-open \.sd-storyboard-inline-actions/);

// Editing keeps the accepted image; only explicit redraw recompiles automatic prompts.
assert.match(source, /原楼层原地编辑时保留已接受的旧图/);
assert.match(source, /shouldRecompile = !promptLocked && mode !== 'manual'/);
assert.match(source, /原正文楼层已删除，未发起生图请求/);
assert.match(source, /linkState === 'inactive_swipe'/);

// Automatic capture is opt-in twice: module, LLM cooperation, then optional generation.
assert.match(source, /sd-storyboard-auto-capture/);
assert.match(source, /sd-storyboard-auto-generate/);
assert.match(source, /function storyboardHandleAutomaticCapture/);
assert.match(source, /state\.enabled \|\| !state\.automation\?\.autoCapture \|\| !state\.promptCompiler\?\.enabled/);
assert.match(source, /storyboardGenerate\(null, \{ plan, automatic: true \}\)/);

console.log('Storyboard inline lifecycle contract OK');
