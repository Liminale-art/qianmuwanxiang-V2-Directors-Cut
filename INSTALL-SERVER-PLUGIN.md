# 千幕服务端插件：安装与更新

> 2026-11-04 按候选分支源码核对。安装成功、分支正确和后端已重启加载是不同检查，最后一行版本信息不能代替运行态验证。
> 聊天备份与找回现在只使用 ST 原生的 `backups`／`chats` 能力，千幕不再安装或启动独立的定时聊天备份服务。服务端插件另外为聊天备份面板提供可选的 ST 原生保留数量接口；它只修改 ST 自己的 `config.yaml`，不创建第二套备份。此服务端插件仍用于豆包 TTS、分镜图像和 MiniMax H3 等其他功能。
> 功能不限定 VPS 或 PM2：使用 ST 自己的账户目录和 `dataRoot`。本地 Windows、Linux、macOS、Docker 等按各自原启动方式安装和重启；下方 PM2 命令只适用于对应环境。各部署的实际验收分开，不把本地隔离测试称为全部实测。
> 当前候选分支为 `refactor/storyboard-modularization`。下方脚本下载地址使用此分支，但首次安装脚本内部仍普通 clone 仓库默认分支；已有安装仅快进当前分支。只有 PM2 更新脚本会主动切换到候选分支。不要把脚本来源当成已安装代码的分支。

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
千幕服务端已更新至 vX。
```

首次安装的实际分支由仓库默认分支决定。启动前先执行下方“分支核对”；若要验收本文候选而结果不是目标分支，须先完成受控分支切换，不能直接记为候选安装完成。随后按原方式启动 ST 后端；只刷新网页不会加载后端插件。

## 已有安装更新（仅 Linux／VPS 的 PM2 部署）

这段命令请在你自己的 **SillyTavern 根目录**执行，脚本不会写死安装路径；PM2 名称可用 `QIANMU_PM2_NAME` 指定，未指定时使用 `sillytavern`。它会在更新前后处理原有服务状态；更新失败会尝试恢复原先在线的服务。

```bash
bash -c 'set -o pipefail; printf "\n[千幕更新] 下载更新脚本...\n"; curl -fL --retry 2 --connect-timeout 15 --max-time 120 https://raw.githubusercontent.com/Liminale-art/qianmuwanxiang-V2-Directors-Cut/refactor/storyboard-modularization/update-server-plugin.sh | bash'
```

结尾会提示 `千幕服务端已更新至 vX`。若当前 ST 已安装忆幕，同一条命令还会从同一提交同步忆幕前端和服务端，并追加 `忆幕已更新：前端 vX；服务端 vY`；没有安装忆幕则不会额外安装。

聊天备份面板的“单聊天备份数上限”只允许管理员账户写入 1–500；保存后必须重启 ST 后端才生效。服务端从 ST 启动参数提供的 `configPath` 读取配置，兼容普通根目录、Docker 的 `config/config.yaml` 和全局安装；若由 `SILLYTAVERN_BACKUPS_COMMON_NUMBEROFBACKUPS` 环境变量控制，则界面仅显示当前值，不会覆盖环境配置。

更新脚本位于仓库的 [update-server-plugin.sh](update-server-plugin.sh)，不再把大段 heredoc 代码直接粘到交互终端，避免终端停在 `>` 续行状态。

<a id="忆幕随千幕统一更新"></a>
## 忆幕随千幕统一更新

忆幕不在 ST 扩展更新器中单独更新。上面的 **PM2 更新脚本**会在检测到忆幕前端或服务端时，从千幕插件同一提交成对同步；未安装忆幕时不额外安装。首次安装仍见[忆幕安装说明](yimu/README.md#安装与更新)。

Windows 和非 PM2 使用的基础千幕安装器目前**不会自动同步忆幕**；这两条部署路径的统一更新还未闭合。需要保持同源配套时，管理员须核定千幕插件提交，再从该提交执行忆幕成对安装器，不能仅更新一侧、仅看千幕成功提示或用 ST 单独更新忆幕。当前代码组合为忆幕前端 0.8.16／服务端 0.8.9，二者不要求数字相等。

## PM2 手动确认（只在一键命令提示时使用）

```bash
pm2 status
pm2 describe 你的ST进程名
```

确认进程工作目录就是当前目录后，再重新执行上面的“一次粘贴”命令。

## 非 PM2 部署（Linux / Docker）

先按原方式停止 systemd、supervisor 或 Docker 服务，在 ST 根目录执行基础安装命令。已有安装只更新其当前 Git 分支；首次安装取默认分支，完成后须核对分支与提交。该脚本不自动更新忆幕；配套组件核对完成后再按原方式启动服务或容器，并刷新网页。Docker 容器内的 ST 根目录通常是 `/home/node/app`。安装器不会替你猜 Compose 服务名，也不会自动重启容器。

## Windows 本地安装

停止 ST 后端，在 SillyTavern 根目录打开 PowerShell，整行复制：

```powershell
$env:QIANMU_SERVER_STOPPED='1'; irm https://raw.githubusercontent.com/Liminale-art/qianmuwanxiang-V2-Directors-Cut/refactor/storyboard-modularization/install-server-plugin.ps1 | iex
```

看到 `千幕服务端已更新至 vX` 后仍须核对分支、提交及配套组件，再按原方式启动 ST。Windows 脚本首次克隆默认分支，已有安装快进当前分支，不切换候选分支，也不自动更新忆幕。

## 分支与加载核对

在实际 ST 根目录只读核对：

```text
git -C plugins/Omniscene branch --show-current
git -C plugins/Omniscene rev-parse HEAD
git -C plugins/Omniscene status --short
```

本候选要求 `refactor/storyboard-modularization`；2026-11-04 文档核对代码基点为 `4c24a99e`。不同日期安装可得到后续提交，应记录实际 SHA，不将该基点当作永远最新。若是其他分支、有本地改动或旧版配套，保留现有代码和数据后再处理；不要强制重置。基础安装器尚未统一候选分支和忆幕更新步骤，这是当前发行待补项。

重启后分别核前端加载资源、千幕服务及忆幕服务实际返回版本；磁盘文件存在或 Git 同步成功不代表运行进程已加载。千幕前端仍需按自己的安装方式更新，PM2 脚本不替换千幕前端扩展。

## 安装或更新失败时

- **当前目录不是 SillyTavern 根目录**：先进入能看到 `config.yaml` 的目录，再重试。
- **找不到 pm2 / 无法识别进程**：先执行 `pm2 status`，确认 ST 的进程名和工作目录。
- **有本地改动**：先备份，不要用 `reset --hard` 覆盖。
- **更新失败**：终端只显示失败原因；若原先在线的 PM2 未能自动恢复，会明确提示 `本次未自动启动 sillytavern`。

基础安装器默认保留最近 5 份配置／提交回退资料（可由 `QIANMU_BACKUP_RETENTION` 调整）；这不是完整账户数据备份，也不代替忆幕自己的成对安装回退目录。安装器不会删除聊天、密钥、图片或千幕数据。服务端更新不会输出配置备份路径、健康检查或内部暂存目录。
