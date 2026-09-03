import assert from 'node:assert/strict';

import {
  createStoryboardDefaults,
  normalizeStoryboardArtistPool,
  normalizeStoryboardState,
  resolveStoryboardArtistAssignment,
  STORYBOARD_SCHEMA_VERSION,
} from '../qianmu-storyboard.js';

const artists = [
  { id: 'portrait', name: '人物', value: 'artist:portrait' },
  { id: 'landscape', name: '风景', value: 'artist:landscape' },
  { id: 'concept', name: '概念', value: 'artist:concept' },
];
const pool = normalizeStoryboardArtistPool({
  id: 'cinema', name: '电影分工', mode: 'shuffle_bag',
  members: artists.map((artist) => ({ artistId: artist.id, weight: 1 })),
  roleAssignments: { establishing: 'landscape', insert: 'concept' },
}, new Set(artists.map((item) => item.id)));

assert.equal(pool.members.length, 3);
assert.equal(resolveStoryboardArtistAssignment({ artistPresets: artists, artistPools: [pool], selectedArtistPoolId: 'cinema', shot: { artistPresetId: 'portrait', shotRole: 'establishing' } }).artistId, 'portrait', '镜头手动指定优先级最高');
assert.equal(resolveStoryboardArtistAssignment({ artistPresets: artists, artistPools: [pool], selectedArtistPoolId: 'cinema', shot: { shotRole: 'establishing' } }).artistId, 'landscape', '镜头职责绑定优先于随机池');

const first = resolveStoryboardArtistAssignment({ artistPresets: artists, artistPools: [pool], selectedArtistPoolId: 'cinema', shot: { shotRole: 'custom' }, seed: 'floor-12-shot-1' });
const second = resolveStoryboardArtistAssignment({ artistPresets: artists, artistPools: [pool], selectedArtistPoolId: 'cinema', shot: { shotRole: 'custom' }, seed: 'floor-12-shot-2', recentArtistIds: [first.artistId] });
assert.notEqual(first.artistId, second.artistId, 'shuffle bag 在仍有候选项时不得连续重复');
const rerolled = resolveStoryboardArtistAssignment({
  artistPresets: artists,
  artistPools: [pool],
  selectedArtistPoolId: 'cinema',
  shot: { artistPresetId: first.artistId, shotRole: 'custom' },
  seed: 'floor-12-shot-1:reroll:1',
  excludedArtistIds: [first.artistId],
  reroll: true,
});
assert.notEqual(rerolled.artistId, first.artistId, '用户明确换画师时必须在方案仍有候选的情况下排除当前画师');
assert.equal(rerolled.source, 'pool_reroll');
const roleRerolled = resolveStoryboardArtistAssignment({
  artistPresets: artists,
  artistPools: [pool],
  selectedArtistPoolId: 'cinema',
  shot: { artistPresetId: 'landscape', shotRole: 'establishing' },
  seed: 'establishing:reroll:1',
  excludedArtistIds: ['landscape'],
  reroll: true,
});
assert.notEqual(roleRerolled.artistId, 'landscape', '显式重抽时若职责内只有当前画师，应放宽到同方案其他成员而不是伪装已换');
assert.equal(roleRerolled.source, 'pool_reroll');
assert.deepEqual(
  resolveStoryboardArtistAssignment({ artistPresets: artists, artistPools: [pool], selectedArtistPoolId: 'cinema', shot: { shotRole: 'custom' }, seed: 'stable' }),
  resolveStoryboardArtistAssignment({ artistPresets: artists, artistPools: [pool], selectedArtistPoolId: 'cinema', shot: { shotRole: 'custom' }, seed: 'stable' }),
  '同一任务种子必须得到稳定画师，确保重试不漂移',
);

const state = normalizeStoryboardState({ ...createStoryboardDefaults(), artistPresets: artists, artistPools: [pool], selectedArtistPoolId: 'cinema' });
assert.equal(state.schemaVersion, STORYBOARD_SCHEMA_VERSION);
assert.equal(state.selectedArtistPoolId, 'cinema');
state.artistPresets = state.artistPresets.filter((item) => item.id !== 'concept');
normalizeStoryboardState(state);
assert.equal(state.artistPools[0].members.some((item) => item.artistId === 'concept'), false, '删除画师后方案不得保留悬空引用');

console.log('Storyboard artist routing contract OK');
