import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const guide = await readFile(new URL('../INSTALL-SERVER-PLUGIN.md', import.meta.url), 'utf8');
const helper = await readFile(new URL('../update-server-plugin.sh', import.meta.url), 'utf8');
const updateSection = guide.split('## 已有安装更新（VPS + PM2，一次粘贴）\n')[1]?.split('\n## PM2 手动确认')[0];
const oneClick = updateSection?.match(/```bash\n([^\n]+)\n```/)?.[1];
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';

test('guide gives copy-paste commands with visible success markers', () => {
  assert.match(guide, /QIANMU_SERVER_STOPPED=1 curl -fsSL .*raw\.githubusercontent\.com\/Liminale-art\/qianmuwanxiang-V2-Directors-Cut\/.*install-server-plugin\.sh \| QIANMU_SERVER_STOPPED=1 sh/);
  assert.match(guide, /千幕服务端已安装\/更新，版本节点/);
  assert.match(guide, /更新完成：PM2=.*服务端提交/);
});

test('Baota update is one line, non-interactive, and runs in a child shell', () => {
  assert.ok(oneClick, 'guide must provide one copy-paste Bash line');
  assert.match(oneClick, /^bash -c 'set -o pipefail; curl -fsSL --retry 2 --connect-timeout 15 --max-time 120 https:\/\/raw\.githubusercontent\.com\/Liminale-art\/qianmuwanxiang-V2-Directors-Cut\/refactor\/storyboard-modularization\/update-server-plugin\.sh \| bash'$/);
  assert.doesNotMatch(oneClick, /<<|read\s+-r\s+-p|pm2\s+jlist|\bnode\b|健康检查地址/);
  assert.doesNotMatch(oneClick, /curl[^\n|]*\|\s*(QIANMU_SERVER_STOPPED=1\s+)?sh/);
  const syntax = spawnSync(bash, ['-n'], { input: `${oneClick}\n`, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.ifError(syntax.error);
  assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout);
});

test('downloaded update helper is visible, fixed to sillytavern, and shell-safe', () => {
  assert.match(helper, /^#!\/usr\/bin\/env bash/m);
  assert.match(helper, /PM2_NAME='sillytavern'/);
  assert.match(helper, /\[检查 SillyTavern 根目录\]|检查 SillyTavern 根目录/);
  for (const marker of ['同步服务端分支', '停止 PM2', '下载并执行插件更新器', '启动 PM2', '更新完成：PM2=']) {
    assert.match(helper, new RegExp(marker));
  }
  assert.doesNotMatch(helper, /pm2\s+jlist|\|\s*(QIANMU_SERVER_STOPPED=1\s+)?sh/);
  const syntax = spawnSync(bash, ['-n'], { input: helper, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.ifError(syntax.error);
  assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout);
});

test('guide keeps failure handling concise and actionable', () => {
  assert.match(guide, /当前目录不是 SillyTavern 根目录/);
  assert.match(guide, /找不到 pm2 \/ 无法识别进程/);
  assert.match(guide, /不要连续重跑/);
  assert.doesNotMatch(guide, /read -r -p/);
  assert.doesNotMatch(guide, /健康检查地址（留空则跳过/);
});
