import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const guide = await readFile(new URL('../INSTALL-SERVER-PLUGIN.md', import.meta.url), 'utf8');
const pm2 = guide.split('### PM2 部署\n')[1]?.split('\n## ')[0];
const blocks = [...(pm2 || '').matchAll(/```bash\n([\s\S]*?)\n```/g)].map(match => match[1]);
const maintenance = blocks.find(block => /pm2 stop sillytavern/.test(block));
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';

test('PM2 guide separates read-only checks, stopped maintenance, verified startup and final version check', () => {
  assert.ok(maintenance, 'the documented update must stop the verified PM2 process');
  assert.match(maintenance, /^\(\n\s+set -eu\n/);
  assert.ok(maintenance.indexOf('pm2 stop') < maintenance.indexOf('fetch origin'));
  assert.ok(maintenance.indexOf('pm2 stop') < maintenance.indexOf('switch refactor/'));
  assert.doesNotMatch(maintenance, /pm2 (?:start|restart)\b/);
  const startIndex = blocks.findIndex(block => /pm2 start sillytavern/.test(block));
  assert.ok(startIndex > blocks.indexOf(maintenance));
  assert.ok(blocks.slice(startIndex + 1).some(block => /rev-parse HEAD/.test(block) && /qianmu-tts\/health/.test(block)));
  assert.match(pm2, /更新或检查失败时保持 ST 停止，不执行启动命令/);
  assert.match(pm2, /备份并验证 ST 配置、数据和插件副本可读/);
  assert.match(pm2, /实际 Node 解释器/);
  assert.match(pm2, /终端中的 `node -v` 不一定是 PM2 使用的版本/);
});

test('installation guide warns about global plugin activation and startup auto-update without silently changing it', () => {
  assert.match(guide, /enableServerPlugins` 是 ST 的全局插件开关/);
  assert.match(guide, /备份应放在扫描目录以外/);
  assert.match(guide, /enableServerPluginsAutoUpdate/);
  assert.match(guide, /不要为了固定千幕而未经确认改动影响所有插件的全局自动更新开关/);
  assert.match(guide, /保持 ST 停止，按下节核对并切换服务端分支后再启动/);
});

const expected = [
  'cd /usr/local/games/SillyTavern',
  'pm2 stop sillytavern',
  'git -C plugins/Omniscene fetch origin refactor/storyboard-modularization',
  'git -C plugins/Omniscene switch refactor/storyboard-modularization',
  'git -C plugins/Omniscene pull --ff-only origin refactor/storyboard-modularization',
  'git -C plugins/Omniscene rev-parse HEAD',
];
// Execute only the extracted documentation block with in-memory command stubs.
// No real cd, Git, PM2, installation, network or filesystem writes are performed.
for (const failAt of ['', ...expected]) {
  test(`PM2 maintenance example ${failAt ? `stops immediately after ${failAt}` : 'finishes checks but never starts ST'}`, () => {
    assert.ok(maintenance);
    const script = `
guide_command() { printf '%s\\n' "$*"; [ "$*" != "$QIANMU_GUIDE_FAIL_AT" ]; }
cd() { guide_command cd "$@"; }
git() { guide_command git "$@"; }
pm2() { guide_command pm2 "$@"; }
${maintenance}
`;
    const result = spawnSync(bash, ['-c', script], { encoding: 'utf8', windowsHide: true, timeout: 10000,
      env: { ...process.env, BASH_ENV: '', ENV: '', QIANMU_GUIDE_FAIL_AT: failAt } });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, failAt ? 1 : 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split(/\r?\n/), failAt ? expected.slice(0, expected.indexOf(failAt) + 1) : expected);
  });
}
