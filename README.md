# WebDAV Chat Backup for SillyTavern

一个用于 SillyTavern 的 WebDAV 聊天同步与备份扩展。它把前端扩展面板和一个很小的服务端辅助插件组合在一起，避免浏览器直连 WebDAV 时常见的跨域问题。

扩展入口在 SillyTavern 的“扩展”页面内。WebDAV 地址由用户手动填写，不内置坚果云、InfiniCLOUD 或其他服务商的固定地址。

## 功能

- **多端增量同步**：按文件双向同步，两台以上设备可以共用同一份聊天记录。
- **按角色分文件夹**：远端保持 `chats/<角色>/<聊天>.jsonl` 的结构，可以直接在网盘里按角色浏览。
- **聊天记录自动快进**：`.jsonl` 是逐行追加的，一方是另一方的前缀时自动取更长的那份，不产生冲突。
- **冲突保留双份**：真正分叉时两个版本都保留，不会有一方被悄悄覆盖。
- **删除同步**：用墓碑记录删除意图，删掉的聊天不会被另一台设备推回来。
- **并发保护**：远端锁文件，避免两台设备同时同步互相踩踏。
- zip 全量快照与恢复，作为灾难恢复兜底。
- 自动执行，支持按时间间隔和聊天变化触发。
- WebDAV 授权密码通过 SillyTavern secrets 保存。
- 支持坚果云、InfiniCLOUD，以及兼容标准 WebDAV 的服务。

## 同步范围

可在扩展面板中勾选：

- `单人聊天`：`chats/` 下的聊天记录。
- `群聊记录与群组`：`group chats/` 与 `groups/`。
- `角色卡`：`characters/` 下的角色卡文件。
- `世界书`：`worlds/`。
- `设置`：`settings.json`，**只进 zip 快照，不参与同步**。

角色卡是“角色本身的设定文件”，聊天记录是“你和这个角色聊出来的历史”。两者互不包含，建议都勾上。

`settings.json` 刻意排除在同步之外：它包含 API 地址、模型选择等设备相关配置，跨设备互相覆盖会让另一台直接不可用。需要迁移设置时用 zip 快照手动恢复。

## 安装

这个扩展包含两部分：前端扩展和服务端辅助插件。

