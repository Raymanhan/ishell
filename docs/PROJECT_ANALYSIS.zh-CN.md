# iShell 项目分析与推广素材

本文依据仓库当前 `1.5.12` 版本的源码、配置和工作流整理。功能实现与推广建议分别说明；平台安装体验、性能和实际服务器兼容性仍需通过对应环境验证。

## 1. 项目定位与推广主线

**建议定位：带 AI 服务器助手的一站式 SSH 桌面工作台。**

最值得讲清楚的价值，是把一次远程维护需要的操作连起来：管理连接，打开终端，传输文件，修改配置，检查日志，再查看主机状态。用户可在同一工作台中完成这些步骤。

AI 是当前版本的核心能力：内置助手连接用户配置的 OpenAI 兼容 API，可基于当前 SSH 连接执行命令、读写文件、生成并运行代码，提供权限确认、操作结果、历史对话与上下文压缩。另一个可展示的场景是在远程项目中运行 Codex、Claude Code 等 CLI，配合分屏查看差异、测试和日志。

宣传顺序建议为：

1. **内置 AI 服务器助手**：自然语言描述目标，助手执行与验证操作，展示步骤，并由权限模式控制执行。
2. **完整工作流**：终端、文件、日志和监控集中在一个工作台，说明为什么值得下载。
3. **多机效率**：四窗格、广播输入和命令片段组合演示，让用户看到具体操作收益。
4. **视觉体验**：九套主题、玻璃界面和可调透明度用于封面与短视频开场。
5. **使用条件**：三大桌面平台、本地保存资料、MIT 开源、无需注册 iShell 账号；内置 AI 需配置模型 API，外部 AI CLI 则按相应工具完成登录与配置。

“轻量”可以作为设计方向，但目前没有安装体积、常驻内存、启动时间等对照数据，不宜给出性能倍数或最低资源占用的承诺。

## 2. 受众与适合的切入场景

| 受众 | 常见需求 | 最值得展示的能力 |
| --- | --- | --- |
| 希望用自然语言维护服务器的用户 | 描述排障、部署和巡检目标，并检查操作结果 | 内置 AI 助手、工具卡片、权限模式、历史与压缩 |
| 使用终端型 AI 编程工具的开发者 | 在远程项目中使用 Codex、Claude Code，同时检查改动和测试 | AI CLI 配色适配、四窗格、文件检查、日志与监控 |
| 后端与全栈开发者 | 部署、改配置、查日志、连接内网数据库 | 文件编辑、独立日志窗口、本地转发 |
| 运维与 SRE | 多机巡检、对照状态、维护跳板链路 | 分屏、广播、片段、跳板机、进程排行 |
| 独立开发者与自托管用户 | 管理云主机、家庭服务器和不同项目 | 连接分组、可视化文件操作、状态面板 |
| 远程 GPU 用户 | 查看任务运行、显存占用和日志 | GPU/显存指标、Top 进程、独立日志窗口 |
| 偏好桌面工具的终端用户 | 在不同系统获得相近的工作流程 | 跨平台包、主题、快捷键、窗口交接 |

GPU 用户是可覆盖的细分人群：当前能力侧重观察资源与日志，不包含任务调度、训练管理或模型服务管理。团队治理场景也应单独评估，当前代码主要实现个人本地工作台。

## 3. 功能盘点与用户价值

