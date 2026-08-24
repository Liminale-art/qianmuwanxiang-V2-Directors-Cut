import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
for (const name of ['light.mp3', 'daylight.mp3', 'silver-bell.mp3', 'bright.mp3', 'horizon.mp3', 'sunrise.mp3']) {
  const file = await stat(new URL(`../assets/focus-sounds/${name}`, import.meta.url));
  assert.ok(file.size > 0, `内置提示音资源不能为空：${name}`);
}

assert.match(source, /focusClock:\s*\{[\s\S]*phase: 'focus'[\s\S]*status: 'idle'[\s\S]*endsAt: 0[\s\S]*history: \[\]/, '专注状态必须独立存入全局轻量设置');
assert.match(source, /\['focus', '专注'\]/, '专注时钟必须拥有独立顶层标签');
assert.match(source, /\['tts', '配音'\],\s*\['focus', '专注'\]/, '专注标签必须排列在配音之后');
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
assert.match(source, /const returnTab = activeTab === 'focus' \? 'focus' : 'coread'[\s\S]*activeTab = 'coread'/, '从专注进入阅读器时必须切到伴读路由，防止计时重渲染卸载阅读页');
assert.match(source, /const returnTab = readerView\?\.returnTab === 'focus'[\s\S]*activeTab = returnTab/, '退出阅读器必须能够回到原专注页');

assert.match(source, /FOCUS_CLOCK_WEEK_ENTRY_LIMIT = 160/, '本周明细必须有异常容量保护');
assert.match(source, /historyBeforeCleanup[\s\S]*finishedAt \|\| item\.startedAt\) >= weekStart/, '不可见的往周记录必须在状态归一时自动清理');
assert.match(source, /function focusClockWeekStats[\s\S]*readingMinutes/, '本周记录必须按日聚合专注与伴读分钟');
assert.match(source, /function focusClockExportWeekImage[\s\S]*canvas\.toBlob[\s\S]*千幕-本周专注/, '本周记录必须可导出独立 PNG 图片');
assert.match(source, /f\.focusCycle % f\.longBreakEvery === 0 \? 'longBreak' : 'shortBreak'/, '专注周期必须按用户设置进入小憩或长休');
assert.match(source, /sd-focus-settings-head[\s\S]*sd-focus-auto-next-wrap/, '自动下一阶段必须位于周期设置标题右侧');
assert.match(source, /sd-focus-sound-card[\s\S]*<h3>完成提示音<\/h3>/, '完成提示音必须使用独立卡片');
assert.match(source, /FOCUS_CLOCK_SOUND_PRESETS[\s\S]*light\.mp3[\s\S]*daylight\.mp3[\s\S]*silver-bell\.mp3[\s\S]*bright\.mp3[\s\S]*horizon\.mp3[\s\S]*sunrise\.mp3[\s\S]*Merry%20Christmas%20Mr\.%20Lawrence\.mp3[\s\S]*Farewell\.mp3/, '完成提示音必须包含六个正式内置文件与两个内置外链资源');
assert.match(source, /soundSource: 'builtin'[\s\S]*soundUrl: ''/, '提示音必须支持内置与外链方案');
assert.doesNotMatch(source, /data-focus-sound-source="file"|sd-focus-sound-file/, '本地提示音入口必须移除');
assert.match(source, /data-focus-sound-source="\$\{id\}"[\s\S]*sd-focus-sound-preview/, '提示音来源必须可切换并可试听');
assert.match(source, /FOCUS_CLOCK_RELATIONS[\s\S]*stranger[\s\S]*neutral[\s\S]*friend[\s\S]*partner[\s\S]*elder/, '角色语音必须提供陌生、中性、朋友、伴侣、长者五档关系');
assert.match(source, /FOCUS_CLOCK_VOICE_FREQUENCIES[\s\S]*chance: \.3[\s\S]*chance: \.5[\s\S]*chance: \.75/, '长时角色语音必须按 30%、50%、75% 三档概率决定');
assert.match(source, /function focusClockMidCueProgresses[\s\S]*durationMinutes < 45[\s\S]*if \(!selected\.length\) selected\.push/, '长时角色语音必须保证至少一次中途陪伴');
assert.match(source, /\['url', '自定义'\]/, '完成提示音的自定义来源必须使用清晰文案');
assert.match(source, /voiceEnabledByChat[\s\S]*voiceSpeakerByChat[\s\S]*voiceRelationByChat/, '角色语音启用、角色与关系必须按聊天隔离');
assert.match(source, /你是“千幕专注场景”的角色短句编写器[\s\S]*不引用聊天正文[\s\S]*不得猜测正文情节/, '情景生成提示词必须与正文隔离并约束不 OOC');
assert.match(source, /function focusClockPrepareVoiceCues[\s\S]*ttsBuildParams[\s\S]*focusClockSynthVoiceCue/, '角色语音必须在开始时冻结音色参数并预生成缓存');
assert.match(source, /function focusClockOpenVoiceDrawer[\s\S]*sd-focus-cue-play[\s\S]*sd-focus-cue-regen[\s\S]*sd-focus-cue-fav[\s\S]*sd-focus-cue-download/, '专注角色语音必须通过二层抽屉提供重听、重生成、收藏和下载');
assert.match(source, /voiceText: completionCue\?\.text \|\| '', voiceCues: completedVoiceCues/, '完成记录必须持久化可回放的安全语音缓存索引');
assert.match(source, /blobStore\.addFavorite[\s\S]*source: 'focus'/, '专注语音必须复用配音收藏夹存储');
assert.match(source, /function focusClockVoiceCueFileBase[\s\S]*speaker[\s\S]*task[\s\S]*ttsCompactStamp/, '专注角色语音命名必须包含角色、任务与时间');
assert.match(source, /function focusClockPlayCompletionAlert[\s\S]*focusClockPlayDoneSound/, '角色语音失败必须回退普通完成提示音');
assert.match(source, /sd-focus-finale-card[\s\S]*sd-focus-finale-note/, '完成后必须提供可随记的片尾卡');
assert.match(css, /\.sd-focus-ring\s*\{[^}]*conic-gradient/, '主计时器必须使用清晰的环形进度视觉');
assert.match(css, /\.sd-focus-setting-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3/, '桌面周期设置必须使用紧凑网格');
assert.match(css, /@media \(max-width: 520px\)[\s\S]*\.sd-focus-setting-grid\s*\{[^}]*repeat\(2/, '移动端周期设置必须保持两列易读布局');
assert.match(css, /\.sd-reader-focus-btn\.active/, '伴读阅读页必须明确显示当前绑定的专注计时');
assert.match(css, /\.sd-focus-actions\s*\{[^}]*width:\s*min\(100%, 460px\)/, '暂停与结束按钮组必须和进入阅读区域同宽');
assert.match(css, /\.sd-focus-week-chart\s*\{[^}]*repeat\(7/, '本周记录必须以七日图表呈现');
assert.match(css, /\.sd-focus-voice-grid\s*\{[^}]*repeat\(2/, '角色与关系选择必须使用整齐双列布局');

console.log('Focus clock contract OK');
