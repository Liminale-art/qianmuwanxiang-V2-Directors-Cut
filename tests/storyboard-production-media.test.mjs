import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  STORYBOARD_PRODUCTION_TRACK_LABELS,
  adaptProductionPacketToStoryboardShotSpec,
  compileStoryboardPrompt,
  storyboardProductionContext,
  storyboardProductionDeliveryPolicy,
} from '../qianmu-storyboard.js';

const packet = {
  schema: 'qianmu.production.packet.v1',
  packetId: 'packet-world-1',
  eventId: 'world-1',
  track: 'second_camera',
  canonLevel: 'director',
  visualIntent: {
    duty: 'atmosphere',
    shotPattern: 'atmosphere',
    subject: '雨中的后巷',
    description: '后巷的雨水漫过台阶，一封未寄出的信贴在排水口。',
  },
  sceneState: { location: '餐厅后巷', time: '夜晚', weather: '暴雨' },
};

const shot = adaptProductionPacketToStoryboardShotSpec(packet);
const context = storyboardProductionContext(shot);
assert.equal(context.packetId, packet.packetId);
assert.equal(context.track, 'second_camera');
assert.equal(context.autoInsert, false);

const policy = storyboardProductionDeliveryPolicy(shot, { target: 'latest', inlineByDefault: true });
assert.equal(policy.sourceLabel, STORYBOARD_PRODUCTION_TRACK_LABELS.second_camera);
assert.equal(policy.target, 'gallery', '制片包在没有明确动作前只能进入媒体仓');
assert.equal(policy.inlineByDefault, false);
assert.equal(policy.requiresExplicitInsert, true);

const ordinary = storyboardProductionDeliveryPolicy({}, { target: 'latest', inlineByDefault: true });
assert.equal(ordinary.target, 'latest');
assert.equal(ordinary.inlineByDefault, true);
assert.equal(ordinary.sourceLabel, '本段正文');
assert.equal(ordinary.requiresExplicitInsert, false);

const compiled = compileStoryboardPrompt({ providerId: 'openai', modelId: 'custom-image-model', shot });
assert.match(compiled.prompt, /后巷的雨水漫过台阶/, '导演素材的画面描述不得在适配时丢失');

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
assert.match(source, /function renderStoryboardProductionSources[\s\S]*data-storyboard-production-packet/, '镜头台应提供导演素材入口');
assert.match(source, /const deliveryPolicy = storyboardProductionDeliveryPolicy\(shot[\s\S]*target: deliveryPolicy\.target[\s\S]*inlineByDefault: deliveryPolicy\.inlineByDefault/, '任务快照必须执行导演轨投递策略');
assert.match(source, /sd-storyboard-gallery-track[\s\S]*世界背面/, '阅片室必须能按主镜头与世界背面筛选');
assert.match(source, /storyboardAttachProductionRecord[\s\S]*不会把幕后信息写入正文或角色记忆/, '正文引用必须是用户明确动作且说明知识边界');
assert.match(css, /\.sd-storyboard-production-label\.second-camera/, '世界背面需要稳定可辨的来源标识');

console.log('Storyboard director-track media contract OK');
