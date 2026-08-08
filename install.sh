#!/usr/bin/env bash
#
# WebDAV Chat Backup 一键安装 / 更新脚本
#
#   bash <(curl -sL https://cdn.jsdelivr.net/gh/ZZZa-o/sillytavern-webdav-chat-backup@main/install.sh)
#
# 可选：把 SillyTavern 目录作为参数传入
#   bash install.sh ~/SillyTavern
#
set -euo pipefail

REPO_URL="https://github.com/ZZZa-o/sillytavern-webdav-chat-backup.git"
PLUGIN_ID="webdav-chat-backup"

if [ -t 1 ]; then
    C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
    C_OK=''; C_WARN=''; C_ERR=''; C_DIM=''; C_OFF=''
fi

info() { printf '%s\n' "  $*"; }
ok()   { printf '%s\n' "${C_OK}  ✓${C_OFF} $*"; }
warn() { printf '%s\n' "${C_WARN}  !${C_OFF} $*"; }
die()  { printf '%s\n' "${C_ERR}  ✗${C_OFF} $*" >&2; exit 1; }

stamp() { date +%Y%m%d-%H%M%S; }

# ---------------------------------------------------------------------------
# 定位 SillyTavern 目录
# ---------------------------------------------------------------------------

is_st_root() {
    [ -n "${1:-}" ] && [ -f "$1/server.js" ] && [ -d "$1/public" ]
}

find_st_root() {
    local candidate
    for candidate in "$@"; do
        [ -n "$candidate" ] || continue
        if is_st_root "$candidate"; then
            (cd "$candidate" && pwd)
            return 0
        fi
    done
    return 1
}

ST_ROOT="$(find_st_root \
    "${1:-}" \
    "${ST_DIR:-}" \
    "$PWD" \
    "$PWD/SillyTavern" \
    "$HOME/SillyTavern" \
    "$HOME/sillytavern" \
    || true)"

if [ -z "$ST_ROOT" ]; then
    die "找不到 SillyTavern 目录。请在酒馆目录里运行，或把路径作为参数传入：
       bash install.sh ~/SillyTavern"
fi

command -v git >/dev/null 2>&1 || die "未安装 git。Termux 用户先执行：pkg install git"

# 迁移旧版手动安装时，备份放在这里。必须位于 plugins/ 与 third-party/ 之外，
# 否则酒馆会把备份目录也当成插件/扩展加载。
OLD_ROOT="$ST_ROOT/_webdav-chat-backup-old"

printf '\n%s\n' "SillyTavern 目录：$ST_ROOT"
printf '%s\n\n' "${C_DIM}正在安装 WebDAV Chat Backup...${C_OFF}"

# ---------------------------------------------------------------------------
# 克隆或更新
# ---------------------------------------------------------------------------

clone_or_update() {
    local dest="$1" label="$2"

    if [ -d "$dest/.git" ]; then
        info "$label 已是 git 仓库，尝试更新..."
        git -C "$dest" fetch origin --quiet || { warn "$label 拉取失败，保持现状"; return 0; }
        if git -C "$dest" pull --ff-only --quiet 2>/dev/null; then
            ok "$label 已更新到最新版本"
        else
            warn "$label 存在本地改动或分支分叉，跳过更新（目录：$dest）"
        fi
        return 0
    fi

    if [ -e "$dest" ]; then
        # 之前是手动复制安装的。备份必须挪出 plugins/ 和 third-party/，
        # 因为酒馆会加载这两个目录下的每一个子目录，留在原地会导致插件 id 冲突。
        local backup="$OLD_ROOT/$(basename "$dest")-$(stamp)"
        mkdir -p "$OLD_ROOT"
        warn "$label 已存在但不是 git 仓库，移动到：$backup"
        mv "$dest" "$backup"
    fi

    mkdir -p "$(dirname "$dest")"
    git clone --quiet "$REPO_URL" "$dest" || die "$label 克隆失败，请检查网络"
    ok "$label 安装完成"
}

# 服务端插件：加载器会读仓库根的 package.json（main 指向 server-plugin/index.js）
clone_or_update "$ST_ROOT/plugins/$PLUGIN_ID" "服务端插件"

# 前端扩展
clone_or_update "$ST_ROOT/public/scripts/extensions/third-party/$PLUGIN_ID" "前端扩展"

# ---------------------------------------------------------------------------
# 打开服务端插件开关
# ---------------------------------------------------------------------------

CONFIG="$ST_ROOT/config.yaml"

if [ ! -f "$CONFIG" ]; then
    warn "还没有 config.yaml（酒馆首次启动后才会生成）。
       启动一次酒馆，然后在 config.yaml 里设置 enableServerPlugins: true"
elif grep -qE '^[[:space:]]*enableServerPlugins[[:space:]]*:[[:space:]]*true' "$CONFIG"; then
    ok "enableServerPlugins 已经是 true"
else
    cp "$CONFIG" "$CONFIG.bak-$(stamp)"
    if grep -qE '^[[:space:]]*enableServerPlugins[[:space:]]*:' "$CONFIG"; then
        sed -i.sedtmp -E 's/^([[:space:]]*enableServerPlugins[[:space:]]*:[[:space:]]*).*$/\1true/' "$CONFIG"
        rm -f "$CONFIG.sedtmp"
    else
        printf '\nenableServerPlugins: true\n' >> "$CONFIG"
    fi
    ok "已把 enableServerPlugins 设为 true（原文件已备份为 config.yaml.bak-*）"
fi

printf '\n%s\n' "${C_OK}安装完成。${C_OFF}"
printf '%s\n' "接下来："
printf '%s\n' "  1. 重启 SillyTavern"
printf '%s\n' "  2. 打开「扩展」页面，展开 WebDAV Chat Backup"
printf '%s\n' "  3. 填写 WebDAV 地址、用户名、授权密码，点「测试连接」"
printf '\n%s\n\n' "${C_DIM}以后再次运行本脚本即可更新；酒馆启动时也会自动更新服务端插件。${C_OFF}"
