# 千幕豆包新版 API Key 安装说明

这份说明用于启用千幕的豆包新版 API Key。完成一次安装后，千幕中只需填写 API Key，不需要配置反代地址。

## 安装前确认

- 已正常安装并能启动 SillyTavern。
- 已在 SillyTavern 中安装千幕万象。
- 已从豆包语音新版控制台取得 API Key。

## 第一步：开启 SillyTavern 服务端插件

1. 关闭 SillyTavern。
2. 打开 SillyTavern 根目录中的 `config.yaml`。
3. 找到 `enableServerPlugins`，修改为：

   ```yaml
   enableServerPlugins: true
   ```

4. 保存文件。

如果 `config.yaml` 中没有这一项，可在文件末尾另起一行添加。

## 第二步：安装千幕服务端插件

打开终端并进入 SillyTavern 根目录，然后执行对应命令。

### Windows PowerShell

```powershell
New-Item -ItemType Directory -Force plugins | Out-Null
git clone https://github.com/liminale1525/Omniscene.git plugins/Omniscene
```

### macOS / Linux

```bash
mkdir -p plugins
git clone https://github.com/liminale1525/Omniscene.git plugins/Omniscene
```

如果提示 `plugins/Omniscene` 已存在，说明已经安装过，请改为执行：

```bash
git -C plugins/Omniscene pull
```

此插件没有额外依赖，不需要执行 `npm install`。

## 第三步：重新启动并检查

1. 重新启动 SillyTavern。
2. 查看启动终端，应能看到千幕服务端插件已初始化。
3. 登录 SillyTavern 后，在浏览器打开：

   ```text
   http://你的SillyTavern地址/api/plugins/qianmu-tts/health
   ```

   本机默认地址通常是：

   ```text
   http://127.0.0.1:8000/api/plugins/qianmu-tts/health
   ```

4. 页面显示 `"ok":true` 即安装成功。

## 第四步：在千幕中连接豆包

1. 打开千幕 → 配音。
2. 配音模型选择“豆包语音”。
3. 接入方式选择“新版 API Key”。
4. 粘贴 API Key。
5. 点击“测试连接”，听到测试语音即完成。

不需要填写接口地址或 TTS 反代地址。

## 更新方式

以后更新千幕前端后，在 SillyTavern 根目录执行一次：

```bash
git -C plugins/Omniscene pull
```

然后重启 SillyTavern，使服务端插件同步到新版本。

## 常见问题

### 提示“未检测到千幕服务端插件”

依次检查：

1. `config.yaml` 中是否为 `enableServerPlugins: true`。
2. 仓库是否位于 SillyTavern 根目录的 `plugins/Omniscene`。
3. 修改配置或更新插件后是否重启过 SillyTavern。
4. 健康检查地址是否显示 `"ok":true`。

### 测试连接返回 401、403 或资源错误

- 确认填写的是豆包语音新版控制台的 API Key，不是火山方舟聊天模型 Key。
- 确认账号已开通 Seed TTS 2.0 服务。
- 确认角色使用的音色 ID 属于 Seed TTS 2.0。

### 旧版 App ID 还能使用吗

可以。在千幕的“接入方式”中选择“App ID + Access Key”即可继续使用旧版直连。
