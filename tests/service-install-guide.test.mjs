import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const guide = await readFile(new URL('../INSTALL-SERVER-PLUGIN.md', import.meta.url), 'utf8');
const updateSection = guide.split('## 已有安装更新（VPS + PM2，一次粘贴）\n')[1]?.split('\n## PM2 手动确认')[0];
const oneClick = updateSection?.match(/```bash\n([\s\S]*?)\n```/)?.[1];
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';

test('guide gives one short copy-paste install command and a visible success marker', () => {
  assert.match(guide, /QIANMU_SERVER_STOPPED=1 curl -fsSL .*install-server-plugin\.sh \| QIANMU_SERVER_STOPPED=1 sh/);
  assert.match(guide, /千幕服务端已安装\/更新，版本节点/);
  assert.match(guide, /更新完成：PM2=.*服务端提交/);
});

test('Baota update block is non-interactive and assumes the current ST root', () => {
  assert.ok(oneClick, 'guide must provide one copy-paste Bash block');
  for (const marker of [
    "bash -s <<'QIANMU_UPDATE'",
    'ST_ROOT=$(pwd -P)',
    "PM2_NAME='sillytavern'",
    'QIANMU_SERVER_STOPPED=1',
    'pm2 stop "$PM2_NAME"',
    'pm2 start "$PM2_NAME"',
    'pm2 describe "$PM2_NAME"',
    '更新完成：PM2=',
  ]) assert.ok(oneClick.includes(marker), `missing one-click marker: ${marker}`);
  assert.doesNotMatch(oneClick, /read\s+-r\s+-p|健康检查地址|SillyTavern 根目录绝对路径/);
  assert.doesNotMatch(oneClick, /pm2\s+jlist|\bnode\b|\|\s*(QIANMU_SERVER_STOPPED=1\s+)?sh\b/);
  assert.match(oneClick, /\nQIANMU_UPDATE$/);
  assert.ok(oneClick.indexOf('pm2 stop "$PM2_NAME"') < oneClick.indexOf('install-server-plugin.sh'));
  assert.ok(oneClick.indexOf('install-server-plugin.sh') < oneClick.indexOf('pm2 start "$PM2_NAME"'));
  const syntax = spawnSync(bash, ['-n'], { input: `${oneClick}\n`, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.ifError(syntax.error);
  assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout);
});

test('guide explains only the few actionable failure cases', () => {
  assert.match(guide, /当前目录不是 SillyTavern 根目录/);
  assert.match(guide, /找不到 pm2 \/ 无法识别进程/);
  assert.match(guide, /不要连续重跑/);
  assert.doesNotMatch(guide, /read -r -p/);
  assert.doesNotMatch(guide, /健康检查地址（留空则跳过/);
});
