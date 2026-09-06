#!/usr/bin/env bash
# SillyTavern Cloud Backup 一键安装与更新。
# 用法：bash install.sh [SillyTavern 目录]
# Docker 使用包含 config/、data/、plugins/ 的宿主机目录。
set -euo pipefail

REPO_URL="https://github.com/ZZZa-o/sillytavern-cloud-backup.git"
PLUGIN_ID="sillytavern-cloud-backup"

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

# 定位 SillyTavern 目录：native 为源码目录，docker-host 为宿主机挂载目录。

is_native_root() {
    [ -n "${1:-}" ] && [ -f "$1/server.js" ] && [ -d "$1/public" ]
}

is_docker_host_root() {
    [ -n "${1:-}" ] && [ ! -f "$1/server.js" ] && [ -d "$1/config" ] && [ -d "$1/data" ]
}

ST_ROOT=""
LAYOUT=""

for candidate in "${1:-}" "${ST_DIR:-}" "$PWD" "$PWD/SillyTavern" "$HOME/SillyTavern" "$HOME/sillytavern"; do
    [ -n "$candidate" ] || continue
    [ -d "$candidate" ] || continue
    if is_native_root "$candidate"; then
        ST_ROOT="$(cd "$candidate" && pwd)"; LAYOUT="native"; break
    fi
    if is_docker_host_root "$candidate"; then
        ST_ROOT="$(cd "$candidate" && pwd)"; LAYOUT="docker-host"; break
    fi
done

if [ -z "$ST_ROOT" ]; then
    die "找不到 SillyTavern 目录。

       常规安装：在酒馆目录里运行，或把路径作为参数传入
         bash install.sh ~/SillyTavern

       Docker：传入宿主机上那个装着 config/ 和 data/ 的目录
         bash install.sh /volume1/docker/sillytavern"
fi

command -v git >/dev/null 2>&1 || die "未安装 git。
       安卓 Termux：pkg install git curl
       Debian/Ubuntu：sudo apt install git
       群晖：套件中心装 Git Server，或改用下面的手动方式
       macOS：brew install git"

# 决定三个目标路径

