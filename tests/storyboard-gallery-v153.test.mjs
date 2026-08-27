import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const source = await readFile(new URL('index.js', root), 'utf8');
const css = await readFile(new URL('style.css', root), 'utf8');
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));

assert.equal(manifest.version, '1.55.0');
assert.match(source, /function storyboardGalleryCollections\(\)[\s\S]*storyboardCollections/, '合集必须跟随聊天元数据保存');
assert.match(source, /function storyboardGalleryGroupId[\s\S]*variantRootId[\s\S]*planShotId[\s\S]*groupId/, '新旧图片必须都有稳定的同源分组兜底');
assert.match(source, /function storyboardCreateRecord[\s\S]*variantRootId: job\.variantRootId \|\| job\.planShotId \|\| job\.id/, '新图片必须记录同源版本根');
assert.match(source, /function storyboardRedrawRecord[\s\S]*job\.variantRootId = storyboardGalleryGroupId\(record\)/, '正文重绘必须追加为同源版本而非覆盖');
assert.match(source, /renderStoryboardGallery[\s\S]*阅片室[\s\S]*sd-storyboard-gallery-folder[\s\S]*sd-storyboard-stack-count/, '阅片室必须呈现合集与叠片数量');
assert.match(source, /新建阅片合集[\s\S]*重命名阅片合集[\s\S]*解散阅片合集/, '合集必须支持完整生命周期');
assert.match(source, /sd-storyboard-gallery-move-selected[\s\S]*collectionId = collectionId/, '多选图片必须可归入或移出合集');
assert.match(source, /chat: \{ bindings:[\s\S]*collections: clone\(storyboardGalleryCollections\(\)\)/, '分镜数据打包必须包含合集');
assert.match(source, /store\.storyboardCollections = storyboardMergeById/, '跨端导入必须恢复合集');

for (const label of ['来源楼层', '正面提示词', '负面提示词', '画师串', '实际最终提示词', '模型与参数', '种子', '人物档案']) {
  assert.match(source, new RegExp(`<dt>${label}<\\/dt>`), `图片详情缺少字段：${label}`);
}
assert.doesNotMatch(source, /sd-storyboard-reuse-record|sd-storyboard-lightbox-reuse/, '阅片室不得提供复用或重新生成');
assert.match(source, /data-storyboard-chat-action="redraw"/, '重新生成必须只保留在正文快捷操作');
assert.match(source, /sd-storyboard-lightbox-delete[\s\S]*store\.storyboardImages = storyboardGalleryRecords\(\)\.filter/, '叠片详情必须可逐张删除');
assert.match(css, /\.sd-storyboard-gallery \{ columns: 3 180px/, '阅片室必须使用自适应瀑布流');
assert.match(css, /\.sd-storyboard-folder-covers[\s\S]*grid-template-columns: repeat\(2, 1fr\)/, '合集封面必须由四格缩略图组成');
assert.match(css, /\.sd-storyboard-gallery-card\.is-stack::before[\s\S]*\.sd-storyboard-gallery-card\.is-stack::after/, '同源版本必须呈现叠片层次');
assert.match(css, /\.sd-storyboard-lightbox-detail[\s\S]*overflow: auto/, '移动端详情必须可独立滚动');

console.log('Storyboard gallery v1.53.0 contract OK');
