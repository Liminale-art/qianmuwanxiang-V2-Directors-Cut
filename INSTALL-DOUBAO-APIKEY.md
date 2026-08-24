# 千幕豆包新版 API Key 一键安装

安装程序会自动备份并修改 `config.yaml`、开启服务端插件、创建插件文件夹，并自动判断是首次安装还是更新。不需要手动编辑配置，也不需要执行 `npm install`。

## 云端 / VPS 部署（Linux）

通过 SSH 进入服务器，并进入 SillyTavern 的安装目录后，整行复制并回车：

```bash
curl -fsSL https://raw.githubusercontent.com/liminale1525/Omniscene/main/install-server-plugin.sh | sh
```

这条命令会自动识别：

- **VPS 原生部署**：当前目录能看到 `config.yaml`；安装完成后按原方式重启 SillyTavern 后端服务。
- **VPS Docker Compose 部署**：当前目录能看到 compose 配置文件和 `config` 文件夹；安装程序会检查插件目录挂载，并尝试自动重启 `sillytavern` 容器。

如果出现过 `New-Item: command not found` 或 `Out-Null: command not found`，说明你使用的是 Linux/Git Bash 终端，应使用上面这一行，不要使用 PowerShell 命令。

## 本地部署

### Windows

先关闭 SillyTavern，在 **SillyTavern 根目录**打开 PowerShell，整行复制并回车：

```powershell
irm https://raw.githubusercontent.com/liminale1525/Omniscene/main/install-server-plugin.ps1 | iex
```

### macOS / Linux / Git Bash

关闭 SillyTavern，在 **SillyTavern 根目录**打开终端，整行复制并回车：

```bash
curl -fsSL https://raw.githubusercontent.com/liminale1525/Omniscene/main/install-server-plugin.sh | sh
```

## 安装完成后

必须**重启 SillyTavern 后端服务或 Docker 容器**，不是只刷新、关闭或重新打开 ST 网页。服务端插件只会在后端启动时加载。

后端重启完成后，再刷新 ST 网页，然后打开千幕 → 配音 → 豆包语音，接入方式选择“API Key”，粘贴 API Key 并点击“测试连接”。

安装成功后，健康检查地址会显示 `"ok":true`：

- 本地部署：`http://127.0.0.1:8000/api/plugins/qianmu-tts/health`
- VPS 部署：在你的 SillyTavern 访问地址后加 `/api/plugins/qianmu-tts/health`，例如 `https://st.example.com/api/plugins/qianmu-tts/health`

原生部署会生成 `config.yaml.qianmu-backup`；Docker 部署会生成 `config/config.yaml.qianmu-backup`。再次运行同一条安装命令会自动更新插件，不会重复安装。

## 常见提示

- 提示“既不是原生安装目录，也不是 Docker Compose 目录”：当前终端位置不对。原生部署需进入能看到 `config.yaml` 的目录；Docker 部署需进入能看到 compose 文件和 `config` 文件夹的目录。
- Docker 提示“尚未挂载服务端插件目录”：在 `sillytavern` 服务的 `volumes` 下加入 `"./plugins:/home/node/app/plugins"`，重新执行安装命令。
- `git command not found`：请先安装 Git，重新打开终端后再次粘贴安装命令。
- 测试返回 401、403 或资源错误：确认填写的是豆包语音新版 API Key，账号已开通 Seed TTS 2.0，并使用属于该资源的音色 ID。
- 旧版 App ID 仍可使用：在“接入方式”中选择“App ID + Access Key”。