| 功能 | 已实现的内容 | 用户价值与演示角度 | 主要代码依据 |
| --- | --- | --- | --- |
| 内置 AI 服务器助手 | OpenAI 兼容 API、模型/思考档位、Shell/读写文件/代码工具、权限确认、任务取消、加密历史、自动/手动压缩 | 用自然语言组织服务器任务，并核对步骤和输出 | [AiPanel.tsx](../src/components/AiPanel.tsx)、[AI 后端](../src-tauri/src/ai/mod.rs)、[tools.rs](../src-tauri/src/ai/tools.rs)、[context.rs](../src-tauri/src/ai/context.rs) |
| AI CLI 配色适配 | 响应 OSC 11 背景色查询，按当前主题报告实际底色，响应只发送到发起查询的会话 | 改善 Codex、Claude Code 等工具在透明或浅色主题中的输入输出可读性 | [TerminalPane.tsx](../src/components/TerminalPane.tsx)、[theme.ts](../src/constants/theme.ts) |
| 远程 AI 编程工作流 | 通用 SSH/PTY 终端、四窗格、标签与窗口、文件与日志工具组合使用；AI CLI 由用户在远端启动 | 并排处理 AI 对话、git diff、测试和运行输出 | [terminal.rs](../src-tauri/src/terminal.rs)、[panes.ts](../src/features/shell/panes.ts)、[App.tsx](../src/App.tsx) |
| 连接管理 | 文件夹、搜索、标签、颜色、备注、多选、拖动排序、复制、重命名、测试连接 | 按项目或环境管理服务器，减少找错主机的机会 | [ConnectionManager.tsx](../src/components/ConnectionManager.tsx)、[useConnections.ts](../src/features/connections/useConnections.ts) |
| SSH 认证与跳板 | 密码、私钥、每跳独立凭据，最多三级跳板，检测循环链 | 用保存好的资料进入内网环境 | [ServerEditor.tsx](../src/components/ServerEditor.tsx)、[store.rs](../src-tauri/src/store.rs)、[openssh.rs](../src-tauri/src/openssh.rs) |
| 交互式终端 | xterm、PTY、重连、复制标签、搜索 | 满足持续交互和查看输出的日常需要 | [TerminalPane.tsx](../src/components/TerminalPane.tsx)、[terminal.rs](../src-tauri/src/terminal.rs) |
| 标签与窗口 | 标签排序、拖出窗口、跨窗口交接、输出快照补齐 | 按任务或显示器安排会话 | [TabBar.tsx](../src/components/TabBar.tsx)、[windowHandoff.tsx](../src/features/shell/windowHandoff.tsx) |
| 分屏 | 每标签最多四窗格，嵌套左右/上下布局，拖动比例，面板跟随焦点 | 同屏比较服务与环境 | [panes.ts](../src/features/shell/panes.ts)、[App.tsx](../src/App.tsx) |
| 广播输入 | 选择目标会话并镜像终端输入，可与片段配合 | 多台主机执行相同巡检输入 | [BroadcastBar.tsx](../src/components/BroadcastBar.tsx)、[TerminalPane.tsx](../src/components/TerminalPane.tsx) |
| 命令片段 | 名称、说明、命令、多行输入、自动回车开关、本地保存 | 将常用检查命令积累为可复用片段 | [SnippetsPanel.tsx](../src/components/SnippetsPanel.tsx)、[useSnippets.ts](../src/features/snippets/useSnippets.ts) |
| 命令历史与搜索 | 历史存储、搜索、候选回填；终端搜索支持正则/大小写/全字 | 更快复用输入和定位当前缓冲区中的输出 | [CommandHistoryPanel.tsx](../src/components/CommandHistoryPanel.tsx)、[TerminalSearchBar.tsx](../src/components/TerminalSearchBar.tsx) |
| 文件浏览 | 树形详情、多列浏览、路径跳转、多选、右键菜单、软链接 | 可视化定位远端文件 | [SftpBrowser.tsx](../src/components/SftpBrowser.tsx)、[sftp.rs](../src-tauri/src/ssh/sftp.rs) |
| 传输队列 | 文件/文件夹上传、拖放、直接/压缩下载、进度、停止任务 | 上传部署资料，下载日志与目录 | [useUploadQueue.ts](../src/features/sftp/useUploadQueue.ts)、[useDownloadQueue.ts](../src/features/sftp/useDownloadQueue.ts)、[download.rs](../src-tauri/src/ssh/download.rs) |
| 上传保护 | 文件夹同名替换确认、暂存、提交、失败回滚、目标变化检查 | 在确认覆盖范围后更新目录 | [upload.rs](../src-tauri/src/ssh/upload.rs)、[upload_scripts.rs](../src-tauri/src/ssh/upload_scripts.rs) |
| 远程编辑 | 最大 1 MiB、UTF-8 文本、语法高亮、保存回远端 | 就地修改配置与脚本 | [FileEditorModal.tsx](../src/components/FileEditorModal.tsx)、[sftp.rs](../src-tauri/src/ssh/sftp.rs)、[highlight.tsx](../src/utils/highlight.tsx) |
| 实时日志 | 独立窗口、初始尾行、暂停跟随、回底部、清空、重启、关闭清理 | 主工作台继续操作时持续观察日志 | [TailViewer.tsx](../src/components/TailViewer.tsx)、[tail_monitor.rs](../src-tauri/src/tail_monitor.rs) |
| 资源与进程监控 | CPU、内存、Swap、负载、磁盘、网络、Top 5 CPU/内存进程、条件性 GPU/显存指标 | 从“服务慢”进一步定位到资源与进程 | [StatusDashboard.tsx](../src/components/StatusDashboard.tsx)、[monitor.rs](../src-tauri/src/ssh/monitor.rs)、[process_monitor.rs](../src-tauri/src/process_monitor.rs) |
| 端口转发 | 本地、远程、SOCKS5、状态/错误、连接时自动启动、跳板支持 | 可视化管理数据库和内网服务访问通道 | [PortForwardsPanel.tsx](../src/components/PortForwardsPanel.tsx)、[tunnel.rs](../src-tauri/src/tunnel.rs)、[russh_transport.rs](../src-tauri/src/russh_transport.rs) |
| 配置迁移与本地保存 | JSON/ZIP 导入导出、凭据可选加密导出；SQLite 与本地加密凭据 | 迁移个人连接资料并控制是否携带凭据 | [commands.rs](../src-tauri/src/commands.rs)、[store.rs](../src-tauri/src/store.rs) |
| 外观与 CLI 配色 | 九主题、16 色调色板、透明度、字号、顶部栏；OSC 背景色报告 | 展示长期使用时的视觉与交互体验 | [theme.ts](../src/constants/theme.ts)、[SettingsModal.tsx](../src/components/SettingsModal.tsx)、[TerminalPane.tsx](../src/components/TerminalPane.tsx) |
| 安装与更新 | Windows/Linux x64、macOS 双架构构建；应用内检查与签名更新流程 | 降低安装和后续更新的操作成本 | [release.yml](../.github/workflows/release.yml)、[useUpdater.ts](../src/features/updater/useUpdater.ts)、[tauri.conf.json](../src-tauri/tauri.conf.json) |

