import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');

assert.match(source, /function proseLayoutCaptureViewport[\s\S]*querySelectorAll\('\.mes'\)[\s\S]*atBottom:/, '切换排版前必须捕获当前可见楼层与底部状态');
assert.match(source, /function proseLayoutScheduleViewportRestore[\s\S]*overflow-anchor[\s\S]*requestAnimationFrame[\s\S]*requestAnimationFrame/, '重排期间必须关闭原生锚定并等待两帧布局稳定');
assert.match(source, /snapshot\.anchor\.getBoundingClientRect[\s\S]*chat\.scrollTop \+= currentOffset - snapshot\.offset/, '非底部视口必须按同一楼层像素偏移恢复');
assert.match(source, /if \(snapshot\.atBottom\)[\s\S]*chat\.scrollHeight - chat\.clientHeight/, '原本在底部时必须继续保持底部');
assert.match(source, /function applyProseLayout[\s\S]*proseLayoutCaptureViewport\(\)[\s\S]*proseLayoutScheduleViewportRestore\(viewport\)/, '开启和取消排版必须统一走楼层锚点恢复');

console.log('Prose layout scroll anchor contract OK');