仓库地址： [https://github.com/ZZZa-o/sillytavern-webdav-chat-backup](https://github.com/ZZZa-o/sillytavern-webdav-chat-backup)

### 方式一：一键安装（推荐，Termux / Linux / macOS）

在装有 SillyTavern 的机器上执行：

```bash
bash <(curl -sL https://cdn.jsdelivr.net/gh/ZZZa-o/sillytavern-webdav-chat-backup@main/install.sh)
```

国内访问 GitHub 不畅时上面的 jsDelivr 链接通常更稳；也可以用原始链接：

```bash
bash <(curl -sL https://raw.githubusercontent.com/ZZZa-o/sillytavern-webdav-chat-backup/main/install.sh)
```

脚本会自动完成：找到 SillyTavern 目录、安装前端扩展与服务端插件、把 `config.yaml` 里的 `enableServerPlugins` 设为 `true`（改动前会备份）。装好后重启 SillyTavern 即可。

要点：

- Termux 用户先确保装了 git：`pkg install git`
- 必须用 `bash` 而不是 `sh` 执行。
- 脚本没找到酒馆目录时，把路径作为参数传进去：`bash install.sh ~/SillyTavern`
- **再次运行同一条命令就是更新**。
- 如果之前是手动复制安装的，脚本会把旧目录移到 `_webdav-chat-backup-old/` 再重新安装。旧目录必须挪出 `plugins/`，否则酒馆会把它当成第二个插件加载并报 id 冲突。

### 方式二：两条 git 命令

```bash
cd ~/SillyTavern
git clone https://github.com/ZZZa-o/sillytavern-webdav-chat-backup.git plugins/webdav-chat-backup
git clone https://github.com/ZZZa-o/sillytavern-webdav-chat-backup.git public/scripts/extensions/third-party/webdav-chat-backup
```

然后在 `config.yaml` 里设置 `enableServerPlugins: true` 并重启。

服务端插件可以直接 clone 整个仓库，是因为仓库根的 `package.json` 里 `main` 指向 `server-plugin/index.js`，SillyTavern 的插件加载器会优先按它解析入口。

### 方式三：手动复制

1. 把本项目整个文件夹复制到：

   ```text
   SillyTavern/public/scripts/extensions/third-party/webdav-chat-backup
   ```

2. 把 `server-plugin/index.js` 复制到：

   ```text
   SillyTavern/plugins/webdav-chat-backup/index.js
   ```

3. 打开 SillyTavern 的 `config.yaml`，确认服务端插件已启用：

   ```yaml
   enableServerPlugins: true
   ```

4. 重启 SillyTavern。

5. 进入 SillyTavern 的“扩展”页面，展开 `WebDAV Chat Backup`。

### 关于自动更新

用方式一或方式二安装时，插件目录本身就是一个 git 仓库。SillyTavern 的 `enableServerPluginsAutoUpdate` 默认为 `true`，会在每次启动时自动拉取服务端插件的更新。不想要这个行为就在 `config.yaml` 里关掉它。

手动复制安装（方式三）不具备自动更新能力。

## 使用

### 首次配置

1. 填写 WebDAV 地址、用户名、远端目录。
2. 在“授权密码”中填写 WebDAV 授权密码，然后点击“保存密码”。
3. 点击“保存配置”，再点击“测试连接”。
4. 勾选需要同步的内容。
5. 在“本机名称”里填一个能认出这台设备的名字，例如 `台式机`、`笔记本`。

### 多端同步

在两台设备上填**相同的 WebDAV 地址和远端目录**，**不同的本机名称**，然后：

1. 点击“预览变更”，先看清楚会上传、下载还是删除哪些文件。
2. 确认无误后点击“开始同步”。

第一次同步时，先在一台设备上点“开始同步”把数据推上去，另一台再同步拉下来。之后两边都可以随时双向同步。

同步完成后如果有文件被下载或改动，请**刷新一次 SillyTavern 页面**再继续聊天。否则浏览器里还是同步前的旧内容，下次保存会把刚拉下来的内容覆盖掉。

### 同步方向

- **双向同步**：默认，两端互相补齐。
- **仅上传**：本机内容覆盖远端，不改动本机任何文件。
- **仅下载**：远端内容覆盖本机，不改动远端任何文件。

拿不准的时候先点“预览变更”，它不会写入任何数据。

## 远端目录结构

```text
<远端目录>/
├─ .st-sync/
│  ├─ index.json        同步索引：每个文件的哈希与来源设备
│  ├─ tombstones.json   删除墓碑
│  └─ lock.json         同步锁
├─ chats/
│  └─ <角色名>/
│     └─ <聊天名>.jsonl
├─ group chats/
├─ groups/
├─ characters/
├─ worlds/
└─ snapshots/
   └─ st-webdav-backup-YYYYMMDD-HHMMSS.zip
```

角色目录名与 SillyTavern 本地的目录名一致，中文角色名原样保留。只有当角色名包含 `\ / : * ? " < > |` 这类文件系统非法字符时才会被替换，并追加一段短哈希避免不同角色撞名。

## 冲突是怎么处理的

同步使用**三方比较**：本机、远端、上次同步时的基线。只有本机和远端**都**相对基线发生了变化，才算真冲突。只有一边变化时直接同步过去，不会打扰你。

聊天记录是 `.jsonl`，每行一条消息，正常使用下只追加。所以：

- 一方是另一方的行前缀 → 自动快进，取更长的那份，不算冲突。
- 两边在同一位置写了不同内容 → 真分叉。此时远端版本占用原文件名，本机版本另存为 `<原名> (冲突 <设备名> <时间>).jsonl` 并一并上传。两台设备最终都会拥有两个版本，可以自己对照取舍。

改写已有消息（包括 swipe）会让公共前缀提前中断，因此会被保守地判为分叉。这是刻意的：宁可多留一个分支，也不要悄悄丢内容。

角色卡和世界书没有行级语义，无法合并。冲突时远端优先，本机原文件放进保护副本目录。

## 安全网

任何覆盖或删除本机文件之前，原文件都会先复制到：

```text
SillyTavern/backups/webdav-sync-<时间戳>/
```

同步结束后面板会显示这个目录的完整路径。zip 快照恢复也有同样的保护机制，目录名是 `webdav-restore-<时间戳>`。

## 自动执行

“自动执行”可以选择动作：

- **增量同步**：按间隔自动做双向同步。
- **zip 快照**：按间隔自动打全量包。

建议只在主力设备上开启自动执行。两台设备都开自动同步不会损坏数据（有锁和冲突保留机制），但会产生较多冲突分支。

## 坚果云使用说明

坚果云需要使用 WebDAV 的“应用授权密码”，不要直接使用账号登录密码。

1. 注册并登录坚果云账号。
2. 在坚果云账号设置中找到“安全选项”或“第三方应用管理”相关页面。
3. 添加应用并生成应用授权密码。
4. 在本扩展里手动填写坚果云提供的 WebDAV 地址、账号和应用授权密码。

坚果云官方教程： [如何开启 WebDAV 并获取应用授权密码](https://help.jianguoyun.com/?p=2064)

本扩展不会内置坚果云地址。请以坚果云页面显示的 WebDAV 地址为准，复制后手动填入。

## InfiniCLOUD 和其他 WebDAV 服务

InfiniCLOUD、NAS、Nextcloud、ownCloud、Cloudreve 等服务只要提供标准 WebDAV 地址，通常都可以使用。

请在服务商页面获取 WebDAV 地址、用户名、WebDAV 密码或应用授权密码，然后在扩展中手动填写。

目录遍历只使用 `Depth: 1` 逐层递归，不依赖 `Depth: infinity`，因此坚果云这类支持不完整的服务也能正常工作。

## 数据与安全

- 普通配置保存在 SillyTavern 的扩展设置中。
- WebDAV 授权密码保存在 SillyTavern secrets 中，键名为 `webdav_chat_backup_password`。
- 本机同步基线保存在 `<用户数据目录>/.webdav-chat-backup/sync-base.json`。
- 同步与快照都不会包含 `secrets.json`。
- zip 快照文件名格式为 `st-webdav-backup-YYYYMMDD-HHMMSS.zip`，存放在远端 `snapshots/` 下。

## 开发

同步核心逻辑（三方比较、快进合并、墓碑、路径安全化）有单元测试：

```bash
NODE_PATH=<SillyTavern 目录>/node_modules node tools/sync-logic-test.js
```

## 常见问题

### 为什么需要服务端辅助插件？

很多 WebDAV 服务不允许浏览器网页直接跨域访问。坚果云的 `OPTIONS` 预检请求会返回 401，且不带任何 `Access-Control-Allow-*` 响应头，浏览器直连必然被拦。

SillyTavern 自带的 `enableCorsProxy` 也不适用：它的中间件会对 `PUT` 请求体做 `JSON.stringify`，原始文件字节会被破坏，无法用来上传文件。所以服务端辅助插件是必需的。

### 能只装前端吗？

不能，原因见上。

### 同步会不会把我的聊天弄丢？

任何覆盖和删除之前都会先在 `backups/` 下留保护副本，真冲突时两个版本都保留。担心的话先用“预览变更”看清楚，它不写入任何数据。

### 同步后聊天没变化？

刷新一次 SillyTavern 页面。浏览器里缓存的是同步前的内容。

### 备份失败怎么办？

先点击“测试连接”。如果测试失败，通常是 WebDAV 地址、用户名、授权密码或远端目录权限有问题。坚果云用户请确认使用的是应用授权密码。