## 4. 推荐优先展示的六个亮点

### 内置 AI 助手：从自然语言目标到可查看的执行步骤

先配置 OpenAI 兼容模型服务，再在测试服务器上提出一个明确任务，例如“检查磁盘空间，找出占用较大的目录并总结”。录制助手生成步骤、执行低风险查询、展示工具输出的过程。随后切换“执行前确认”，在临时测试目录中演示一次文件修改，展示目标、完整操作内容、确认与结果。

| AI 相关卖点 | 具体实现与价值 | 代码依据 |
| --- | --- | --- |
| 服务器工具执行 | Shell、读写文件、生成并执行 Python/Shell/Node.js 代码，适合部署、排查与巡检 | [tools.rs](../src-tauri/src/ai/tools.rs)、[runner.py](../src-tauri/src/ai/runner.py) |
| 自选模型与思考程度 | OpenAI 兼容接口、模型发现、思考档位元数据及手动填写选项 | [provider.rs](../src-tauri/src/ai/provider.rs)、[metadata.rs](../src-tauri/src/ai/metadata.rs)、[AiSettings.tsx](../src/components/AiSettings.tsx) |
| 四种权限模式 | 仅建议、逐次确认、自动低风险、完全访问，匹配不同使用需求；规则决定确认，SSH 账号权限仍决定可操作范围 | [permissions.rs](../src-tauri/src/ai/permissions.rs)、[mod.rs](../src-tauri/src/ai/mod.rs) |
| 可检查的过程 | 流式回复、分组工具卡片、步骤说明、完整命令/代码、输出、真实退出码和停止操作 | [AiPanel.tsx](../src/components/AiPanel.tsx)、[useAi.ts](../src/features/ai/useAi.ts) |
| 长对话与历史 | 按服务器保存加密对话，支持恢复查看、继续、编辑重发、自动压缩与手动 /compact | [history.rs](../src-tauri/src/ai/history.rs)、[context.rs](../src-tauri/src/ai/context.rs)、[slashCommands.ts](../src/features/ai/slashCommands.ts) |
| AI CLI 配套 | 在远程终端运行用户已安装的 Codex、Claude Code，以四窗格查看会话、差异、测试和日志，终端报告实际背景色 | [TerminalPane.tsx](../src/components/TerminalPane.tsx)、[theme.ts](../src/constants/theme.ts)、[panes.ts](../src/features/shell/panes.ts) |

