#!/usr/bin/env bash
#
# SillyTavern Cloud Backup 一键安装 / 更新脚本
#
#   bash <(curl -sL https://cdn.jsdelivr.net/gh/ZZZa-o/sillytavern-cloud-backup@main/install.sh)
#
# 可选：把 SillyTavern 目录作为参数传入
#   bash install.sh ~/SillyTavern
#
# Docker 用户把宿主机上那个装着 config/ data/ plugins/ 的目录传进来即可。
#
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

# ---------------------------------------------------------------------------
# 定位 SillyTavern 目录
#
# 两种布局：
#   native      源码就在这里 —— git clone 装的、启动器装的，或者在容器里跑这个脚本
#   docker-host 宿主机上的挂载目录 —— 只有 config/ data/ plugins/ 这些卷，没有源码
# ---------------------------------------------------------------------------

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

# ---------------------------------------------------------------------------
# 决定三个目标路径
# ---------------------------------------------------------------------------

# 找用户数据目录，多用户时取第一个。用于 docker-host 布局下安放前端扩展。
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
    # 官方 compose 把 extensions/ 映射到容器的 third-party。没映射就退回用户级扩展目录，
    # 它在 data/ 底下，而 data/ 是必然映射出来的。
    if [ -d "$ST_ROOT/extensions" ]; then
        EXT_DEST="$ST_ROOT/extensions/$PLUGIN_ID"
    else
        USER_DIR="$(find_user_dir)" || die "在 $ST_ROOT/data 下找不到用户目录，酒馆至少要启动过一次。"
        EXT_DEST="$USER_DIR/extensions/$PLUGIN_ID"
    fi
    CONFIG="$ST_ROOT/config/config.yaml"
    # plugins/ 不存在，说明容器多半没映射这个卷 —— 装进去也不会被加载
    [ -d "$ST_ROOT/plugins" ] || NEEDS_PLUGIN_MOUNT=1
fi

printf '\n%s\n' "SillyTavern 目录：$ST_ROOT"
printf '%s\n' "布局：$([ "$LAYOUT" = "native" ] && echo "常规安装" || echo "Docker 宿主机挂载目录")"
printf '%s\n\n' "${C_DIM}正在安装 SillyTavern Cloud Backup...${C_OFF}"

# 目录已存在但不是 git 仓库时（比如之前手动复制安装的），旧目录挪到这里。
# 必须位于 plugins/ 与 third-party/ 之外，否则酒馆会把它也当成插件/扩展加载。
OLD_ROOT="$ST_ROOT/_${PLUGIN_ID}-old"

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

# 服务端插件：加载器会读仓库根的 package.json（main 指向 server/index.js）
clone_or_update "$PLUGIN_DEST" "服务端插件"

# 前端扩展
clone_or_update "$EXT_DEST" "前端扩展"

# ---------------------------------------------------------------------------
# 打开服务端插件开关
# ---------------------------------------------------------------------------

# 容器里的 config.yaml 是指向 config/config.yaml 的符号链接。必须改它指向的真身：
# sed -i 那类"写临时文件再改名"的做法会把符号链接本身替换成普通文件，
# 改动就落在容器内部而不是映射出来的卷上，容器一重建全部复原。
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
    # 用重定向而不是 mv：inode 不变，权限与挂载点都保住
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

# ---------------------------------------------------------------------------
# 收尾：把真实写入位置打出来，方便核对
# ---------------------------------------------------------------------------

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
