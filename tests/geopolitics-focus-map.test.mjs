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
assert.doesNotMatch(source, /sd-geo-axis-halo/);
assert.doesNotMatch(css, /\.sd-geo-axis-halo\s*\{/);
assert.match(css, /\.sd-geo-edge-base\s*\{[^}]*stroke-width:\s*1\.15;[^}]*filter:\s*none/);
assert.match(css, /\.sd-geo-focused \.sd-geo-edge\.sd-dim\s*\{[^}]*opacity:\s*0;[^}]*visibility:\s*hidden/);

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

// 活跃事件保留静态柔光，不再形成与实线不同步的游动脉冲。
assert.match(source, /renderFactionStarMap\(factions, rels, activeEvents\)/);
assert.match(source, /sd-geo-event-pulse-[^`]*stage/);
assert.doesNotMatch(css, /@keyframes sd-geo-event-travel/);
assert.match(css, /\.sd-geo-event-pulse \{ stroke-dasharray: none; \}/);
assert.match(css, /prefers-reduced-motion:[\s\S]*sd-geo-event-pulse/);

// 关系亮段沿原曲线流动；固定实线不再带模糊色晕，方向箭头与节点锚点保持原有职责。
assert.match(source, /class="sd-geo-edge-motion" d="\$\{d\}" pathLength="100"/);
assert.match(source, /const flowDelay = -\(geoStableHash\(key\) % 90\) \/ 10/);
assert.match(css, /\.sd-geo-edge-motion\s*\{[^}]*stroke-dasharray:\s*10 90;[^}]*animation:\s*sd-geo-edge-travel 9s linear infinite/);
assert.match(css, /@keyframes sd-geo-edge-travel \{ to \{ stroke-dashoffset: -100; \} \}/);
assert.match(css, /prefers-reduced-motion:[\s\S]*\.sd-geo-edge-motion \{ display: none; \}/);

// 糖果色只属于日间星图；状态标签使用独立深墨，夜间回退原有语义色。
assert.match(css, /#story-director-modal:not\(\.sd-theme-dark\):not\(\[data-qm-mode="dark"\]\) \.sd-geo-stage,\s*#story-director-modal\[data-qm-mode="light"\] \.sd-geo-stage \{[^}]*--sd-geo-conflict: #e15a84;[^}]*--sd-geo-ally-ink: #126d5e;/);
assert.match(css, /\.sd-geo-node-rising \.sd-geo-tag-text \{ fill: var\(--sd-geo-ally-ink, var\(--sd-geo-ally\)\); \}/);
assert.match(css, /\.sd-geo-d-trend-turbulent \{ color: var\(--sd-geo-conflict-ink, var\(--sd-geo-conflict\)\); \}/);

// 本单元只调整可视化，不得改写原有世界格局的生成、合并与注入入口。
for (const contract of ['mergeGeopolitics', 'buildGeopoliticsDigest', 'buildGeopoliticsArchiveSegment']) {
  assert.match(source, new RegExp(`function ${contract}`));
}

console.log('Geopolitics focus map contract OK');
