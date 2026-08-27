import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createStoryboardDefaults, normalizeStoryboardState } from '../qianmu-storyboard.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

assert.equal(createStoryboardDefaults().castPickerOpen, false, '出镜选择器默认必须收起');

const normalized = normalizeStoryboardState({
  entities: {
    char: [{ id: 'char:a', activeProfileId: 'look-a', profiles: [{ id: 'look-a', name: '默认档案' }] }],
    cast: [{ id: 'cast:b', activeProfileId: 'look-b', profiles: [{ id: 'look-b', name: '方案二' }] }],
  },
  selectedCharacters: [
    { entityId: 'char:a', profileId: 'look-a' },
    { entityId: 'cast:b', profileId: 'look-b', origin: 'manual' },
  ],
});
assert.equal(normalized.selectedCharacters[0].origin, 'legacy', '升级前无法判定来源的出镜项必须标记为 legacy，供首次聊天同步清理');
assert.equal(normalized.selectedCharacters[1].origin, 'manual', '用户手动加入的群像必须跨聊天同步保留');

assert.match(source, /function storyboardSyncSelectionForChat[\s\S]*origin === 'manual'[\s\S]*\['char', 'user'\][\s\S]*origin: 'auto'/, '聊天同步必须只替换自动 CHAR\/USER，并保留手动群像');
assert.match(source, /function renderStoryboardCastCard[\s\S]*跟随当前聊天[\s\S]*手动出镜[\s\S]*data-storyboard-cast-pick/, '出镜卡必须明确区分自动跟随与手动添加');
assert.doesNotMatch(source, /data-storyboard-reference=/, '当前出镜卡不得继续暴露重复的参考图策略选择');
assert.match(source, /<option value="hybrid"[\s\S]*>自动判断<[\s\S]*<option value="archive"[\s\S]*>档案优先</, '形象依据只保留自动判断与档案优先');
assert.doesNotMatch(source, /sd-storyboard-binding-strip/, '档案目录不得保留重复的当前聊天绑定条');
assert.match(source, /形貌纪要[\s\S]*当前正文状态冲突时，以目标楼层为准。[\s\S]*专用负面词/, '档案详情字段与冲突提示必须使用确认后的文案');
assert.match(source, /referenceSource === 'url'[\s\S]*sd-storyboard-character-reference-url[\s\S]*: ''/, 'URL 参考图输入框只能在选择 URL 时原位出现');
assert.match(css, /@media \(max-width: 640px\)[\s\S]*sd-storyboard-profile-sheet \{ grid-template-columns: minmax\(108px, \.42fr\) minmax\(0, \.58fr\)/, '移动端档案详情仍须保持左图右表单');
assert.match(css, /sd-storyboard-file > em[\s\S]*border-radius: 50%[\s\S]*background: #76b88a/, '当前方案必须使用右上角绿点');

console.log('Storyboard character archive contract OK');