建议宣传用语：**“描述你的服务器任务，让 AI 帮你执行、排查并展示结果。”** 同时演示权限选择和工具步骤，帮助用户理解如何控制执行。

内置助手无需外部 AI CLI，模型 API 由用户配置。服务需要支持相应的工具调用能力，任务信息及必要输出会发送到该服务。远端工具执行需要 Python 3，运行 JavaScript 还需 Node.js。停止或编辑对话不会撤销已经执行的操作；任务不会在重启后自动恢复执行。外部 CLI 的多会话分屏是另一条工作流，各会话由用户分别操作。

### 完整的远程维护流程

示例：上传一个示例配置文件，在编辑器中修改参数，切到终端执行检查，再打开日志窗口观察结果，并查看状态面板。这个演示能让首次接触项目的人理解各模块为什么需要放在一起。

### 分屏、广播与片段组合

单独介绍分屏，用户看到的是布局；加入广播与片段后，才能展示“同一条检查输入发送到多个环境，结果并排比较”。建议使用 `hostname`、`uptime`、`df -h` 等只读命令录制。

广播同步的是输入；各会话的执行时序、Shell 状态和命令结果仍然独立。多行片段逐行发送，即使关闭最后的自动回车，中间换行也可能触发执行。它适合交互式多机操作，不能据此承诺带统一结果汇总的自动化发布。

### 独立日志窗口与资源监控

主窗口保留终端操作，日志在独立窗口持续跟随，再用 CPU/内存排行解释排障路径。这比逐项罗列监控字段更容易让人记住。GPU 场景应在确有驱动指标的测试主机上演示。

### 跳板机与可视化转发

以“从本机访问只允许内网访问的数据库”为例，展示保存跳板、添加本地转发、观察运行状态。三种转发是实用深度功能，适合技术社区长文或第二条演示视频。

### 九套主题与细节体验

首屏或封面用一深一浅两套主题即可，终端、文件和监控应有可读内容。透明度、浮动卡片和配色是吸引点击的素材，正文继续解释实际工作流程。

## 5. 架构与工程成熟度判断

**已有的工程基础：**

- 功能贯通了 React UI、Tauri IPC 与 Rust 后端，终端、上传、下载、日志、转发都有具体的会话或任务管理。
- macOS/Linux 走系统 OpenSSH，Windows 使用 russh；批量传输采用独立 SSH 连接，减少与交互流量争用同一连接。
- 上传实现了目录替换确认、暂存与回滚等保护，主机密钥有持久化检查，说明可靠性已经进入实现范围。
- [CI](../.github/workflows/ci.yml) 配有前端构建、Rust 格式检查、Clippy 和两条后端路径的测试；[发布工作流](../.github/workflows/release.yml) 覆盖四个平台/架构组合，并配置了更新包签名流程。
- 已有针对窗口预览生命周期、监控解析、传输路径等行为的测试实现；仍需运行结果才能确认当前环境中的通过状态。

**推广时需要区分的层次：**

| 层次 | 当前可以得出的结论 | 尚需补充的证据 |
| --- | --- | --- |
| 功能实现 | 核心能力存在前后端实现 | 不同服务器与真实网络下的交互验证 |
| 平台覆盖 | 工作流配置了 Windows、Linux、macOS 双架构安装包 | 对应 Release 资产和各平台安装/启动记录 |
| 更新流程 | 有签名验证、清单生成和更新 UI | 对应版本实际发布签名包后的升级验证 |
| 轻量与速度 | 使用 Tauri 与 Rust 架构 | 安装体积、启动时间、空闲/多会话内存和传输基准 |
| 安全存储 | 保存的凭据使用 AES-256-GCM 加密 | 更强的密钥托管和独立安全评估不属于当前已证实能力 |

