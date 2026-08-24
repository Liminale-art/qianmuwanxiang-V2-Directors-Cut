import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  STORYBOARD_SOURCES,
  buildImagineCommand,
  createStoryboardDefaults,
  normalizeStoryboardState,
  storyboardRatioDimensions,
} from '../qianmu-storyboard.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

assert.deepEqual(Object.keys(STORYBOARD_SOURCES), ['novel', 'comfy', 'openai', 'banana'], '第一阶段只开放四种确认过的连接');
assert.equal(STORYBOARD_SOURCES.banana.stSource, 'google', 'Banana 必须复用 ST 官方 Google 图像后端');
assert.equal(STORYBOARD_SOURCES.novel.secretKey, 'api_key_novel');
assert.equal(STORYBOARD_SOURCES.openai.secretKey, 'api_key_openai');
assert.equal(STORYBOARD_SOURCES.banana.secretKey, 'api_key_makersuite');

const defaults = createStoryboardDefaults();
assert.equal(defaults.profiles.novel.model, '', '千幕不得硬塞默认模型或画质预设');
assert.equal(defaults.profiles.openai.openaiQuality, '', 'OpenAI 画质默认也必须留空/沿用 ST');
assert.equal(defaults.characterView, 'directory');
assert.deepEqual(defaults.logs, []);

const command = buildImagineCommand({ prompt: 'cinematic portrait', negative: 'watermark', width: 1024, height: 1536, steps: 28, cfg: 6.5, seed: -1 });
assert.match(command, /^\/imagine quiet=true gallery=false /);
assert.match(command, /negative="watermark"/);
assert.match(command, /width=1024 height=1536 steps=28 cfg=6\.5 seed=-1/);
assert.ok(command.endsWith('"cinematic portrait"'));
assert.deepEqual(storyboardRatioDimensions('1:1', 1024, 1024), { width: 1024, height: 1024 });

const normalized = normalizeStoryboardState({ logs: [{
  id: 'queued-1', status: 'queued', source: 'openai', prompt: 'shot', queuedAt: 7,
  snapshot: { source: 'openai', prompt: 'shot', chatKey: 'chat-a', profile: { model: 'gpt-image-1' } },
}] });
assert.equal(normalized.logs[0].status, 'queued');
assert.equal(normalized.logs[0].snapshot.profile.model, 'gpt-image-1');
assert.equal(normalized.logs[0].snapshot.chatKey, 'chat-a');

assert.match(source, /case 'imagegen': return renderStoryboardTab\(\)/, '分镜必须进入千幕顶层路由');
assert.doesNotMatch(source, /storyboardExecuteSlash\(`\/imagine-source/, '浏览模型标签不得触发 ST 全局连接切换');
assert.match(source, /STORYBOARD_TRANSIENT_SD_KEYS[\s\S]*storyboardWithTransientProfile[\s\S]*finally/, '生成必须临时装配并恢复 ST 生图状态');
assert.match(source, /import\('\.\.\/\.\.\/\.\.\/secrets\.js'\)[\s\S]*writeSecret/, '密钥必须进入 SillyTavern 密钥库');
assert.match(source, /storyboardImages[\s\S]*messageHash[\s\S]*swipeId/, '正文挂载必须带楼层内容与 swipe 锚点');
assert.match(source, /text\.insertAdjacentElement\('afterend', wrapper\)/, '分镜必须作为 mes_text 兄弟节点插入，禁止污染正文文本');
assert.match(source, /function storyboardInlineRecordValid[\s\S]*record\.messageHash[\s\S]*record\.swipeId/, '编辑或 reroll 后必须阻止旧图误挂');
assert.match(css, /\.sd-storyboard-magazine[\s\S]*\.sd-storyboard-file-stack[\s\S]*\.sd-storyboard-profile-sheet/, '形象档案必须具备独立杂志纸页与叠档案布局');
assert.match(source, /CAST DIRECTORY/, '形象档案必须有总目录');
assert.match(source, /捕获当前角色[\s\S]*捕获我/, '形象档案必须同时捕获角色与 User');
assert.match(source, /storyboardProfileBindings[\s\S]*绑定到当前聊天/, '档案必须支持聊天绑定');
assert.match(source, /复制一套/, '同一人物必须支持多套方案');
assert.match(source, /function storyboardStartLog[\s\S]*function storyboardFinishLog[\s\S]*分镜日志/, '分镜必须记录成功、失败与诊断信息');
assert.match(source, /STORYBOARD_QUEUE_LIMIT[\s\S]*storyboardQueueJob[\s\S]*storyboardPumpQueue/, '分镜必须使用有上限的串行队列');
assert.match(source, /function storyboardRemoveQueuedLog/, '等待任务必须可单独移除');
assert.match(source, /移出等待/, '日志必须提供明确的移出等待操作');
assert.match(source, /storyboardDiscardActive[\s\S]*discardRequested[\s\S]*放弃本次/, '斩断未暴露的 ST 请求时必须明确为放弃收片');
assert.match(source, /storyboardLoadLogToWorkbench[\s\S]*storyboardRetryLog[\s\S]*载入镜头台/, '日志必须可载入与再生成');
assert.match(source, /storyboardCheckConnection[\s\S]*\/api\/sd\/comfy\/ping/, 'ComfyUI 必须走 ST 官方 ping 端点实测');
assert.match(source, /storyboardHandleChatChanged[\s\S]*切换聊天后已自动移除等待任务/, '队列不得把旧聊天的分镜写入新聊天');
assert.match(source, /将此瞬，妥为留存/, '镜头台主文案必须使用确认后的版本');
assert.doesNotMatch(source, /千幕组织镜头，SillyTavern 负责连接与生成/, '镜头台不应展示尴尬的实现说明');
assert.match(css, /#chat \.mes \.sd-storyboard-inline/, '正文分镜样式必须严格限定在聊天消息内');

console.log('Storyboard unit 1 contract OK');
