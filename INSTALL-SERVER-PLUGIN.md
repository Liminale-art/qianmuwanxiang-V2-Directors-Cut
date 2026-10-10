# 千幕服务端插件安装、更新与环境说明

> **开发联调基准：VPS + PM2。** 本项目的前端与服务端实测默认在 VPS 上由 PM2 托管的 SillyTavern 完成。开发分支、服务端插件提交节点和健康接口版本必须在同一次联调前分别核对；前端页面能打开不代表服务端已更新。每次前端交付若有配套后端版本要求，应由开发交付说明明确提醒核对，本文件不把这类提醒做成插件内提示。

这份文件同时是普通用户的安装/更新入口。请按自己的部署方式只执行对应小节，不要把 VPS、Windows、Docker 的停止或启动命令混用。原来的 `INSTALL-DOUBAO-APIKEY.md` 已更名为本文件，旧书签请改用 `INSTALL-SERVER-PLUGIN.md`。

同一个千幕服务端插件同时为以下功能提供同源请求：

- 配音中的豆包 API Key 接入；
- 分镜中的 NovelAI、Banana / Gemini、GPT Image 2 / OpenAI 兼容中转、Doubao Seedream 与 ComfyUI。
- 影片/H3 属于后续阶段；健康接口中的兼容声明不代表当前已开放影片功能。

先等待正在生成的任务结束，再停止 SillyTavern 后端。安装时需要输入 `STOPPED` 确认；关闭网页不等于停止后端。安装脚本不会替你停止或重启进程；PM2、Docker 和 Windows 的停启方式分别写在下方对应小节。

安装程序会保留独立版本的配置备份，下载/更新成功后才开启 `enableServerPlugins`。本地改动、重复配置项或链接目录会暂停安装，不覆盖用户改动。不需要执行 `npm install`。请使用与前端相匹配的服务版本；不同安装分支不会因为刷新浏览器自动同步。

安装前还应核对两项宿主条件：`enableServerPlugins` 是 ST 的全局插件开关，开启前检查实际 `plugins` 扫描目录，不要将旧千幕或其他插件的备份副本留在其中重复加载；备份应放在扫描目录以外。另核对当前 ST 的 `enableServerPluginsAutoUpdate` 配置及启动行为：若启动时会拉取插件，安装时核对的提交可能发生变化，启动后须再次核对实际提交与健康接口版本。不要为了固定千幕而未经确认改动影响所有插件的全局自动更新开关。

## 部署方式速查

| 环境 | 停止方式 | 更新入口 | 启动方式 |
| --- | --- | --- | --- |
| **VPS + PM2（开发联调基准）** | `pm2 stop <已核对的进程名>` | 进入 ST 根目录，按「PM2 部署」小节核对分支后更新 | `pm2 start <已核对的进程名>`，再查健康接口 |
| VPS 原生 Linux | 按现有 systemd / supervisor / 手工方式停止 | `install-server-plugin.sh` | 按原方式启动，再查健康接口 |
| Docker Compose | 停止对应 Compose 服务 | `install-server-plugin.sh`，并确认插件目录挂载 | `docker compose start <服务名>` 或按原编排启动 |
| Windows 本地 | 退出或停止 ST 后端进程 | `install-server-plugin.ps1` | 按原方式启动，再查健康接口 |
| macOS / Linux 本地 | 退出或停止 ST 后端进程 | `install-server-plugin.sh` | 按原方式启动，再查健康接口 |

表格只说明边界，不会替你猜进程名、Compose 服务名或安装路径；实际执行前以对应小节的只读核对为准。

## 云端 / VPS 部署（Linux）

通过 SSH 进入服务器，按原部署方式停止 ST 后端，再进入安装目录，整行复制并回车：

```bash
curl -fsSL https://raw.githubusercontent.com/Liminale-art/qianmuwanxiang-V2-Directors-Cut/main/install-server-plugin.sh | sh
```

这条命令会自动识别：

- **VPS 原生部署**：当前目录能看到 `config.yaml`；安装完成后按原方式重启 SillyTavern 后端服务。
- **VPS Docker Compose 部署**：当前目录能看到 compose 配置文件和 `config` 文件夹；安装程序会检查插件目录挂载，但不会自动重启容器。完成后按原方式启动（常见服务名可使用 `docker compose start sillytavern`）。

首次安装会从仓库默认分支取得服务端代码。若千幕前端使用 `refactor/storyboard-modularization` 开发分支，保持 ST 停止，按下节核对并切换服务端分支后再启动；只刷新网页或重跑默认分支安装命令，不会取得开发分支的配套版本。

如果出现过 `New-Item: command not found` 或 `Out-Null: command not found`，说明你使用的是 Linux/Git Bash 终端，应使用上面这一行，不要使用 PowerShell 命令。

## 已有 VPS 安装如何更新

