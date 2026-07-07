# iShell

[![Build installers](https://github.com/Raymanhan/ishell/actions/workflows/release.yml/badge.svg)](https://github.com/Raymanhan/ishell/actions/workflows/release.yml)
[![Release](https://img.shields.io/github/v/release/Raymanhan/ishell?label=release)](https://github.com/Raymanhan/ishell/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

iShell 是一个基于 Tauri + React + Rust 的轻量级 SSH 桌面工作台，用来在一个紧凑界面里管理远程服务器。它集成了服务器资料、交互式终端、SFTP 文件操作、小文件远程编辑、命令历史、主机实时监控和玻璃质感桌面界面。

**语言**：[English](README.md) | 简体中文

## 下载

请从 GitHub Releases 下载最新版安装包：

**[下载 iShell v1.1.6](https://github.com/Raymanhan/ishell/releases/tag/v1.1.6)**

可用安装包：

- **Windows x64**：`.exe` 和 `.msi`
- **macOS Intel**：`.dmg`
- **macOS Apple Silicon**：`.dmg`
- **Linux x64**：`.AppImage`、`.deb`、`.rpm`

## 功能亮点

- **SSH 连接管理**：以文件夹树组织连接，支持搜索、标签、备注和主机颜色。
- **连接顺序持久化**：连接排序和所在分组会保存到本地数据库，重启后保持不变。
- **安全保存密钥信息**：密码通过操作系统钥匙串/Secret Store 保存，不会明文写入导出的连接文件。
- **导入/导出连接**：可导出选中的主机或文件夹为 JSON/ZIP，也可选择用口令加密导出密码。
- **交互式终端**：基于 xterm 的真实 PTY 会话，支持重连、复制标签页、标签排序、跨窗口交接和命令历史。
- **OpenSSH 与 russh 双后端**：macOS/Linux 使用系统 OpenSSH；Windows 使用纯 Rust `russh` 后端和连接池。
- **SFTP 文件浏览器**：支持树形/多列视图、上传、下载、新建文件夹、重命名、删除、右键菜单、软链接识别、终端目录跳转和小文件远程编辑。
- **实时主机监控**：展示 CPU、内存、Swap、磁盘、负载、进程数和网络吞吐，并支持一键复制主机/IP。
- **玻璃灰桌面主题**：透明原生窗口、玻璃质感面板、透明终端背景和平台字体优化。

## 快速开始

1. 打开 [Releases](https://github.com/Raymanhan/ishell/releases/latest)，下载适合当前系统的安装包。
2. 安装并启动 iShell。
3. 点击顶部栏的连接管理入口。
4. 如有需要先创建文件夹，然后添加服务器。
5. 选择密码或 SSH Key 认证方式并保存。
6. 双击服务器，或通过右键菜单连接，打开终端标签页。
7. 通过顶部栏打开 SFTP、实时监控、命令历史、设置或连接管理面板。

## 使用手册

### 连接管理

- 在连接管理面板中搜索、选择、分组、编辑、导入、导出和删除服务器资料。
- 右键服务器可以连接、复制、重命名、编辑、导出或删除。
- 右键文件夹或空白区域可以重命名文件夹、新建文件夹、添加服务器、导入或导出。
- 可多选后执行批量导出或删除。
- 连接会保存 `sortOrder`，列表顺序和分组位置会在重启后保持稳定。
- 分组内连接会按保存顺序排序，顺序相同再按名称自然排序，浏览更可预期。

### 服务器资料

每个服务器资料包含：

- 名称、主机、端口、用户名、分组、标签、颜色和备注
- 认证方式：密码或私钥
- 可选私钥路径
- 保存前可直接测试连接
- 编辑密码时支持显示/隐藏切换

密码和连接资料分开保存。导出连接时，是否导出密码由用户决定；如果导出密码，可以设置口令进行加密保护。

### 终端标签页

- 每台已连接主机会打开一个终端标签页。
- 标签页支持激活、关闭、复制、重连和拖动排序。
- 标签页可以拖出并交接到另一个 iShell 窗口。
- 关闭原生窗口时会先关闭终端标签并隐藏应用，避免后台会话残留。
- 右键标签页可以打开标签级操作菜单。
- 终端字号可在设置中调整。
- 命令历史支持搜索，并可将历史命令粘贴回当前终端。

### SFTP 文件管理

在当前终端标签页中打开文件面板后，可以浏览远程文件系统。

支持操作：

- 在树形详情视图和多列视图之间切换。
- 上传文件到当前目录。
- 下载选中的文件。
- 新建文件夹、重命名条目、删除一个或多个条目。
- 软链接会显示专用图标，删除确认会说明只删除链接本身。
- 可从 SFTP 右键菜单将当前终端跳转到选中的远程目录。
- 打开小型文本文件，在内置编辑器中修改并保存回远程主机。
- 使用路径栏直接跳转到指定目录。

远程文本编辑限制为小文件，避免在远程会话中加载超大文件导致界面卡顿。

### 实时监控

状态面板会通过 SSH 采样当前主机信息：

- CPU 使用率
- 内存和 Swap
- 磁盘挂载
- Load Average
- 进程数量
- 网络上传/下载速度
- 主机/IP 一键复制

### 设置

当前设置包括：

- 玻璃灰桌面主题
- 终端字号

玻璃主题会在可用平台上启用 Tauri 原生窗口效果，并配合透明 xterm 背景，让终端和面板呈现统一的桌面玻璃质感。

## 环境要求

- Node.js 22 或更高版本
- Rust stable 工具链
- 对应平台的 Tauri 系统依赖
- macOS 和 Linux 需要 OpenSSH
- Linux 运行时保存密码需要 Secret Service，例如 GNOME Keyring 或 KWallet。

Linux 下安装 Tauri 所需 WebKitGTK 和打包依赖：

```bash
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf libssl-dev
```

## 开发

```bash
npm install
npm run tauri -- dev
```

仅启动前端预览：

```bash
npm run dev
```

构建和验证：

```bash
npm run build
cd src-tauri
cargo check
cargo check --features force-russh
```

## 本地构建安装包

```bash
npm ci
npm run tauri -- build
```

构建产物位于 `src-tauri/target/*/release/bundle/`。

macOS Intel 和 Apple Silicon 本地构建：

```bash
rustup target add x86_64-apple-darwin
npm run tauri -- build --target x86_64-apple-darwin

rustup target add aarch64-apple-darwin
npm run tauri -- build --target aarch64-apple-darwin
```

## 发布

推送 `v*` 标签后，GitHub Actions 会自动构建 Release。也可以在 GitHub Actions 页面手动运行 **Build installers** 工作流。

```bash
git tag v1.1.6
git push origin v1.1.6
```

发布工作流会构建 Windows、Linux、macOS Intel 和 macOS Apple Silicon 安装包，并把产物上传到 GitHub Release。

## 项目结构

```text
src/
  api/              Tauri IPC 封装和运行环境检测
  components/       React UI 组件
  constants/        主题 token 和共享常量
  features/         功能域类型和工具
  mocks/            浏览器预览用演示数据
  styles/           基础、布局、控件、视图和主题 CSS 模块
  utils/            格式化和过滤工具
  App.tsx           应用状态和流程编排

src-tauri/src/
  commands.rs       Tauri 命令边界
  models.rs         命令共享的可序列化 DTO
  openssh.rs        OpenSSH 参数构造和复用连接辅助
  pool.rs           传输失效和连接池边界
  russh_transport.rs Windows 使用的纯 Rust SSH 传输
  ssh.rs            SSH、SFTP、文件编辑和状态采样
  store.rs          服务器持久化和系统密钥存储
  terminal.rs       交互式终端会话注册表
  time.rs           时间工具
  lib.rs            Tauri 应用组装
```

## 最近更新

- `v1.1.6` 为远程文件编辑器高亮覆盖层保留尾随换行高度，让选择区域与语法高亮继续保持对齐。
- `v1.1.5` 同步远程文件编辑器的高亮层与输入层滚动，并收紧等宽字体渲染，让编辑内容与高亮显示更稳定对齐。
- `v1.1.4` 压缩连接树间距，并为 SFTP 详情视图补充更清晰的面板边界与更稳定的窄窗口滚动表现。
- `v1.1.3` 收紧 SFTP 详情视图列宽，并优化工具栏与文件区域尺寸，让窄窗口下布局更稳定。
- `v1.1.2` 将文件夹重命名从弹窗改为连接树内原地编辑，并保留回车确认、Esc 取消的键盘操作。
- `v1.1.1` 改进连接树选择与重命名行为，增加标签栏可拖拽空白区域，并聚焦液态玻璃主题变体。
- `v1.1.0` 扩展液态玻璃为多种主题变体，改进连接重命名处理，并优化面板与标签周围的玻璃布局表现。
- `v1.0.10` 新增液态玻璃应用主题，并优化服务器编辑弹窗布局，让分组、控件和表单状态更清晰。
- `v1.0.9` 稳定发布打包流程：macOS 在 CI 中先生成 `.app`，再直接创建 DMG 安装包。
- `v1.0.8` 改进原生窗口生命周期：macOS 从 Dock 重新打开时恢复并聚焦主窗口，非 macOS 关闭时使用窗口销毁。
- `v1.0.7` 恢复服务器资料级连接测试，新增连接树复制和重命名操作，并优化密码编辑控件。
- `v1.0.6` 改进连接树拖拽投放稳定性，恢复指针处理下的双击连接行为，并按保存顺序排序分组连接。
- `v1.0.5` 调整原生窗口关闭行为：关闭终端标签、重置临时面板，并干净地隐藏应用。
- `v1.0.4` 增加标签页跨窗口交接，优化连接树拖拽体验，拆分 CSS 模块，并改进 SFTP 软链接识别和删除提示。
- `v1.0.3` 优化 SFTP 选择类型处理，并保持发布元数据与源码一致。
- `v1.0.2` 增加 SFTP 到终端的目录跳转、状态面板主机/IP 复制，并改进终端 ready 状态识别。
- `v1.0.1` 刷新玻璃质感 UI，加入连接顺序持久化，优化终端/SFTP 布局，并补充中英文使用文档。
- `v1.0.0` 增加连接导入/导出、密码加密导出和 SFTP 小文件远程编辑。
- `v0.1.10` 增加终端命令历史建议。
- `v0.1.9` 优化不同平台的终端字体渲染。
- `v0.1.7` / `v0.1.6` 增加并池化 Windows `russh` 终端后端。
- `v0.1.4` 将类 Unix 远程会话切换为系统 OpenSSH 传输。

## 许可证

iShell 使用 MIT License 发布。详见 [LICENSE](LICENSE)。
