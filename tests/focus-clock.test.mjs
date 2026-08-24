import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

assert.match(source, /focusClock:\s*\{[\s\S]*phase: 'focus'[\s\S]*status: 'idle'[\s\S]*endsAt: 0[\s\S]*history: \[\]/, '专注状态必须独立存入全局轻量设置');
assert.match(source, /\['focus', '专注'\]/, '专注时钟必须拥有独立顶层标签');
assert.match(source, /id: 'focus', label: '专注', icon: 'fa-hourglass-half'/, '蜂巢入口列表必须包含专注时钟');
assert.match(source, /case 'focus': return renderFocusClockTab\(\)/, '专注标签必须接入统一路由');

assert.match(source, /function focusClockRemainingMs[\s\S]*state\.endsAt - now/, '运行态必须按绝对截止时间计算，避免后台节流导致计时漂移');
assert.match(source, /function focusClockStart[\s\S]*f\.endsAt = now \+ remaining/, '开始和继续必须写入真实截止时间');
assert.match(source, /function focusClockPause[\s\S]*f\.remainingMs = Math\.max\(0, f\.endsAt - now\)[\s\S]*f\.status = 'paused'/, '暂停必须把截止时间折算为剩余时长');
assert.match(source, /function focusClockRuntimeTick[\s\S]*focusClockRemainingMs\(f\) <= 0[\s\S]*focusClockComplete/, '后台恢复后必须立即结算到期阶段');
const tick = source.slice(source.indexOf('function focusClockRuntimeTick'), source.indexOf('function focusClockVisibilitySync'));
assert.doesNotMatch(tick, /saveSettings/, '每秒刷新不得持续写入 ST 设置');
assert.match(source, /startFocusClockRuntime\(\)/, '扩展初始化时必须恢复专注时钟');
assert.match(source, /stopFocusClockRuntime\(\)/, '扩展停用或热更新时必须清理计时器');

assert.match(source, /activity: 'task'[\s\S]*bookId: ''/, '专注时钟必须支持普通任务与伴读两种活动');
assert.match(source, /data-focus-activity="reading"[\s\S]*sd-focus-book[\s\S]*进入阅读/, '伴读模式必须能够绑定并打开具体书籍');
assert.match(source, /progressStart:[\s\S]*progressEnd:/, '伴读专注完成记录必须保存阅读进度变化');
assert.match(source, /sd-reader-focus-btn[\s\S]*sd-reader-focus-mini/, '阅读页必须提供专注时钟入口与实时剩余时间');
assert.match(source, /已有另一段专注正在进行/, '阅读页不得擅自覆盖正在进行的其他书籍专注');

assert.match(source, /FOCUS_CLOCK_HISTORY_LIMIT = 120/, '完成记录必须有明确容量上限');
assert.match(source, /f\.focusCycle % f\.longBreakEvery === 0 \? 'longBreak' : 'shortBreak'/, '专注周期必须按用户设置进入小憩或长休');
assert.match(source, /autoStartNext[\s\S]*完成提示音/, '自动下一阶段与提示音必须保留为用户自选项');
assert.match(css, /\.sd-focus-ring\s*\{[^}]*conic-gradient/, '主计时器必须使用清晰的环形进度视觉');
assert.match(css, /\.sd-focus-setting-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3/, '桌面周期设置必须使用紧凑网格');
assert.match(css, /@media \(max-width: 520px\)[\s\S]*\.sd-focus-setting-grid\s*\{[^}]*repeat\(2/, '移动端周期设置必须保持两列易读布局');
assert.match(css, /\.sd-reader-focus-btn\.active/, '伴读阅读页必须明确显示当前绑定的专注计时');

console.log('Focus clock contract OK');
