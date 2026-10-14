import { readFile } from 'node:fs/promises';
import { storyboardFunctionSource } from './storyboard-form-fixture.mjs';

export const presetPickerSource = [
  'badge', 'getContextItemId', 'renderPresetSourcePanel', 'renderTheaterPresetPicker',
  'bindTheaterPresetPicker', 'initTheaterPresetSelection', 'renderCompanionSetupBody',
  'coreadEnsurePresetEntries', 'coreadToggleCompanionPreset', 'isCompanionPresetItemSelected',
  'setCompanionPresetItemSelected', 'coreadSetupScanPresets',
].map(storyboardFunctionSource).join('\n');

// Use the production delegated companion handlers, without mounting the entire reader.
const index = await readFile(new URL('../../index.js', import.meta.url), 'utf8');
const handlersStart = index.indexOf("  setupOverlay?.addEventListener('change', async (e) => {", index.indexOf('// 勾选委托：世界书'));
const handlersEnd = index.indexOf('  // ── 划线工具浮窗', handlersStart);
export const companionPresetHandlers = index.slice(handlersStart, handlersEnd);

export function installPresetPickerFixture(target) {
  const current = '【照见】Claude-Versatile-5.1.3 5.5';
  const older = '【照见】Claude-Versatile-4.8（试吃1）';
  const other = '【灰烬之桥】Claude-v5.7';
  const names = [current, older, other, '【灰烬之桥】Claude-v5.4（NSFW）', '单篇独立预设'];
  const cp = { presets: [current], presetItems: {}, chatCtxEnabled: true, chatCtxFloors: 5 };
  const theater = { presetName: current, presetItems: {} };
  const calls = { saves: 0, renders: 0, reads: 0, scans: 0 };
  const entries = name => [{ identifier: name + ':entry', name: '保留的条目', content: '测试内容', enabled: true }];
  Object.assign(target, {
    current, older, other, fixtureNames: names, cp, theater, calls,
    contextScanCache: { currentPresetName: current, presetNames: names, presets: {}, worldBooks: {}, worldBookNames: [], boundWorldBookNames: [] },
    settings: {}, companionPresetView: '', companionWorldView: '', cleanContextText: value => value,
    getCurrentPresetName: () => current, listPresetNames: () => names,
    getSelectedPresetNames: () => [current], renderSelectedPresetEntries: () => '',
    getPresetEntries: name => { calls.reads++; return entries(name); },
    getTheater: () => theater, saveSettings: () => { calls.saves++; }, renderModal: () => { calls.renders++; },
    coreadCompanion: () => cp, coreadMemory: () => ({}), coreadChatCompanionWb: () => ({ worldBooks: [] }),
    companionCharName: () => '书友', coreadUserName: () => '读者', coreadIdentityAvatar: () => '',
    detectBoundWorldBookNames: () => [], coreadGuideTargetClass: () => '', renderCoreadIdentity: () => '',
    renderMemSwitch: () => '', renderCoreadSpoilerGuard: () => '', renderCoreadPackBar: () => '',
    coread: () => ({ voiceCacheLimit: 100 }), applyQianmuIcons: () => {},
    refreshPresets: async () => {
      calls.scans++; target.contextScanCache.presetNames = [...target.fixtureNames]; target.contextScanCache.presets = {};
    },
  });
}