项目适合围绕 AI 辅助的个人远程维护工作流开始推广。更大的用户规模、稳定性等级或性能领先结论，需要真实使用与测量来支持。

## 6. 需要准确表述的边界

| 容易产生的误解 | 当前实际情况与推荐表述 |
| --- | --- |
| 密码保存在系统钥匙串 | 当前为 SQLite 密文加本地 `secret.key` 主密钥；旧 README 的钥匙串/Secret Service 描述已过时 |
| 所有本地数据、整个导出文件都加密 | 保存的凭据、AI 设置及对话/工具结果加密；连接元数据、普通命令历史与片段不因此获得加密 |
| SFTP-only 服务器都能使用文件面板 | UI 名称为 SFTP，但操作使用 SSH Shell/Python/tar，目录列表等需要远端 Python 3 |
| 可以在线编辑任意文件 | 编辑限制为不超过 1 MiB 的 UTF-8 文本，不是大型文件编辑器 |
| 文件夹上传会合并或增量同步 | 同名目录确认后完整替换，远端独有条目会被移除；没有断点续传或双向同步的依据 |
| 日志暂停会停止采集、形成永久日志库 | 暂停的是跟随滚动；查看器有内存缓冲区上限，未实现持久日志检索服务 |
| GPU 监控适用于所有显卡与所有系统 | 当前依赖兼容的 nvidia-smi/DRM 指标，展示的是汇总指标，不能宣传为完整逐卡管理 |
| 广播即自动化编排 | 同步交互输入，未提供统一任务状态、结果汇总或发布审批 |
| 内置 AI 与 Codex/Claude CLI 是同一功能 | 内置助手直接调用用户配置的 OpenAI 兼容 API 并执行服务器工具；外部 CLI 另在远端安装配置，通过终端使用 |
| 配置导出等于完整备份 | 当前导出连接资料与可选凭据；私钥文件、历史、片段和转发规则不随连接导出打包 |
| 跨平台代表支持任意远端操作系统 | 客户端有多平台构建，远端文件/监控操作主要面向 Unix 工具环境 |
| 界面仅有中文 | 当前已提供简体中文、繁體中文、English，可在设置中实时切换 |
| 自动更新等于所有包都已完成系统公证 | 应用更新包签名与操作系统代码签名、公证是不同环节；Linux 应用内更新只适用于 AppImage |

本次 README 已同步修正凭据存储、Linux Secret Service 依赖、开发依赖与运行依赖混用、下载版本硬编码等问题，并保留原有版本记录以兼容更新清单脚本。

## 7. 可直接使用的推广文案

### 一句话介绍

> iShell：带 AI 服务器助手的一站式 SSH 工作台。

### GitHub About 建议

> SSH workbench with a built-in AI server assistant: run commands, work with files, and troubleshoot with visible steps and permission controls. Windows, macOS & Linux. MIT.

### 中文短介绍

> iShell 是一款内置 AI 服务器助手的开源 SSH 桌面工作台。用自然语言描述部署、巡检或排障任务，助手可执行命令、读写文件、编写并运行代码，逐步展示输出，并提供四种权限模式、加密对话历史与上下文压缩。支持自选 OpenAI 兼容模型 API，以及终端分屏、文件传输、实时日志、资源监控、跳板机和端口转发。提供 Windows、macOS、Linux 安装包与三种界面语言，以 MIT 协议开源。

### 社区首发帖示例

