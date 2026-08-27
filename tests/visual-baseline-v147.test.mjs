import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

// 一个令牌体系约束全模块正文、标题、控件、注释、卡片和图标，避免后续页面继续各自漂移。
for (const token of [
  '--sd-type-body: 15px', '--sd-type-title: 16px', '--sd-type-control: 14px', '--sd-type-note: 12px',
  '--sd-card-gap: 12px', '--sd-card-pad: 14px', '--sd-icon-button-size: 34px', '--sd-icon-glyph-size: 16px',
]) assert.ok(css.includes(token), `missing visual token: ${token}`);
assert.match(css, /\.sd-window\s*\{[^}]*font-size:\s*var\(--sd-type-body\) !important/);
assert.match(css, /select\.text_pole\s*\{[\s\S]*font-size:\s*var\(--sd-type-control\) !important/);
assert.match(css, /\.sd-storyboard-root \.sd-card,[\s\S]*margin-bottom:\s*0/);

// 伴读中心主字号增大，注释维持小字号；标签、图标与输入框有明确尺寸。
assert.match(css, /\.sd-reader-morepage\s*\{[^}]*font-size:\s*16px/);
assert.match(css, /\.sd-reader-center-book-copy small,[^}]*font-size:\s*11px/);
assert.match(css, /\.sd-reader-mtab\s*\{[^}]*font-size:\s*14px/);
assert.match(css, /\.sd-reader-mtab i\s*\{[^}]*font-size:\s*17px/);
assert.match(css, /\.sd-reader-minput\s*\{[^}]*min-height:\s*38px[^}]*font-size:\s*14px/);

// 蜂巢图标采用统一基准并为视觉偏小图标做光学校正。
assert.match(css, /sd-wheel-command i\s*\{[^}]*font-size:\s*clamp\(17px,[^}]*\.50[^}]*25px\)/);
assert.match(source, /QUICK_ICON_OPTICAL_SCALE[\s\S]*tts:\s*1\.22[\s\S]*imagegen:\s*1\.10/);

// 编辑正文不撤旧图；仅显式重绘且未被手动锁定的自动模式才重新调用 LLM。
assert.match(source, /storyboardInlineRecordValid[\s\S]*\['active', 'stale'\]\.includes\(record\.linkState\)/);
assert.match(source, /正文已更改 · 原图保留/);
assert.match(source, /function storyboardRedrawRecord[\s\S]*shouldRecompile = !promptLocked && mode !== 'manual'[\s\S]*explicit-redraw-after-edit/);
assert.match(source, /record\.promptLocked = true/);
assert.match(source, /promptMode: state\.promptMode[\s\S]*promptLocked: Boolean\(state\.promptDraft\?\.userEditedCompiled\)/);

console.log('v1.47 visual baseline and edited-storyboard continuity contract OK');
