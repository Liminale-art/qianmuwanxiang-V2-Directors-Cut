#!/usr/bin/env bash
set -Eeuo pipefail

# This file is intentionally a standalone Bash child process. The copy-paste
# command in INSTALL-SERVER-PLUGIN.md downloads it and runs it with `bash`, so
# a failure cannot close the caller's interactive Baota terminal.

ST_ROOT=$(pwd -P)
PLUGIN="$ST_ROOT/plugins/Omniscene"
BRANCH='refactor/storyboard-modularization'
REPO='https://github.com/Liminale-art/qianmuwanxiang-V2-Directors-Cut.git'
PM2_NAME="${QIANMU_PM2_NAME:-sillytavern}"
INSTALLER=''
PM2_WAS_ONLINE=0
PM2_STOPPED=0

fail() {
  printf '更新失败：%s\n' "$*" >&2
  exit 1
}

finish() {
  local code=$?
  if [ -n "$INSTALLER" ] && [ -f "$INSTALLER" ]; then
    rm -f -- "$INSTALLER" || true
  fi
  if [ "$code" -ne 0 ] && [ "$PM2_STOPPED" -eq 1 ] && [ "$PM2_WAS_ONLINE" -eq 1 ]; then
    if pm2 start "$PM2_NAME" >/dev/null 2>&1; then
      printf '本次更新未完成，已重新启动 %s。\n' "$PM2_NAME" >&2
    else
      printf '本次未自动启动 %s。\n' "$PM2_NAME" >&2
    fi
  fi
  return "$code"
}
trap finish EXIT

step() {
  printf '\n[%s]\n' "$*"
}

step '检查 SillyTavern 根目录'
[ -f "$ST_ROOT/config.yaml" ] || [ -f "$ST_ROOT/config/config.yaml" ] || fail '当前目录不是 SillyTavern 根目录。请先 cd 到 ST 根目录。'
command -v git >/dev/null 2>&1 || fail '找不到 Git。'
command -v pm2 >/dev/null 2>&1 || fail '找不到 pm2，请先加载运行 ST 的 Node/PM2 环境。'

step '检查 PM2 进程'
pm2 describe "$PM2_NAME" >/dev/null 2>&1 || fail "找不到 PM2 进程 $PM2_NAME。"
if pm2 describe "$PM2_NAME" 2>/dev/null | grep -Eqi 'status[[:space:]]+online|online'; then
  PM2_WAS_ONLINE=1
fi

[ -d "$PLUGIN/.git" ] && [ ! -L "$PLUGIN/.git" ] || fail '没有找到现有 Git 插件；首次安装请使用安装命令。'
remote=$(git -C "$PLUGIN" remote get-url origin) || fail '无法读取插件远端地址。'
[ "${remote%/}" = "$REPO" ] || [ "${remote%/}" = 'git@github.com:Liminale-art/qianmuwanxiang-V2-Directors-Cut.git' ] || fail "插件远端不是官方仓库：$remote"
[ -z "$(git -C "$PLUGIN" status --short)" ] || fail '插件有未提交的本地改动，请先备份并核对。'

step '同步服务端分支'
git -C "$PLUGIN" fetch origin "$BRANCH" || fail '获取服务端分支失败。'
if git -C "$PLUGIN" show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git -C "$PLUGIN" switch "$BRANCH" || fail '切换服务端分支失败。'
else
  git -C "$PLUGIN" switch --track -c "$BRANCH" "origin/$BRANCH" || fail '创建服务端分支失败。'
fi
[ "$(git -C "$PLUGIN" rev-parse --abbrev-ref "$BRANCH@{upstream}" 2>/dev/null || true)" = "origin/$BRANCH" ] || \
  git -C "$PLUGIN" branch --set-upstream-to="origin/$BRANCH" "$BRANCH" || fail '设置服务端分支失败。'
[ -z "$(git -C "$PLUGIN" status --short)" ] || fail '切换分支后出现本地改动，已停止。'

step "停止 PM2：$PM2_NAME"
if [ "$PM2_WAS_ONLINE" -eq 1 ]; then
  pm2 stop "$PM2_NAME" || fail 'PM2 停止失败。'
  PM2_STOPPED=1
fi

step '下载并执行插件更新器'
INSTALLER=$(mktemp "${TMPDIR:-/tmp}/qianmu-install.XXXXXX") || fail '无法创建临时文件。'
curl -fL --retry 2 --connect-timeout 15 --max-time 120 \
  "https://raw.githubusercontent.com/Liminale-art/qianmuwanxiang-V2-Directors-Cut/$BRANCH/install-server-plugin.sh" \
  -o "$INSTALLER" || fail '下载安装脚本失败。'
QIANMU_SERVER_STOPPED=1 QIANMU_INSTALLER_QUIET=1 sh "$INSTALLER" || fail '插件更新失败。'

# Yimu is a bundled Qianmu component. If it is already installed, update its
# paired frontend/server from this same checked-out commit. A missing Yimu is
# left untouched so a Qianmu-only installation does not gain a new component.
YIMU_FRONTEND="$ST_ROOT/public/scripts/extensions/third-party/yimu"
YIMU_SERVER="$ST_ROOT/plugins/yimu"
if [ -e "$YIMU_FRONTEND" ] || [ -e "$YIMU_SERVER" ]; then
  command -v node >/dev/null 2>&1 || fail '忆幕已安装，但找不到 Node.js。'
  [ -f "$PLUGIN/scripts/install-yimu.mjs" ] || fail '忆幕更新入口不完整。'
  YIMU_CONFIG_ARG=()
  if [ ! -f "$ST_ROOT/config.yaml" ] && [ -f "$ST_ROOT/config/config.yaml" ]; then YIMU_CONFIG_ARG=(--config config/config.yaml); fi
  YIMU_INSTALLER_QUIET=1 node "$PLUGIN/scripts/install-yimu.mjs" --st-root "$ST_ROOT" --stopped "${YIMU_CONFIG_ARG[@]}" || fail '忆幕更新失败。'
fi

COMMIT=$(git -C "$PLUGIN" rev-parse HEAD) || fail '无法读取更新后的提交节点。'
SERVICE_VERSION=$(sed -nE 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$PLUGIN/package.json" | head -n 1)
[ "$SERVICE_VERSION" = "$(git -C "$PLUGIN" show HEAD:package.json 2>/dev/null | sed -nE 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | head -n 1)" ] || fail '服务端版本校验失败。'
printf '%s' "$SERVICE_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || fail '服务端版本号无效。'

step "启动 PM2：$PM2_NAME"
if [ "$PM2_WAS_ONLINE" -eq 1 ]; then
  pm2 start "$PM2_NAME" || fail '插件已更新，但 PM2 启动失败。'
  PM2_STOPPED=0
fi

printf '千幕服务端已更新至 v%s。\n' "$SERVICE_VERSION"
