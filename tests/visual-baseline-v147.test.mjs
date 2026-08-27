import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

// 视觉基线回到 v1.46 的既有比例，不再以全局令牌覆盖成熟模块。
for (const token of ['--sd-type-body', '--sd-type-title', '--sd-type-control', '--sd-card-pad', '--sd-icon-button-size']) {
  assert.ok(!css.includes(token), `unexpected global visual token: ${token}`);
}
assert.match(css, /#story-director-modal,[\s\S]*#story-director-modal \.sd-window\s*\{[^}]*font-size:\s*14\.5px !important/);
assert.match(css, /\.sd-icon-btn\s*\{[^}]*width:\s*32px[^}]*height:\s*32px/);
assert.match(css, /\.sd-icon-btn i\s*\{[^}]*font-size:\s*14px/);
assert.match(css, /sd-wheel-command i\s*\{[^}]*font-size:\s*clamp\(15px,[^}]*\.44[^}]*22px\)/);
assert.match(source, /QUICK_ICON_OPTICAL_SCALE[\s\S]*tts:\s*1\.16[\s\S]*plug:\s*1\.04/);

// 编辑正文不撤旧图；仅显式重绘且未被手动锁定的自动模式才重新调用 LLM。
assert.match(source, /storyboardInlineRecordValid[\s\S]*\['active', 'stale'\]\.includes\(record\.linkState\)/);
assert.doesNotMatch(source, /正文已更改 · 原图保留/);
assert.match(source, /record\?\.linkState === 'stale'\) return Number\.isInteger\(record\?\.floor\)/);
assert.match(source, /function storyboardRedrawRecord[\s\S]*shouldRecompile = !promptLocked && mode !== 'manual'[\s\S]*explicit-redraw-after-edit/);
assert.match(source, /record\.promptLocked = true/);
assert.match(source, /promptMode: state\.promptMode[\s\S]*promptLocked: Boolean\(state\.promptDraft\?\.userEditedCompiled\)/);

console.log('v1.48.0 visual rollback and edited-storyboard continuity contract OK');
