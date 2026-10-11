# 千幕服务端插件：安装与更新

> 本文只保留普通用户真正需要的操作：复制命令、执行命令、看最后一行结果。
> 开发测试基准是 **VPS + PM2**。前端与服务端联调前，请先核对两边是否为同一配套版本；本次前端交付需要开发者提醒并核对后端 `v1.59.448`（或与该提交对应的服务端节点）。这个提醒属于开发交接，不会显示成插件运行时提示。
> 本次前端推送使用 `refactor/storyboard-modularization`，所以文中的服务端命令也使用同名分支；正式稳定版发布后，统一改用 `main`。

## 使用前先确认

1. 等正在生成的任务结束。
2. 在宝塔的 **Linux/Bash 终端**中操作，不要在 ST 网页输入。
3. 当前目录已经是 SillyTavern 根目录；能看到 `config.yaml`，或 Docker 部署能看到 `config/config.yaml` 和 Compose 文件。
4. 现有安装更新前，先确认备份可读。命令失败就停下来，不要连续重复执行。

## 首次安装（Linux / VPS / macOS）

在已停止 ST 后端、且当前目录是 ST 根目录时，整行复制并执行：

```bash
QIANMU_SERVER_STOPPED=1 curl -fsSL https://raw.githubusercontent.com/Liminale-art/qianmuwanxiang-V2-Directors-Cut/refactor/storyboard-modularization/install-server-plugin.sh | QIANMU_SERVER_STOPPED=1 sh
```

首次安装完成时，终端会显示：

```text
千幕服务端已安装/更新，版本节点：...
```

随后按你原来的方式启动 ST 后端。只刷新网页不算完成。

## 已有安装更新（VPS + PM2，一次粘贴）

这段命令默认在 **SillyTavern 根目录**执行。开发测试环境的 PM2 进程名固定为 `sillytavern`，脚本不会扫描或猜测进程，也不会询问目录、进程名或健康地址。整段命令会在一个独立的 Bash 子进程中运行；更新失败只会结束这次更新，宝塔终端仍保持打开，不需要中途反复回车。它会依次完成：检查 → 停止 PM2 → 更新开发分支 → 安装插件 → 启动 PM2 → 检查在线状态。

```bash
bash -s <<'QIANMU_UPDATE'
set -Eeuo pipefail
ST_ROOT=$(pwd -P)
PLUGIN="$ST_ROOT/plugins/Omniscene"
BRANCH='refactor/storyboard-modularization'
REPO='https://github.com/Liminale-art/qianmuwanxiang-V2-Directors-Cut.git'
PM2_NAME='sillytavern'
INSTALLER=''
fail() { printf '\n更新失败：%s\n请保留上面的终端输出，不要连续重复执行。\n' "$*" >&2; exit 1; }
finish() {
  code=$?
  [ -z "$INSTALLER" ] || rm -f -- "$INSTALLER" || true
  [ "$code" -eq 0 ] || printf '服务可能仍保持停止，请先查看上面的失败原因。\n' >&2
  return "$code"
}
trap finish EXIT

[ -f "$ST_ROOT/config.yaml" ] || [ -f "$ST_ROOT/config/config.yaml" ] || fail '当前目录不是 SillyTavern 根目录。'
command -v pm2 >/dev/null 2>&1 || fail '找不到 pm2，请在宝塔终端加载运行 ST 的 Node/PM2 环境。'
[ -d "$PLUGIN/.git" ] && [ ! -L "$PLUGIN/.git" ] || fail '没有找到现有 Git 插件；首次安装请执行上面的安装命令。'
pm2 describe "$PM2_NAME" >/dev/null 2>&1 || fail '找不到 PM2 进程 sillytavern，请先在宝塔确认进程名称。'

remote=$(git -C "$PLUGIN" remote get-url origin) || fail '无法读取插件远端地址。'
[ "${remote%/}" = "$REPO" ] || [ "${remote%/}" = 'git@github.com:Liminale-art/qianmuwanxiang-V2-Directors-Cut.git' ] || fail "插件远端不是官方仓库：$remote"
[ -z "$(git -C "$PLUGIN" status --short)" ] || fail '插件有未提交的本地改动，请先备份并核对。'

git -C "$PLUGIN" fetch origin "$BRANCH" || fail '获取服务端分支失败。'
if git -C "$PLUGIN" show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git -C "$PLUGIN" switch "$BRANCH" || fail '切换服务端分支失败。'
else
  git -C "$PLUGIN" switch --track -c "$BRANCH" "origin/$BRANCH" || fail '创建服务端分支失败。'
fi
[ "$(git -C "$PLUGIN" rev-parse --abbrev-ref "$BRANCH@{upstream}" 2>/dev/null || true)" = "origin/$BRANCH" ] || git -C "$PLUGIN" branch --set-upstream-to="origin/$BRANCH" "$BRANCH" || fail '设置服务端分支失败。'
[ -z "$(git -C "$PLUGIN" status --short)" ] || fail '切换分支后出现本地改动，已停止。'

pm2 stop "$PM2_NAME" || fail 'PM2 停止失败。'
INSTALLER=$(mktemp)
curl -fsSL "https://raw.githubusercontent.com/Liminale-art/qianmuwanxiang-V2-Directors-Cut/$BRANCH/install-server-plugin.sh" -o "$INSTALLER" || fail '下载安装脚本失败。'
QIANMU_SERVER_STOPPED=1 sh "$INSTALLER" || fail '插件更新失败。'
COMMIT=$(git -C "$PLUGIN" rev-parse HEAD) || fail '无法读取更新后的提交节点。'
pm2 start "$PM2_NAME" || fail '插件已更新，但 PM2 启动失败。'
sleep 2
pm2 describe "$PM2_NAME" | grep -Eq 'status[[:space:]]+online|online' || fail 'PM2 没有回到 online 状态。'

printf '\n更新完成：PM2=%s，服务端提交=%s\n' "$PM2_NAME" "$COMMIT"
printf '现在刷新 ST 页面；如需核对接口，再访问 /api/plugins/qianmu-tts/health。\n'
QIANMU_UPDATE
```