> 最近在做一个 SSH 桌面工具 iShell，想把日常远程维护的几件事放到一个工作台里：连接服务器、敲命令、上传文件、改配置、跟日志和看资源占用。
>
> 现在还内置了 AI 服务器助手：配置自己的 OpenAI 兼容 API 后，可以直接用自然语言提出任务，让它通过 SSH 执行命令、读写文件或运行代码。每一步有工具卡片展示内容与结果，也可以选择仅建议、逐次确认、自动低风险或完全访问。历史对话加密保存在本机，长对话支持自动和手动压缩。
>
> 如果你在服务器上用 Codex、Claude Code，也可以分屏查看 CLI 会话、git diff、测试与日志。
>
> 目前支持最多四窗格分屏、向选定会话广播输入、保存常用命令片段，也有跳板机和本地/远程/SOCKS5 转发。文件面板可以上传下载文件与目录、编辑小型 UTF-8 文本，日志可以单独开窗跟随。界面提供九套主题和可调透明度。
>
> 项目基于 Tauri、React 和 Rust，提供 Windows、macOS、Linux 安装包，以 MIT 协议开源。欢迎试用，也欢迎反馈实际服务器环境中的问题。
>
> 源码：https://github.com/Raymanhan/ishell
>
> 下载：https://github.com/Raymanhan/ishell/releases/latest

### 标题备选

- 给 SSH 工作台加上 AI 助手：用自然语言排障，逐步查看命令和结果
- 在远程服务器上用 AI 编程：把 Codex、Claude Code 与测试日志放在同一个工作台
- 我做了一个开源 SSH 工作台：终端、文件、日志和监控放在一起
- 用 iShell 分屏管理多台服务器，广播输入还能复用常用命令
- 九套主题的 SSH 桌面工具，支持跳板机、端口转发与实时日志

## 8. 素材与首轮推广建议

### 60 秒演示脚本

| 时间 | 画面与操作 | 让用户理解的价值 |
| --- | --- | --- |
| 0–8 秒 | 主窗口展示终端、文件与监控，切换一次深浅主题 | 看清产品是什么、界面能放什么 |
| 8–20 秒 | 在两个测试主机上分屏，广播 `hostname` 或 `uptime` | 同一输入，多机对照 |
| 20–35 秒 | 从片段发送只读检查命令，打开并编辑示例配置 | 命令与文件工作在一起 |
| 35–50 秒 | 打开独立日志窗口，展示进程和网络监控 | 操作后立即观察结果 |
| 50–60 秒 | 显示平台支持、仓库和下载入口 | 给出明确的试用路径 |

### 内置 AI 助手的 60 秒演示

| 时间 | 画面与操作 | 让用户理解的价值 |
| --- | --- | --- |
| 0–10 秒 | 连接测试服务器，打开 AI 侧栏并选择模型和权限 | 清楚展示内置助手入口 |
| 10–25 秒 | 用自然语言提出磁盘巡检任务，展开工具步骤 | 从目标到具体命令与输出 |
| 25–40 秒 | 切到逐次确认模式，演示在临时目录修改示例文件 | 用户可检查并决定是否执行 |
| 40–50 秒 | 查看结果并切换对话历史，展示 /compact 菜单 | 展示连续使用与上下文管理 |
| 50–60 秒 | 展示下载入口、模型服务配置与平台支持 | 提供明确的试用路径 |

### 建议准备的素材

- 一段内置 AI 助手的真实录屏：展示模型配置、任务、权限确认与工具结果。
- 一段远程 AI CLI 分屏录屏：展示代码差异与测试，注明 CLI 版本。
- 一张主界面截图：优先展示实际测试主机上的终端、文件、监控组合。
- 一段分屏与广播的短视频，一段文件编辑与独立日志的短视频。
- 一张深浅主题对照图；避免一次铺满九套主题而让文字不可读。
- 一个安装与首次连接示例，按系统展示准确的包名和实际安装步骤。

当前仓库未随附产品截图，本次文档没有插入占位图或模拟成品截图。后续加入真实截图时，应使用测试资料；若使用浏览器演示数据，需要标明演示模式，不能作为 SSH 或传输验证的证据。

### 首轮反馈重点

优先收集用户能否完成安装、首次连接、文件浏览、一次传输和一次分屏操作，以及在哪一步退出。按“看到介绍 → 到达仓库 → 打开 Release → 成功首次连接”分别观察反馈；当前没有现成的完整转化追踪，不应把 GitHub 下载次数直接当作活跃用户数。

社区渠道可先围绕开发者、自托管和运维场景分别发布不同演示，沿用同一下载入口。GitHub About、Topics、截图、录屏和实际安装验证是后续可执行项，本次更新涉及项目文档；社区帖与外部推广渠道需按所选渠道另行发布。
