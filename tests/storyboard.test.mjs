import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  STORYBOARD_SOURCES,
  buildImagineCommand,
  createStoryboardDefaults,
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

const command = buildImagineCommand({ prompt: 'cinematic portrait', negative: 'watermark', width: 1024, height: 1536, steps: 28, cfg: 6.5, seed: -1 });
assert.match(command, /^\/imagine quiet=true gallery=false /);
assert.match(command, /negative="watermark"/);
assert.match(command, /width=1024 height=1536 steps=28 cfg=6\.5 seed=-1/);
assert.ok(command.endsWith('"cinematic portrait"'));
assert.deepEqual(storyboardRatioDimensions('1:1', 1024, 1024), { width: 1024, height: 1024 });

assert.match(source, /case 'imagegen': return renderStoryboardTab\(\)/, '分镜必须进入千幕顶层路由');
assert.match(source, /executeSlashCommandsWithOptions[\s\S]*\/imagine-source[\s\S]*buildImagineCommand/, '连接切换与生成必须走 ST 官方命令层');
assert.match(source, /import\('\.\.\/\.\.\/\.\.\/secrets\.js'\)[\s\S]*writeSecret/, '密钥必须进入 SillyTavern 密钥库');
assert.match(source, /storyboardImages[\s\S]*messageHash[\s\S]*swipeId/, '正文挂载必须带楼层内容与 swipe 锚点');
assert.match(source, /text\.insertAdjacentElement\('afterend', wrapper\)/, '分镜必须作为 mes_text 兄弟节点插入，禁止污染正文文本');
assert.match(source, /function storyboardInlineRecordValid[\s\S]*record\.messageHash[\s\S]*record\.swipeId/, '编辑或 reroll 后必须阻止旧图误挂');
assert.match(css, /\.sd-storyboard-magazine[\s\S]*\.sd-storyboard-file-stack[\s\S]*\.sd-storyboard-profile-sheet/, '形象档案必须具备独立杂志纸页与叠档案布局');
assert.match(css, /#chat \.mes \.sd-storyboard-inline/, '正文分镜样式必须严格限定在聊天消息内');

console.log('Storyboard unit 1 contract OK');
