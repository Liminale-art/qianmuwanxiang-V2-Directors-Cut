import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

// 星图必须确定性聚簇、避让标签，并只在总览保留有限关键关系。
assert.match(source, /function geoStableHash[\s\S]*function geoFactionClusters[\s\S]*同盟.*依附/);
assert.match(source, /function geoClusteredNodeLayout[\s\S]*相同数据始终落在相同位置/);
assert.match(source, /function geoLabelLayout[\s\S]*candidates[\s\S]*overlap/);
assert.match(source, /function geoPrimaryRelationKeys[\s\S]*Math\.min\(8/);
assert.match(source, /sd-geo-edge-primary.*sd-geo-edge-secondary/);
assert.match(css, /\.sd-geo-edge-secondary\s*\{[^}]*opacity:\s*0/);

// 点选势力后展开一、二级牵连；线索轨道仅属于当前聚焦势力。
assert.match(source, /const direct = new Set\(\)[\s\S]*const second = new Set\(\)/);
assert.match(source, /classList\.toggle\('sd-near'[\s\S]*classList\.toggle\('sd-far'/);
assert.match(css, /\.sd-geo-focused \.sd-geo-node\.sd-on \.sd-geo-clues\s*\{[^}]*opacity:\s*1/);
assert.match(css, /\.sd-geo-clues\s*\{[^}]*opacity:\s*0/);

// 关系类型是可持久化的图层筛选；星图/列表视图也共享同一份状态。
assert.match(source, /geopoliticsView:\s*'map'/);
assert.match(source, /geopoliticsRelationKinds:\s*\[\.\.\.FACTION_RELATION_KINDS\]/);
assert.match(source, /sd-geo-filter[\s\S]*aria-pressed/);
assert.match(source, /settings\.geopoliticsRelationKinds = FACTION_RELATION_KINDS\.filter/);
assert.match(source, /settings\.geopoliticsView = view[\s\S]*saveSettings\(\)/);
assert.match(source, /function renderFactionListView[\s\S]*sd-geo-list-card[\s\S]*sd-geo-list-rel/);

// 活跃事件通过脉冲进入星图；减弱动态偏好必须关闭这些动画。
assert.match(source, /renderFactionStarMap\(factions, rels, activeEvents\)/);
assert.match(source, /sd-geo-event-pulse-[^`]*stage/);
assert.match(css, /@keyframes sd-geo-event-travel/);
assert.match(css, /prefers-reduced-motion:[\s\S]*sd-geo-event-pulse/);

// 本单元只调整可视化，不得改写原有世界格局的生成、合并与注入入口。
for (const contract of ['mergeGeopolitics', 'buildGeopoliticsDigest', 'buildGeopoliticsArchiveSegment']) {
  assert.match(source, new RegExp(`function ${contract}`));
}

console.log('Geopolitics focus map contract OK');