在 **SillyTavern 安装目录**（原生部署有 `config.yaml`；Docker Compose 部署有 `config/config.yaml` 和 compose 文件）先核对插件来源、当前分支和本地改动：

```bash
git -C plugins/Omniscene remote get-url origin
git -C plugins/Omniscene branch --show-current
git -C plugins/Omniscene status --short
```

来源应指向官方仓库 `https://github.com/Liminale-art/qianmuwanxiang-V2-Directors-Cut.git`（或你确认的对应 SSH 地址）。若不是这个仓库、插件不是 Git 安装，或 `status --short` 有任何输出，先查明并备份本地改动，不要切分支或覆盖。更新前请按自己的 VPS / ST 备份方式保存 ST 数据、配置及插件；安装脚本生成的独立备份只覆盖 ST 配置，不是聊天和素材的完整备份。

等正在生成的任务结束，**停止 ST 后端或容器**后，再更新。若前端使用本开发分支、服务端却还在 `main`（例如显示 `v1.55.0`），先取得官方分支并切换：

```bash
git -C plugins/Omniscene fetch origin
git -C plugins/Omniscene switch --track -c refactor/storyboard-modularization origin/refactor/storyboard-modularization
```

第二行仅适用于本地尚无这个分支；若已经建过本地分支，改用 `git -C plugins/Omniscene switch refactor/storyboard-modularization`。若原本就处于该分支，无需切换。不要通过 `reset --hard` 消除报错；先核查冲突与本地提交。切换后再次检查 `branch --show-current` 和 `status --short`，确认分支正确、工作树干净，再运行**同开发分支的安装脚本**：

```bash
curl -fsSL https://raw.githubusercontent.com/Liminale-art/qianmuwanxiang-V2-Directors-Cut/refactor/storyboard-modularization/install-server-plugin.sh | sh
```

脚本会在当前分支上执行快进更新，并再次备份 ST 配置；它不会自动切换分支、停止或重启 ST。更新完成后按原部署方式启动后端或容器，刷新 ST 网页，再到千幕「数据管理 → 后端服务」点右侧刷新图标核对「当前」与「配套 / 最新」版本。健康接口返回 `"ok":true` 才表明服务已加载，不代表各上游渠道都已测试通过。仅更新 `main` 仍会留在 `main`，不能用来验证本开发分支的新功能。

### PM2 部署

如果 SillyTavern 由 PM2 托管，先做只读核对，不要把 `m2` 当作命令：

```bash
pm2 status
pm2 describe sillytavern
```

`sillytavern` 和 `/usr/local/games/SillyTavern` 都只是示例，后续命令必须替换为核对后的进程名及真实安装目录。确认 `pm2 describe` 中的工作目录、入口和实际 Node 解释器；终端中的 `node -v` 不一定是 PM2 使用的版本。用该解释器核对运行时和插件加载兼容性，不因网页能打开就跳过检查；本指南不据本地测试声明任意 Node 版本均受支持。

再在该安装目录核对插件来源、分支、节点及本地改动，按上节确认官方来源；任何命令失败、目录含链接、来源不符或有未处理改动，都先停在核对阶段，不继续覆盖：

```bash
(
  set -eu
  cd /usr/local/games/SillyTavern
  pwd -P
  git -C plugins/Omniscene remote get-url origin
  git -C plugins/Omniscene branch --show-current
  git -C plugins/Omniscene rev-parse HEAD
  git -C plugins/Omniscene status --short
)
```

**等待当前生成结束，备份并验证 ST 配置、数据和插件副本可读，再进入维护。** 下面仅适用于已有 Git 安装且本地已存在目标开发分支；首次切分支按上节处理，不要反复强行切换。核对插件扫描目录及自动更新行为后，再执行停止和更新；子 Shell 中任一步失败会立即停止，不会自动启动服务：

```bash
(
  set -eu
  cd /usr/local/games/SillyTavern
  pm2 stop sillytavern
  git -C plugins/Omniscene fetch origin refactor/storyboard-modularization
  git -C plugins/Omniscene switch refactor/storyboard-modularization
  git -C plugins/Omniscene pull --ff-only origin refactor/storyboard-modularization
  git -C plugins/Omniscene rev-parse HEAD
)
```

确认上述过程成功、最终提交是本次核验的配套节点、工作树干净，并用 PM2 实际 Node 解释器检查插件入口可加载后，才执行下一步。**更新或检查失败时保持 ST 停止，不执行启动命令**；先保留现场并按已验证备份处理，不用 `reset --hard` 覆盖本地修改。

```bash
pm2 start sillytavern && pm2 status
```

启动完成后再次核对实际节点（防止启动时自动更新）与健康接口中的 `version`，二者都应对应已检查的配套版本：

```bash
git -C /usr/local/games/SillyTavern/plugins/Omniscene rev-parse HEAD
curl -fsS https://你的-ST-地址/api/plugins/qianmu-tts/health
```