最后看到 `更新完成：PM2=...，服务端提交=...`，才算更新成功。脚本在停止后任一步失败都会停在现场，不会把失败伪报成成功。

本开发环境已经固定使用 `sillytavern`。如果你的部署实际使用了别的 PM2 名称，只改脚本最前面的 `PM2_NAME='sillytavern'` 一处即可。

## PM2 手动确认（只在一键命令提示时使用）

```bash
pm2 status
pm2 describe 你的ST进程名
```

确认进程工作目录就是当前目录后，再重新执行上面的“一次粘贴”命令。

## 非 PM2 部署（Linux / Docker）

先按原方式停止 systemd、supervisor 或 Docker 服务，在 ST 根目录执行首次安装那一行命令；完成后按原方式启动服务或容器，再刷新网页。Docker 容器内的 ST 根目录通常是 `/home/node/app`。安装器不会替你猜 Compose 服务名，也不会自动重启容器。

## Windows 本地安装

停止 ST 后端，在 SillyTavern 根目录打开 PowerShell，整行复制：

```powershell
$env:QIANMU_SERVER_STOPPED='1'; irm https://raw.githubusercontent.com/Liminale-art/qianmuwanxiang-V2-Directors-Cut/refactor/storyboard-modularization/install-server-plugin.ps1 | iex
```

看到 `千幕服务端已安装/更新，版本节点：...` 后，按原方式启动 ST。

## 安装或更新失败时

- **当前目录不是 SillyTavern 根目录**：先进入能看到 `config.yaml` 的目录，再重试。
- **找不到 pm2 / 无法识别进程**：先执行 `pm2 status`，确认 ST 的进程名和工作目录。
- **有本地改动**：先备份，不要用 `reset --hard` 覆盖。
- **更新失败**：保留终端最后几行和配置备份，不要连续重跑；服务保持停止时，先修复原因再启动。

安装器会保留配置备份，不会删除聊天、密钥、图片或千幕防重记录。它不会替你停止或重启服务；一键更新脚本才会负责 PM2 的停启。

## 健康检查

后端启动后，可在浏览器打开：

```text
https://你的ST地址/api/plugins/qianmu-tts/health
```

返回包含 `"ok":true` 且版本与本次提交对应，说明服务端已加载。它只证明千幕服务已加载，不代表每个上游模型都已验收。
