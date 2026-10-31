import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const guide = await readFile(new URL('../INSTALL-SERVER-PLUGIN.md', import.meta.url), 'utf8');
const helper = await readFile(new URL('../update-server-plugin.sh', import.meta.url), 'utf8');
const updateSection = guide.split('## 已有安装更新（当前 ST 根目录，一次粘贴）\n')[1]?.split('\n## 忆幕随千幕统一更新')[0];
const oneClick = updateSection?.match(/```bash\n([^\n]+)\n```/)?.[1];
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';

test('guide gives copy-paste commands with concise success markers', () => {
  assert.match(guide, /QIANMU_SERVER_STOPPED=1 curl -fsSL .*raw\.githubusercontent\.com\/Liminale-art\/qianmuwanxiang-V2-Directors-Cut\/.*install-server-plugin\.sh \| QIANMU_SERVER_STOPPED=1 sh/);
  assert.match(guide, /千幕服务端已更新至 vX/);
  assert.match(guide, /忆幕随千幕统一更新/);
  assert.doesNotMatch(guide, /1\.59\.482|QIANMU_HEALTH_URL|配置备份：|健康检查：/);
});

test('Baota update is one line, non-interactive, and runs in a child shell', () => {
  assert.ok(oneClick, 'guide must provide one copy-paste Bash line');
  assert.match(oneClick, /^bash -c 'set -o pipefail; /);
  assert.ok(oneClick.includes('printf "\\n[千幕更新] 下载更新脚本...\\n";'));
  assert.match(oneClick, /curl -fL --retry 2 --connect-timeout 15 --max-time 120 https:\/\/raw\.githubusercontent\.com\/Liminale-art\/qianmuwanxiang-V2-Directors-Cut\/refactor\/storyboard-modularization\/update-server-plugin\.sh \| bash'$/);
  assert.doesNotMatch(oneClick, /<<|read\s+-r\s+-p|pm2\s+jlist|\bnode\b/);
  assert.doesNotMatch(oneClick, /curl[^\n|]*\|\s*(QIANMU_SERVER_STOPPED=1\s+)?sh/);
  const syntax = spawnSync(bash, ['-n'], { input: `${oneClick}\n`, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.ifError(syntax.error);
  assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout);
});

test('downloaded update helper is visible, restart-safe, and shell-safe', () => {
  assert.match(helper, /^#!\/usr\/bin\/env bash/m);
  assert.match(helper, /PM2_NAME="\$\{QIANMU_PM2_NAME:-sillytavern\}"/);
  assert.match(helper, /\[检查 SillyTavern 根目录\]|检查 SillyTavern 根目录/);
  for (const marker of ['同步服务端分支', '停止 PM2', '下载并执行插件更新器', '启动 PM2', '服务端版本校验', '千幕服务端已更新至']) {
    assert.match(helper, new RegExp(marker));
  }
  assert.match(helper, /QIANMU_PM2_NAME/);
  assert.match(helper, /本次更新未完成，已重新启动/);
  assert.match(helper, /本次未自动启动/);
  assert.doesNotMatch(helper, /EXPECTED_VERSION|QIANMU_HEALTH_URL|健康检查|配置备份/);
  assert.doesNotMatch(helper, /pm2\s+jlist|\|\s*(QIANMU_SERVER_STOPPED=1\s+)?sh/);
  const syntax = spawnSync(bash, ['-n'], { input: helper, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.ifError(syntax.error);
  assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout);
});

test('guide keeps failure handling concise and actionable', () => {
  assert.match(guide, /当前目录不是 SillyTavern 根目录/);
  assert.match(guide, /找不到 pm2 \/ 无法识别进程/);
  assert.match(guide, /本次未自动启动 sillytavern/);
  assert.doesNotMatch(guide, /read -r -p/);
  assert.doesNotMatch(guide, /QIANMU_HEALTH_URL/);
});
