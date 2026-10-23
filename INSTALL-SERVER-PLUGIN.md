# 千幕服务端插件：安装与更新

> 本文只保留普通用户真正需要的操作：复制命令、执行命令、看最后一行结果。
> 聊天备份与找回现在只使用 ST 原生的 `backups`／`chats` 能力，千幕不再安装或启动独立的定时聊天备份服务。服务端插件另外为聊天备份面板提供可选的 ST 原生保留数量接口；它只修改 ST 自己的 `config.yaml`，不创建第二套备份。此服务端插件仍用于豆包 TTS、分镜图像和 MiniMax H3 等其他功能。
> 功能不限定 VPS 或 PM2：使用 ST 自己的账户目录和 `dataRoot`。本地 Windows、Linux、macOS、Docker 等按各自原启动方式安装和重启；下方 PM2 命令只适用于对应环境。各部署的实际验收分开，不把本地隔离测试称为全部实测。
> 本次前端推送使用 `refactor/storyboard-modularization`，所以文中的服务端命令也使用同名分支；正式稳定版发布后，统一改用 `main`。

## 使用前先确认

1. 等正在生成的任务结束。
2. 在 ST 所在设备使用适合该部署的终端（Windows 用 PowerShell，Linux／macOS 用 Bash）；只有使用宝塔的环境才需要宝塔终端，不要在 ST 聊天输入框输入命令。
3. 当前目录已经是 SillyTavern 根目录；能看到 `config.yaml`，或 Docker 部署能看到 `config/config.yaml` 和 Compose 文件。
4. 命令失败就停下来，保留终端最后几行，不要连续重复执行。

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

这段命令默认在 **SillyTavern 根目录**执行。开发测试环境的 PM2 进程名固定为 `sillytavern`。整行复制并按一次回车即可；它会下载独立更新脚本，在子进程中完成检查 → 停止 PM2 → 更新分支 → 更新插件 → 启动 PM2 → 检查在线状态。更新失败只结束子进程，不会关闭宝塔终端，也不会等待额外输入。

```bash
bash -c 'set -o pipefail; printf "\n[千幕更新] 下载更新脚本...\n"; curl -fL --retry 2 --connect-timeout 15 --max-time 120 https://raw.githubusercontent.com/Liminale-art/qianmuwanxiang-V2-Directors-Cut/refactor/storyboard-modularization/update-server-plugin.sh | bash'
```

最后看到 `更新完成：PM2=...，服务端版本=v1.59.482，插件提交=...`，才算版本校验通过。脚本会先核对插件包版本；如果设置了 `QIANMU_HEALTH_URL`，还会在 PM2 重启后核对在线健康接口返回的版本。没有看到这行就保留错误输出，不要连续重跑；如果 PM2 已停止，先按提示处理。

如果 ST 在本机有稳定的访问地址，可在执行更新命令前设置在线核对地址，例如：

```bash
QIANMU_HEALTH_URL='http://127.0.0.1:8000/api/plugins/qianmu-tts/health' bash -c 'set -o pipefail; printf "\n[千幕更新] 下载更新脚本...\n"; curl -fL --retry 2 --connect-timeout 15 --max-time 120 https://raw.githubusercontent.com/Liminale-art/qianmuwanxiang-V2-Directors-Cut/refactor/storyboard-modularization/update-server-plugin.sh | bash'
```

不设置时仍会执行本地插件包版本校验，适合反向代理、容器或 ST 端口不固定的部署。

聊天备份面板的“ST 原生每聊天备份数”只允许管理员账户写入 1–500；保存后必须重启 ST 后端才生效。服务端从 ST 启动参数提供的 `configPath` 读取配置，兼容普通根目录、Docker 的 `config/config.yaml` 和全局安装；若由 `SILLYTAVERN_BACKUPS_COMMON_NUMBEROFBACKUPS` 环境变量控制，则界面仅显示当前值，不会覆盖环境配置。

更新脚本位于仓库的 [update-server-plugin.sh](update-server-plugin.sh)，不再把大段 heredoc 代码直接粘到交互终端，避免终端停在 `>` 续行状态。

本开发环境已经固定使用 `sillytavern`；如果其他部署确实使用不同的 PM2 名称，需要先修改脚本中的 `PM2_NAME` 再使用。

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