# 查找用户数据目录，优先 default-user，其次取第一个用户。
find_user_dir() {
    if [ -d "$ST_ROOT/data/default-user" ]; then
        printf '%s\n' "$ST_ROOT/data/default-user"
        return 0
    fi
    local dir
    for dir in "$ST_ROOT"/data/*/; do
        [ -d "$dir" ] || continue
        printf '%s\n' "${dir%/}"
        return 0
    done
    return 1
}

PLUGIN_DEST="$ST_ROOT/plugins/$PLUGIN_ID"
NEEDS_PLUGIN_MOUNT=0

if [ "$LAYOUT" = "native" ]; then
    EXT_DEST="$ST_ROOT/public/scripts/extensions/third-party/$PLUGIN_ID"
    CONFIG="$ST_ROOT/config.yaml"
else
    # 优先安装到 extensions/，其次使用 data/ 下的用户扩展目录。
    if [ -d "$ST_ROOT/extensions" ]; then
        EXT_DEST="$ST_ROOT/extensions/$PLUGIN_ID"
    else
        USER_DIR="$(find_user_dir)" || die "在 $ST_ROOT/data 下找不到用户目录，酒馆至少要启动过一次。"
        EXT_DEST="$USER_DIR/extensions/$PLUGIN_ID"
    fi
    CONFIG="$ST_ROOT/config/config.yaml"
    # 缺少 plugins/ 时标记挂载检查提示。
    [ -d "$ST_ROOT/plugins" ] || NEEDS_PLUGIN_MOUNT=1
fi

printf '\n%s\n' "SillyTavern 目录：$ST_ROOT"
printf '%s\n' "布局：$([ "$LAYOUT" = "native" ] && echo "常规安装" || echo "Docker 宿主机挂载目录")"
printf '%s\n\n' "${C_DIM}正在安装 SillyTavern Cloud Backup...${C_OFF}"

# 旧的非 Git 安装目录统一移入酒馆根目录下的备份目录。
OLD_ROOT="$ST_ROOT/_${PLUGIN_ID}-old"

# 克隆或更新

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
        # 将旧安装目录移入备份目录。
        local backup="$OLD_ROOT/$(basename "$dest")-$(stamp)"
        mkdir -p "$OLD_ROOT"
        warn "$label 已存在但不是 git 仓库，移动到：$backup"
        mv "$dest" "$backup"
    fi

    mkdir -p "$(dirname "$dest")"
    git clone --quiet "$REPO_URL" "$dest" || die "$label 克隆失败，请检查网络"
    ok "$label 安装完成"
}

# 安装或更新服务端插件。
clone_or_update "$PLUGIN_DEST" "服务端插件"

# 安装或更新前端扩展。
clone_or_update "$EXT_DEST" "前端扩展"

# 打开服务端插件开关

# 解析 config.yaml 符号链接的目标路径。
resolve_symlink() {
    local file="$1" target
    [ -L "$file" ] || { printf '%s\n' "$file"; return 0; }
    target="$(readlink "$file")"
    case "$target" in
        /*) printf '%s\n' "$target" ;;
        *)  printf '%s\n' "$(cd "$(dirname "$file")" && cd "$(dirname "$target")" && pwd)/$(basename "$target")" ;;
    esac
}

enable_server_plugins() {
    local file="$1" tmp
    tmp="$(mktemp)"
    if grep -qE '^[[:space:]]*enableServerPlugins[[:space:]]*:' "$file"; then
        sed -E 's/^([[:space:]]*enableServerPlugins[[:space:]]*:[[:space:]]*).*$/\1true/' "$file" > "$tmp"
    else
        { cat "$file"; printf '\nenableServerPlugins: true\n'; } > "$tmp"
    fi
    # 覆盖写入配置，保留原文件 inode、权限和挂载关系。
    cat "$tmp" > "$file"
    rm -f "$tmp"
}

if [ -f "$CONFIG" ] || [ -L "$CONFIG" ]; then
    CONFIG="$(resolve_symlink "$CONFIG")"
fi

if [ ! -f "$CONFIG" ]; then
    warn "还没有 config.yaml（酒馆首次启动后才会生成）。
       启动一次酒馆，然后在 $CONFIG 里设置 enableServerPlugins: true"
elif grep -qE '^[[:space:]]*enableServerPlugins[[:space:]]*:[[:space:]]*true' "$CONFIG"; then
    ok "enableServerPlugins 已经是 true"
else
    cp "$CONFIG" "$CONFIG.bak-$(stamp)"
    enable_server_plugins "$CONFIG"
    ok "已把 enableServerPlugins 设为 true（原文件已备份为 config.yaml.bak-*）"
fi

# 输出安装路径与后续操作。

printf '\n%s\n' "${C_OK}安装完成。${C_OFF}"
printf '%s\n' "实际写入："
printf '%s\n' "  服务端插件  $PLUGIN_DEST"
printf '%s\n' "  前端扩展    $EXT_DEST"
printf '%s\n' "  配置文件    $CONFIG"

if [ "$NEEDS_PLUGIN_MOUNT" = "1" ]; then
    printf '\n%s\n' "${C_WARN}注意：$ST_ROOT/plugins 是本脚本刚建的。${C_OFF}"
    printf '%s\n' "容器如果没有把它映射到 /home/node/app/plugins，服务端插件永远不会被加载。"
    printf '%s\n' "请在 Docker 配置里加上这条映射再重启容器："
    printf '%s\n' "  $ST_ROOT/plugins  →  /home/node/app/plugins"
fi

printf '\n%s\n' "接下来："
if [ "$LAYOUT" = "native" ]; then
    printf '%s\n' "  1. 重启 SillyTavern（服务端插件只在启动时加载一次）"
else
    printf '%s\n' "  1. 重启容器（服务端插件只在启动时加载一次）"
fi
printf '%s\n' "  2. 打开「扩展」页面，展开「酒馆云备份」"
printf '%s\n' "  3. 填写 WebDAV 地址、用户名、授权密码，点「保存配置」再点「测试连接」"
printf '%s\n' "  4. 点「范围」挑要备份的内容，然后点「上传到云端」"
printf '\n%s\n\n' "${C_DIM}以后再次运行本脚本即可更新。${C_OFF}"
