import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { normalizeStoryboardState } from '../qianmu-storyboard.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const style = await readFile(new URL('../style.css', import.meta.url), 'utf8');

const normalized = normalizeStoryboardState({
  source: 'novel',
  profiles: { novel: { model: 'nai-diffusion-4-5-full' } },
  connections: {
    novel: {
      activePresetId: 'channel-api',
      presets: [{
        id: 'channel-api',
        name: '主连接',
        model: 'nai-diffusion-5-full',
        baseUrl: 'https://image.novelai.net',
      }],
    },
  },
  routing: {
    enabled: true,
    single: {
      providerId: 'novel',
      modelId: 'nai-diffusion-4-5-full',
      connectionPresetId: 'channel-api',
    },
  },
});

assert.equal(normalized.connections.novel.activePresetId, 'channel-api');
assert.equal(normalized.routing.single.connectionPresetId, 'channel-api', 'channel API presets must survive a different selected model');
assert.match(source, /<span>生图渠道<\/span>/);
assert.match(source, /const channelPresets = connection\.group\?\.presets \|\| \[\]/);
assert.doesNotMatch(source, /const modelPresets = .*item\.model === profile\.model/);
assert.doesNotMatch(source, /sd-storyboard-route-model'[\s\S]{0,220}connectionPresetId = ''/, 'changing a model must keep the selected channel API preset');
assert.match(source, /promptInput\('保存 API 预设', '输入预设名称。'/);
assert.match(source, /placeholder="输入 API Key"/);
assert.doesNotMatch(source, /savedKey \? '已保存'/);
assert.match(source, /renderStoryboardCreate\(state\)[\s\S]*\$\{body\}\$\{renderStoryboardNav\(state\)\}/);
assert.match(style, /\.sd-storyboard-nav \{[\s\S]*bottom: 0;[\s\S]*margin-top: auto;/);
assert.match(style, /--sd-storyboard-gap: 4px/);
assert.match(style, /\.sd-storyboard-automation-head[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto/);
assert.match(style, /\.sd-storyboard-refresh-worldbooks[\s\S]*border-radius: 999px/);
assert.doesNotMatch(source.slice(source.indexOf('function renderStoryboardNav'), source.indexOf('function storyboardWorkflowIssue')), /fa-chevron-down/);

console.log('Storyboard v1.56.4 refinement contract OK');
