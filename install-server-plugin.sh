#!/usr/bin/env sh
set -eu

if ! command -v git >/dev/null 2>&1; then
  printf '\n安装失败：未找到 git。请先安装 Git，重新打开终端后再试。\n'
  exit 1
fi

DEPLOYMENT="native"
COMPOSE_FILE=""
if [ -f "./config.yaml" ]; then
  CONFIG_FILE="./config.yaml"
elif [ -f "./config/config.yaml" ]; then
  DEPLOYMENT="docker"
  CONFIG_FILE="./config/config.yaml"
  for candidate in docker-compose.yml docker-compose.yaml compose.yml compose.yaml; do
    if [ -f "./$candidate" ]; then COMPOSE_FILE="./$candidate"; break; fi
  done
  if [ -z "$COMPOSE_FILE" ]; then
    printf '\n安装失败：发现 Docker 配置目录，但当前目录没有 compose 配置文件。\n请在包含 docker-compose.yml（或 compose.yaml）的目录运行。\n'
    exit 1
  fi
  if ! grep -Eq '/home/node/app/plugins' "$COMPOSE_FILE"; then
    printf '\n安装暂停：%s 尚未挂载服务端插件目录。\n' "$COMPOSE_FILE"
    printf '请在 sillytavern 服务的 volumes 下加入：\n  - "./plugins:/home/node/app/plugins"\n然后重新运行本命令。\n'
    exit 1
  fi
else
  printf '\n安装失败：当前目录既不是 SillyTavern 原生安装目录，也不是 Docker Compose 目录。\n'
  printf '原生部署应能看到 config.yaml；Docker 部署应能看到 compose 文件和 config 文件夹。\n'
  exit 1
fi

BACKUP_FILE="${CONFIG_FILE}.qianmu-backup"
TEMP_FILE="${CONFIG_FILE}.qianmu.tmp"
PLUGIN_PARENT="./plugins"
PLUGIN_DIR="$PLUGIN_PARENT/Omniscene"

cp -f "$CONFIG_FILE" "$BACKUP_FILE"
trap 'rm -f "$TEMP_FILE"' EXIT HUP INT TERM

if grep -Eq '^enableServerPlugins[[:space:]]*:' "$CONFIG_FILE"; then
  awk '/^enableServerPlugins[[:space:]]*:/ { print "enableServerPlugins: true"; next } { print }' "$CONFIG_FILE" > "$TEMP_FILE"
else
  awk '{ print } END { print ""; print "enableServerPlugins: true" }' "$CONFIG_FILE" > "$TEMP_FILE"
fi
mv -f "$TEMP_FILE" "$CONFIG_FILE"

mkdir -p "$PLUGIN_PARENT"
if [ -d "$PLUGIN_DIR/.git" ]; then
  printf '\n正在更新千幕服务端插件……\n'
  git -C "$PLUGIN_DIR" pull --ff-only
elif [ -e "$PLUGIN_DIR" ]; then
  printf '\n安装失败：plugins/Omniscene 已存在但不是 Git 仓库。请先将该文件夹改名，再重新运行。\n'
  exit 1
else
  printf '\n正在安装千幕服务端插件……\n'
  git clone https://github.com/liminale1525/Omniscene.git "$PLUGIN_DIR"
fi

if [ "$DEPLOYMENT" = "docker" ]; then
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    printf '\n正在重启 SillyTavern Docker 容器……\n'
    if docker compose restart sillytavern; then
      printf '\n千幕豆包新版 API Key 插件已安装，Docker 容器已重启。\n'
    else
      printf '\n插件已安装，但自动重启失败。请手动执行：docker compose restart sillytavern\n'
    fi
  else
    printf '\n插件已安装。请手动重启 SillyTavern Docker 容器。\n'
  fi
else
  printf '\n千幕豆包新版 API Key 插件已安装完成。现在请重启 SillyTavern 后端服务（不是只刷新或重新打开网页）。\n'
fi
printf '启动后可访问：http://127.0.0.1:8000/api/plugins/qianmu-tts/health\n\n'
