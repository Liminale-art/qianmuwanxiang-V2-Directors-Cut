#!/usr/bin/env sh
set -eu
umask 077

command -v node >/dev/null 2>&1 || { printf '忆幕安装需要 Node.js 18 或以上版本。\n' >&2; exit 1; }
command -v git >/dev/null 2>&1 || { printf '忆幕安装需要 Git。\n' >&2; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) < 18) process.exit(1)' || { printf '请先更新 Node.js 至 18 或以上版本。\n' >&2; exit 1; }
YIMU_INSTALL_ROOT=$(pwd -P)
YIMU_STAGE=$(mktemp -d "${TMPDIR:-/tmp}/yimu-source.XXXXXX")
YIMU_STAGE_REAL=$(cd "$YIMU_STAGE" && pwd -P)
YIMU_STAGE_PARENT=$(cd "$YIMU_STAGE/.." && pwd -P)
cleanup_yimu_source() {
    # Delete only the exact private directory created above, never an installation.
    [ -d "$YIMU_STAGE_REAL" ] && [ ! -L "$YIMU_STAGE_REAL" ] || return 0
    YIMU_CURRENT_REAL=$(cd "$YIMU_STAGE_REAL" && pwd -P) || return 0
    [ "$YIMU_CURRENT_REAL" = "$YIMU_STAGE_REAL" ] || return 0
    [ "$(dirname "$YIMU_CURRENT_REAL")" = "$YIMU_STAGE_PARENT" ] || return 0
    case "$(basename "$YIMU_CURRENT_REAL")" in yimu-source.*) rm -rf -- "$YIMU_CURRENT_REAL" ;; esac
}
trap cleanup_yimu_source 0
trap 'exit 1' HUP INT TERM
git -c core.hooksPath="$YIMU_STAGE_REAL/no-hooks" -c core.autocrlf=false clone --depth 1 --single-branch \
    --branch refactor/storyboard-modularization \
    https://github.com/Liminale-art/qianmuwanxiang-V2-Directors-Cut.git "$YIMU_STAGE_REAL/source"
node "$YIMU_STAGE_REAL/source/scripts/install-yimu.mjs" --st-root "$YIMU_INSTALL_ROOT" "$@"
