import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createStoryboardDefaults, normalizeStoryboardState } from '../qianmu-storyboard.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

const defaults = createStoryboardDefaults();
for (const key of ['castPickerOpen', 'selectedCharacters', 'consistencyModes']) {
  assert.equal(Object.hasOwn(defaults, key), false, `镜头台状态不得再声明旧出镜字段：${key}`);
}

const normalized = normalizeStoryboardState({
  entities: {
    char: [{ id: 'char:a', activeProfileId: 'look-a', profiles: [{ id: 'look-a', name: '默认档案' }] }],
    cast: [{ id: 'cast:b', activeProfileId: 'look-b', profiles: [{ id: 'look-b', name: '方案二' }] }],
    candidates: [{ id: 'candidate:old', name: '旧候选' }],
  },
  selectedCharacters: [
    { entityId: 'char:a', profileId: 'look-a' },
    { entityId: 'cast:b', profileId: 'look-b', origin: 'manual' },
  ],
});
assert.equal(Object.hasOwn(normalized, 'selectedCharacters'), false, '升级时必须直接清理未经实测的旧出镜选择');
assert.equal(Object.hasOwn(normalized.entities, 'candidates'), false, '正文自动识别出的群像候选不得残留');

for (const pattern of [
  /function storyboardSyncSelectionForChat/,
  /function renderStoryboardCastCard/,
  /storyboardProfileBindings/,
  /data-storyboard-cast-pick/,
  /selectedCharacters/,
  /cast_candidates/,
]) assert.doesNotMatch(source, pattern, `镜头台不得保留旧角色自动绑定链路：${pattern}`);
assert.match(source, /data-storyboard-capture="char"[\s\S]*data-storyboard-capture="user"[\s\S]*sd-storyboard-capture-cast/, '独立形象档案页仍须支持主动建档');
assert.match(source, /形貌纪要[\s\S]*当前正文状态冲突时，以目标楼层为准。[\s\S]*专用负面词/, '档案详情字段与冲突提示必须使用确认后的文案');
assert.match(source, /referenceSource === 'url'[\s\S]*sd-storyboard-character-reference-url[\s\S]*: ''/, 'URL 参考图输入框只能在选择 URL 时原位出现');
assert.match(css, /@media \(max-width: 640px\)[\s\S]*sd-storyboard-profile-sheet \{ grid-template-columns: minmax\(108px, \.42fr\) minmax\(0, \.58fr\)/, '移动端档案详情仍须保持左图右表单');
assert.match(css, /sd-storyboard-file > em[\s\S]*border-radius: 50%[\s\S]*background: #76b88a/, '当前方案必须使用右上角绿点');

console.log('Storyboard character archive contract OK');
