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
    styleLibrary: true,
    rules: [{ id: 'style-target', name: '画面风格', enabled: true, target: {
      providerId: 'novel',
      modelId: 'nai-diffusion-4-5-full',
      capabilityModelId: 'nai-diffusion-4-5-full',
      connectionPresetId: 'channel-api',
    } }],
  },
});

assert.equal(normalized.connections.novel.activePresetId, 'channel-api');
const styleTarget = normalized.routing.rules[0];
assert.equal(styleTarget.id, 'style-target');
assert.equal(styleTarget.enabled, true);
assert.equal(styleTarget.target.providerId, 'novel');
assert.equal(styleTarget.target.modelId, 'nai-diffusion-4-5-full');
assert.equal(styleTarget.target.capabilityModelId, 'nai-diffusion-4-5-full');
assert.equal(styleTarget.target.connectionPresetId, 'channel-api', 'channel API presets must survive a different selected model');
assert.equal(normalized.connections.novel.presets[0].model, 'nai-diffusion-5-full', 'the style model must not rewrite the connection preset model');
assert.equal(Object.hasOwn(normalized.routing, 'single'), false);
assert.match(source, /<span>生图渠道<\/span>/);
assert.match(source, /const channelPresets = connection\.group\?\.presets \|\| \[\]/);
assert.doesNotMatch(source, /const modelPresets = .*item\.model === profile\.model/);
assert.doesNotMatch(source, /sd-storyboard-route-model|data-storyboard-route-rule/, 'the retired route model controls must not return');
assert.match(source, /promptInput\('保存 API 预设', '输入预设名称。'/);
assert.match(source, /placeholder="输入 API Key"/);
assert.doesNotMatch(source, /savedKey \? '已保存'/);
assert.match(source, /function renderStoryboardTab[\s\S]*sd-storyboard-scroll[\s\S]*\$\{body\}<\/div>\$\{renderStoryboardNav\(state\)\}/);
assert.match(style, /\.sd-storyboard-root[\s\S]*grid-template-rows: 46px minmax\(0, 1fr\) auto/);
assert.match(style, /\.sd-storyboard-nav \{[\s\S]*bottom: auto;[\s\S]*background: var\(--sd-folder-head\)/);
assert.match(style, /--sd-storyboard-gap: 4px/);
assert.match(style, /\.sd-storyboard-automation-head[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto/);
assert.match(style, /\.sd-storyboard-refresh-worldbooks[\s\S]*border-radius: 999px/);
assert.doesNotMatch(source.slice(source.indexOf('function renderStoryboardNav'), source.indexOf('function storyboardWorkflowIssue')), /fa-chevron-down/);

console.log('Storyboard v1.56.4 refinement contract OK');
