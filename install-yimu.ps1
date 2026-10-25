$ErrorActionPreference = 'Stop'
$installerArguments = @($args)
$installRoot = (Get-Location).ProviderPath
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw '忆幕安装需要 Node.js 18 或以上版本。' }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw '忆幕安装需要 Git。' }
& node -e "if (Number(process.versions.node.split('.')[0]) < 18) process.exit(1)"
if ($LASTEXITCODE -ne 0) { throw '请先更新 Node.js 至 18 或以上版本。' }
$stageParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
$stage = Join-Path $stageParent ('yimu-source.' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
$exitCode = 1
try {
    $source = Join-Path $stage 'source'
    & git -c "core.hooksPath=$(Join-Path $stage 'no-hooks')" -c core.autocrlf=false clone --depth 1 --single-branch --branch refactor/storyboard-modularization https://github.com/Liminale-art/qianmuwanxiang-V2-Directors-Cut.git $source
    if ($LASTEXITCODE -ne 0) { throw '未能获取忆幕交付版本，ST 文件未修改。' }
    & node (Join-Path $source 'scripts/install-yimu.mjs') --st-root $installRoot @installerArguments
    $exitCode = $LASTEXITCODE
} finally {
    # Only the exact temporary download is removed; installed files/backups stay in ST.
    if (Test-Path -LiteralPath $stage) {
        $item = Get-Item -LiteralPath $stage -Force
        $resolved = [IO.Path]::GetFullPath($item.FullName)
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0 -and
            [IO.Path]::GetDirectoryName($resolved) -eq $stageParent -and
            [IO.Path]::GetFileName($resolved) -match '^yimu-source\.[0-9a-f]{32}$') {
            Remove-Item -LiteralPath $resolved -Recurse -Force
        }
    }
}
if ($exitCode -ne 0) { throw '忆幕安装未完整完成，请保留上方错误信息并核对。' }
