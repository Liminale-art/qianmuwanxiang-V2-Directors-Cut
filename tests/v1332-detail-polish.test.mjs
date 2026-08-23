import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

// 日志按 ID 持久记忆开合状态，新日志默认折叠，并随日志上限清理旧键。
assert.match(source, /logOpenState:\s*\{\}/);
assert.match(source, /function pushLog[\s\S]*logOpenState\[entry\.id\] = false[\s\S]*validIds/);
assert.match(source, /function applyAccState[\s\S]*key\?\.startsWith\('log-'\)[\s\S]*addEventListener\('toggle'[\s\S]*saveSettings\(\)/);
assert.match(source, /sd-log-entry[^`]*logOpenState\?\.\[id\] === true \? ' open' : ''/);
assert.doesNotMatch(source, /sd-log-entry[^`]*index === 0 \? 'open'/);

// 注入子卡之间留白；剧组之律副注释靠右。
assert.match(css, /\.sd-inject-subfold \+ \.sd-inject-subfold\s*\{[^}]*margin-top:\s*20px/);
assert.match(css, /\.sd-director-law-fold > summary\s*\{[^}]*justify-content:\s*space-between/);
assert.match(css, /\.sd-director-law-fold > summary \.sd-summary-note\s*\{[^}]*margin-left:\s*auto/);

// 剧本库与剧札使用同一通用工具栏和标题后数量标签；当前标题同步精简。
const templateCfg = source.slice(source.indexOf('function templateLibraryCfg'), source.indexOf('function renderBlueprintEditorContent'));
assert.match(templateCfg, /inlineCount:\s*true/);
assert.match(source, /<h3>当前剧本<\/h3>/);
assert.doesNotMatch(source, /当前聊天的剧本/);

// 态势关系标签缩小，线索点在布局阶段绕开势力名所占弧段。
assert.match(css, /\.sd-geo-chip\s*\{[^}]*font-size:\s*\.68em[^}]*padding:\s*1px 6px/);
assert.match(css, /\.sd-geo-chip i\s*\{[^}]*width:\s*6px[^}]*height:\s*6px/);
assert.doesNotMatch(css, /button\.sd-geo-chip\s*\{[^}]*font:\s*inherit/, '按钮不得用 font 简写覆盖缩小后的字号');
assert.match(source, /const blockedAngle = Math\.atan2[\s\S]*labelGap = Math\.PI \* \.62[\s\S]*freeArc/);
assert.match(source, /blockedAngle \+ labelGap \/ 2 \+ \(\(j \+ \.5\)/);

console.log('v1.33.2 detail polish contract OK');
