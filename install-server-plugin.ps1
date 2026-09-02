$ErrorActionPreference = 'Stop'

$configFile = Join-Path (Get-Location) 'config.yaml'
$backupFile = Join-Path (Get-Location) 'config.yaml.qianmu-backup'
$pluginParent = Join-Path (Get-Location) 'plugins'
$pluginDir = Join-Path $pluginParent 'Omniscene'

if (-not (Test-Path -LiteralPath $configFile -PathType Leaf)) {
    throw '安装失败：请在 SillyTavern 根目录运行本命令（当前目录未找到 config.yaml）。'
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw '安装失败：未找到 git。请先安装 Git，重新打开 PowerShell 后再试。'
}

Copy-Item -LiteralPath $configFile -Destination $backupFile -Force
$content = [System.IO.File]::ReadAllText($configFile)
if ($content -match '(?m)^enableServerPlugins\s*:') {
    $content = [System.Text.RegularExpressions.Regex]::Replace(
        $content,
        '(?m)^enableServerPlugins\s*:.*$',
        'enableServerPlugins: true'
    )
} else {
    $content = $content.TrimEnd("`r", "`n") + "`r`n`r`nenableServerPlugins: true`r`n"
}
$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($configFile, $content, $utf8WithoutBom)

New-Item -ItemType Directory -Path $pluginParent -Force | Out-Null
if (Test-Path -LiteralPath (Join-Path $pluginDir '.git') -PathType Container) {
    Write-Host "`n正在更新千幕服务端插件……" -ForegroundColor Cyan
    & git -C $pluginDir pull --ff-only
    if ($LASTEXITCODE -ne 0) { throw '插件更新失败，请检查上方 Git 提示。' }
} elseif (Test-Path -LiteralPath $pluginDir) {
    throw '安装失败：plugins/Omniscene 已存在但不是 Git 仓库。请先将该文件夹改名，再重新运行。'
} else {
    Write-Host "`n正在安装千幕服务端插件……" -ForegroundColor Cyan
    & git clone https://github.com/Liminale-art/qianmuwanxiang-V2-Directors-Cut.git $pluginDir
    if ($LASTEXITCODE -ne 0) { throw '插件安装失败，请检查上方 Git 提示。' }
}

Write-Host "`n千幕服务端插件（豆包 API Key 配音 / 分镜生图 / MiniMax H3）已安装完成。现在请重启 SillyTavern 后端服务（不是只刷新或重新打开网页）。" -ForegroundColor Green
Write-Host '启动后可访问：http://127.0.0.1:8000/api/plugins/qianmu-tts/health'