健康接口版本不符或返回 502 时，先查看 `pm2 logs <实际进程名> --lines 100`，再检查反代是否把该健康地址转给同一个 ST 进程；不要靠连续更新、重启或重装 ST 试错。日志可能含私密信息，分享前仅保留相关错误并脱敏。

## 已退役功能说明

正文收藏及其专用服务端路由已从当前版本退役。更新时不会删除 ST 账户中的聊天、素材或旧文件；旧数据仅保留为惰性文件，不再由千幕加载、写入或清理。不要把历史版本的收藏加速说明当作当前可用功能。

## 本地部署

### Windows

先停止 SillyTavern 后端进程，在 **SillyTavern 根目录**打开 PowerShell，整行复制并回车：

```powershell
irm https://raw.githubusercontent.com/Liminale-art/qianmuwanxiang-V2-Directors-Cut/main/install-server-plugin.ps1 | iex
```

### macOS / Linux / Git Bash

关闭 SillyTavern，在 **SillyTavern 根目录**打开终端，整行复制并回车：

```bash
curl -fsSL https://raw.githubusercontent.com/Liminale-art/qianmuwanxiang-V2-Directors-Cut/main/install-server-plugin.sh | sh
```

## 安装完成后

必须**重启 SillyTavern 后端服务或 Docker 容器**，不是只刷新、关闭或重新打开 ST 网页。服务端插件只会在后端启动时加载。

后端重启完成后，再刷新 ST 网页。此时可以：

- 打开千幕 → 配音 → 豆包语音，接入方式选择“API Key”，粘贴 API Key 并测试连接；
- 打开千幕 → 分镜，在所选模型的连接卡中填写官方接口或自定义中转并测试连接。自定义或第三方中转仍可拉取模型、查看接口全部模型；若中转不提供模型列表，也可以手动填写模型 ID。

安装成功后，健康检查地址会显示 `"ok":true`，并在 `services` 中列出 `doubao-tts`、`storyboard-image` 与 `minimax-h3`：

- 本地部署：`http://127.0.0.1:8000/api/plugins/qianmu-tts/health`
- VPS 部署：在你的 SillyTavern 访问地址后加 `/api/plugins/qianmu-tts/health`，例如 `https://st.example.com/api/plugins/qianmu-tts/health`

原生部署会生成 `config.yaml.qianmu-backup.<编号>`；Docker 部署在 `config` 下生成同类备份。每次备份独立保存，不覆盖旧备份；同名 `.ref` 文件记录更新前的插件提交节点，首次安装为空。备份可能含 ST 配置中的私密信息，请勿公开上传。

再次运行会更新现有 Git 安装，不会重复安装；不要同时运行两次安装。失败时请保留备份和提示的暂存目录；不要把“代码已准备、配置未完成”当作成功。脚本不删除聊天、密钥仓、已生成图片或千幕服务防重记录。

需要回退时，先保持后端停止，核对对应备份和 `.ref` 节点后再按原版本恢复；不要直接覆盖后来修改过的 ST 配置。当前脚本尚不提供自动回滚或 ZIP 安装覆盖，也不保证任意旧版本都具备新的服务收片入口。

## 常见提示

- 提示“既不是原生安装目录，也不是 Docker Compose 目录”：当前终端位置不对。原生部署需进入能看到 `config.yaml` 的目录；Docker 部署需进入能看到 compose 文件和 `config` 文件夹的目录。
- Docker 提示“尚未挂载服务端插件目录”：在 `sillytavern` 服务的 `volumes` 下加入 `"./plugins:/home/node/app/plugins"`，重新执行安装命令。
- `git command not found`：请先安装 Git，重新打开终端后再次粘贴安装命令。
- 豆包测试返回 401、403 或资源错误：确认填写的是豆包语音 API Key，账号已开通 Seed TTS 2.0，并使用属于该资源的音色 ID。
- 旧版 App ID 仍可使用：在“接入方式”中选择“App ID + Access Key”。
- 分镜连接失败：检查 Base URL、API Key 与模型 ID。VPS 或 Docker 部署时，ComfyUI 地址必须能从 SillyTavern 后端所在的主机或容器访问，不能直接把仅宿主机可见的 `127.0.0.1` 当作容器内地址。
- 第三方中转无法拉取模型：部分中转不提供标准模型列表，仍可在千幕中手动填写该中转支持的模型 ID。
- 无终端交互环境：必须先由操作者确认 ST 已停止，再设置 `QIANMU_SERVER_STOPPED=1` 执行；这个变量只是确认，不会代为检查或停止服务。
- 提示已有安装维护锁：先确认另一次安装及其 Git 子进程是否仍在运行。中断安装可能留下 `.qianmu-installer.lock`，请核查后处理，不要直接重复安装或删除不明目录。
