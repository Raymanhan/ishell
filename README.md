# iShell

**An all-in-one SSH workbench with a built-in AI server assistant.**

[![Release](https://img.shields.io/github/v/release/Raymanhan/ishell?label=release)](https://github.com/Raymanhan/ishell/releases/latest)
[![CI](https://github.com/Raymanhan/ishell/actions/workflows/ci.yml/badge.svg)](https://github.com/Raymanhan/ishell/actions/workflows/ci.yml)
[![Build installers](https://github.com/Raymanhan/ishell/actions/workflows/release.yml/badge.svg)](https://github.com/Raymanhan/ishell/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

iShell is an open-source SSH desktop workbench for developers, operators, and self-hosters. Connect to your servers, work across split terminals, transfer files, edit configurations, follow logs, and inspect resource usage from a single window.

The built-in **AI server assistant** turns deployment and troubleshooting requests into tool-assisted steps over the active SSH connection: run commands, read and write files, and generate and execute code, with visible output for each step. Connect your own OpenAI-compatible model service and choose the model, reasoning effort, and operation permissions.

You can also launch installed AI CLIs such as Codex and Claude Code in remote projects and keep **AI sessions, code diffs, tests, and logs** side by side.

Built with **Tauri 2 + React 19 + Rust**, available for Windows, macOS, and Linux, and released under the MIT license.

**[Download the latest release](https://github.com/Raymanhan/ishell/releases/latest)** · [AI assistant setup](#ai-assistant-quick-start) · [AI coding workflow](#ai-coding-workflow) · [Features](#features) · [Report an issue](https://github.com/Raymanhan/ishell/issues)

**Languages**: English | [简体中文](README.zh-CN.md)

## Why iShell?

| Your workflow | How iShell helps |
| --- | --- |
| Describe a deployment, log investigation, or troubleshooting task | The AI assistant calls server tools and shows steps and results under your chosen permission mode |
| Use Codex or Claude Code in a server-side project | Keep AI sessions, diffs, tests, and logs in split panes, with terminal background reporting for theme compatibility |
| Manage development, staging, and production hosts | Organize connections with folders, search, tags, and colors; work in up to four panes |
| Run the same checks on several machines | Combine broadcast input with saved command snippets for selected sessions |
| Upload files, change a configuration, and verify a service | Keep remote files beside the active terminal and return to the shell after editing |
| Investigate a deployment, a slow service, or a GPU job | Follow logs in a separate window while inspecting resources and process rankings |
| Reach services behind a jump host | Chain up to three jump hosts and use local, remote, or SOCKS5 forwarding |

## Features

### 1. Built-in AI server assistant: from goals to actions and results

- **Natural-language server tasks**: describe deployment, inspection, or troubleshooting work. The assistant can run Shell commands, read/write files, and generate and execute Python, Shell, or Node.js code.
- **Your choice of model service**: use an OpenAI-compatible API, discover models and reasoning levels, or enter model IDs and `reasoning_effort` manually where needed.
- **Four permission modes**: suggestions only, confirm before execution, automatic low risk, and full access. Approval cards show the target server, working directory, and full command or code.
- **Visible steps and results**: streamed replies and grouped tool cards show descriptions, commands, code, output, success/failure states, and exit codes. You can request cancellation at any time.
- **Context management for longer tasks**: automatic compaction follows the model's declared context window, with manual `/compact` and a command menu for `/new`, `/history`, and `/settings`.
- **Per-server conversations**: encrypted local history and tool results, conversation switching and continuation, deletion, editing a sent message to restart from that point, and remembered model/effort/permission preferences.
- **Remote AI coding workflow**: run installed Codex or Claude Code CLIs in terminals and use four panes for AI sessions, diffs, tests, and logs. Background-color reporting helps CLIs choose light or dark styling.

The built-in assistant uses your configured model API and does not require an external AI CLI. Server tools require remote Python 3; JavaScript execution also requires Node.js. Permission rules govern execution and approval; operations still use the SSH account's privileges. Stopping a task or editing a conversation does not undo completed server operations.

### AI assistant quick start

1. Open **Settings → AI Assistant**, enter an OpenAI-compatible API URL and key, discover models, and choose a default. You can also add a model ID manually.
2. Connect to a server and open the **AI sparkles button** at the top right. Select the model, reasoning effort, and permissions.
3. Describe a goal, such as inspecting disk space and identifying large directories. Review each tool step; when approval is requested, inspect the command and allow it once or deny it.
4. Review output and conclusions, continue through conversation history, and use `/compact` with an optional focus for longer conversations.

| Permission mode | Behavior |
| --- | --- |
| Suggestions only | Advice without executing server tools |
| Confirm before execution | Approval for every tool call |
| Automatic, low risk (default) | Recognized low-risk queries run automatically; writes, code, and unknown commands require approval |
| Full access | Task tools run without individual approval |

Task messages, necessary server information, and tool output are sent to your configured model service. API keys, conversations, and tool results are encrypted locally. Bring your own model service configuration. See the [AI assistant guide](docs/AI_GUIDE.md) for details.

### Remote AI CLI coding

- **Run an AI CLI on the project host**: SSH into your remote project directory and launch an installed, configured Codex or Claude Code CLI to work with that host's code and runtime environment.
- **Keep AI sessions and verification side by side**: use up to four panes for an AI conversation, `git diff`, tests, and service logs. You can also launch separate sessions in different project directories and arrange tabs and windows by task.
- **Light and dark styling for AI CLIs**: answer terminal background queries with the current theme's actual surface color, allowing tools such as Codex and Claude Code to select their styling and improving readability with transparent windows and light themes.
- **Check changes and results in the same workbench**: inspect small configurations and scripts in the file panel, run tests in another pane, and observe runtime results through log windows and host metrics.
- **Observe remote AI workloads**: follow training or inference logs and inspect process rankings and available GPU/VRAM metrics. GPU metrics require compatible remote interfaces.

Install, authenticate, and configure these external AI CLIs on the remote host; you operate each CLI session independently.

### 2. Multiple sessions, less repeated typing

- **Interactive terminals**: xterm.js with real PTY sessions, reconnect, duplicate tabs, drag-to-reorder, detach to a new window, and handoff between windows.
- **Up to four panes**: nest horizontal and vertical splits for the same server or different hosts. Resize dividers; file and monitoring panels follow the focused pane.
- **Broadcast input**: mirror typing to selected sessions, with an individual toggle for each target. Useful for routine checks and side-by-side operations.
- **Snippets and history**: save commands with notes, insert them for editing or send Enter automatically, and use them with broadcasting. Search history, get suggestions, and paste commands back into a terminal.
- **Terminal search**: find output in the terminal's current scrollback with case-sensitive, whole-word, and regular-expression options.

### 3. Remote files, from transfer to configuration changes

- **Two browsing modes**: tree/detail and multi-column views, direct path navigation, multi-selection, context menus, mkdir, rename, and delete.
- **Files and folders**: drag and drop uploads; download folders directly or as `.tar.gz` archives. Transfer queues show progress, bytes, and task states, with controls to stop tasks.
- **Folder replacement safeguards**: confirm replacement of an existing remote folder; uploads use staging, commit, and rollback protection on failure.
- **Remote text editing**: edit and save **UTF-8 text files up to 1 MiB** with built-in syntax highlighting, suitable for configurations and scripts.
- **Terminal directory handoff and symlinks**: change the active shell to a selected directory from the file menu. Link indicators and delete prompts distinguish symlinks from their targets.
- **Open directories from the terminal**: hold `Command` (macOS) or `Ctrl` (Windows/Linux) and click a `user@host:directory` prompt to locate it in the file panel. The directory tree expands and scrolls to the current location as you navigate.

Uploading a folder with an existing name uses **full replacement**: directories are not merged, and remote-only contents are removed. Check the destination in the confirmation dialog.

### 4. Troubleshooting with live logs and host metrics

- **Live logs**: open a file in a separate tail window, configure initial line count, pause following, return to the bottom, clear output, or restart. Closing the viewer stops its remote task.
- **Host status**: CPU, memory, swap, disk mounts, load average, process count, and network upload/download rates.
- **Process rankings**: inspect the top five CPU and memory consumers.
- **GPU and VRAM**: display available metrics from compatible remote `nvidia-smi` or Linux DRM interfaces, useful for checking remote GPU workloads.
- **Collected over SSH**: no additional persistent monitoring agent to install. Available metrics depend on the remote OS, tools, and permissions.

### 5. Jump hosts and three forwarding modes

Choose another saved server as a jump host and chain up to **three hops**, each with its own user and password or private key.

| Mode | Example use |
| --- | --- |
| Local `-L` | Access a database or admin service reachable only from the server |
| Remote `-R` | Forward a listening port on the server to a service reachable from your computer |
| Dynamic SOCKS5 `-D` | Create a local SOCKS5 proxy that reaches the network through the server |

Rules are saved per server, show live state and failure reasons, and can start automatically when a terminal connects. They use the server's jump-host configuration, run independently of terminal tabs, and stop when the app quits.

### 6. Organized connections you can move between installations

- Group servers with folders, tags, notes, and colors. Search, multi-select, reorder by dragging, duplicate profiles, rename inline, and delete in bulk.
- Use password or private-key authentication and test a connection before saving. Ordering and group placement persist across restarts.
- Import and export hosts or folders in iShell JSON/ZIP format. Set an export passphrase to include encrypted saved passwords or private-key passphrases.
- Connection profiles, command history, snippets, and forwarding rules stay local. No iShell account is required.

### 7. Nine themes and in-app updates

- **Three interface languages**: Simplified Chinese, Traditional Chinese, and English, following the system language by default and switchable live across open windows.
- **Nine themes**: Cloud, Dusk, Claude Dark, Claude Light, Graphite, Midnight, Jade, Obsidian, and Ivory, each with its own 16-color terminal palette.
- **Appearance controls**: native transparent windows and glass effects, floating-card layouts, adjustable transparency, terminal font size, and an auto-hiding top bar.
- **In-app updates**: check on startup and every six hours, check manually, or disable automatic checks. Update packages are signature-verified before installation and restart.
- **Offline release history**: browse version entries bundled with the app in About and updates.

Window effects vary by platform.

## AI coding workflow

1. Prepare the project, development dependencies, and Codex or Claude Code on the remote server. Complete the CLI's authentication and model configuration.
2. Connect through iShell, enter the project directory, and run `codex` or `claude` to launch the corresponding tool.
3. Split the tab and enter the same project in the other panes to inspect `git diff`, run the project's tests, or follow logs.
4. Give the AI session a task, then review changes, tests, and logs. Use the built-in text editor for small configuration changes when needed.

| Pane | Example use |
| --- | --- |
| AI session | Run `codex` or `claude` in the project directory |
| Review | Inspect code changes with `git diff` |
| Verify | Run the project's tests or build command |
| Observe | Watch service output or follow logs; logs can also open in a separate window |

Model access follows your CLI configuration, and project files live on the remote host. AI capabilities and interaction behavior depend on the CLI version and server environment.

## Download and install

**[Get the latest release on GitHub](https://github.com/Raymanhan/ishell/releases/latest)** and choose the package for your operating system and architecture:

| Platform | Architecture | Packages |
| --- | --- | --- |
| Windows | x64 | `.exe` / `.msi` |
| macOS | Apple Silicon | `aarch64.dmg` |
| macOS | Intel | `x64.dmg` |
| Linux | x64 | `.AppImage` / `.deb` / `.rpm` |

Actual filenames include a version number. On Linux, in-app updates apply to AppImage installations; download a new package to update `.deb` or `.rpm` installations.

The interface supports Simplified Chinese, Traditional Chinese, and English; repository documentation is available in English and Chinese.

### Before connecting

- **Your computer**: macOS/Linux require an OpenSSH client. Windows uses the built-in pure-Rust `russh` backend.
- **Remote server**: SSH access and appropriate permissions. File-panel operations such as directory listing and uploads require `python3`; folder downloads use `tar`, compressed downloads need gzip support, and log viewing uses `tail`.
- **Monitoring**: primarily targets Linux/Unix hosts using `/proc`, `ps`, `top`, `df`, and related tools, with macOS/BSD fallbacks for some metrics. GPU/VRAM metrics require compatible remote driver interfaces.

Installers do not require Node.js or Rust. A basic SSH terminal does not require all of the remote file and monitoring tools listed above.

## Quick start

1. Install and launch iShell, then open the connection manager from the top bar.
2. Add a server with its host, port, username, and password or private-key authentication. Add a group, tags, or a jump host if needed.
3. Test the connection, save, and double-click the server to open a terminal.
4. Use the top bar to open files, monitoring, history, snippets, or port forwarding.
5. Split from a tab's context menu, or choose the split-connect action on another server in the connection manager.
6. For repeated input, enable broadcasting, check the selected target sessions, then type or send a snippet.

A typical workflow: **connect → upload files → edit configuration → verify in the terminal → follow logs and check metrics**.

### Keyboard shortcuts

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| Split right | `⌘D` | `Ctrl+Shift+D` |
| Split down | `⇧⌘D` | `Ctrl+Shift+E` |
| Search terminal output | `⌘F` | `Ctrl+Shift+F` |

Explore the top bar and tab, server, and file context menus for other actions. The transparency slider preserves the theme's glass effect at 100%; 0% is fully opaque.

## Local data and credentials

- **Local storage**: server profiles, command history, snippets, and forwarding rules use `ishell.db`, a SQLite database in the app data directory. Appearance preferences and similar settings use WebView local storage.
- **Saved credentials**: passwords and private-key passphrases are encrypted with **AES-256-GCM** in the database. The master key is stored in `secret.key` in the same app data directory, with `0600` permissions on Unix. The current implementation uses a local key file.
- **AI data**: model-service settings and API keys, conversation history, and tool results use the same local encryption mechanism and are excluded from connection exports. Built-in AI requests send task messages, necessary server information, and tool output to your configured model service.
- **Exports**: leave the export passphrase empty to export profiles only. With a passphrase, credentials are encrypted with AES-256-GCM using a PBKDF2-HMAC-SHA256-derived key. Profile metadata such as names and addresses remains readable. Private-key files themselves are not bundled.
- **Host keys**: the first connection automatically trusts and records the server key; subsequent connections check the recorded key and reject changed keys.

Treat the database and master key as equally sensitive when backing up or migrating the app data directory. History and snippets are ordinary local data and should not contain plaintext credentials. Move private-key files separately and update their paths on another computer.

## Run from source

Install Node.js 22.12+ (or a newer LTS release), Rust stable, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform, then run:

```bash
git clone https://github.com/Raymanhan/ishell.git
cd ishell
npm ci
npm run tauri -- dev
```

For a frontend preview, run `npm run dev`. Browser previews use demo data and simulated interactions; real SSH, file transfers, and forwarding require the desktop app.

Build an installer with `npm run tauri -- build`. See the [development and release guide](docs/DEVELOPMENT.md) for system dependencies, validation commands, architecture, and update signing.

## Feedback and contributions

[Open an issue](https://github.com/Raymanhan/ishell/issues) with your OS, iShell version, reproduction steps, and sanitized error messages. Feature suggestions, pull requests, and sharing iShell with other server users are welcome.

The Chinese [project analysis and promotion notes](docs/PROJECT_ANALYSIS.zh-CN.md) provide feature evidence, audience recommendations, demo ideas, and reusable copy.

## Recent Changes

<details>
<summary>Expand release history</summary>

- `v1.5.13` fixes the AI assistant's history list having a see-through background that let the chat behind it show through in some themes. The manual model or reasoning entry and the scroll-to-latest button are opaque too, with a dark surface in dark themes and a light one in light themes.

- `v1.5.12` brings AI approvals back into the tool card: a step that needs approval opens its card with the target server, directory and full command, and Deny / Allow once buttons, instead of a dialog. Risk levels and reasons such as "高风险" are no longer shown; the risk assessment still decides which steps need approval. The `/` command menu no longer has a see-through background that let the chat text behind it show through in some themes.

- `v1.5.11` refines the AI assistant. Pressing Enter to commit an input-method candidate no longer sends the message (including on macOS). The model, reasoning and permission pickers have fixed widths with the arrow next to the label, and the model name gives way first in a narrow panel. Your own messages can be edited to run the task again from that point, replacing the conversation and model context after it. Typing `/` opens a command menu (`/compact`, `/new`, `/history`, `/settings`) driven by the arrow keys, Tab, Enter and Esc. Tool cards are titled with the model's short description of the step (such as "检查磁盘占用"), or the command itself when none is given; they stay collapsed while running, consecutive calls are grouped into one list, and new steps slide in. Reply text is buffered and revealed at an even pace instead of jumping by network chunks, and the working status uses a sliding highlight. Risk levels no longer appear on the cards: approvals open a dialog with the step's purpose, risk reason, target server, directory and full command; high-risk steps focus Deny, and a click outside the dialog does not answer it.

- `v1.5.10` fixes the terminal card sitting a few pixels above the neighbouring cards on macOS after opening a server, until the file panel was opened. The resize handles of the closed file and monitor panels no longer extend past the window edge, and layout containers that must not scroll are put back in place if the system scrolls them.

- `v1.5.9` constrains terminal cards and side panels to the available workspace height. Terminal dimensions and rendering refresh after window focus, visibility restoration, font loading, theme changes and completed sidebar transitions. AI panel headers, composer and footer stay in place while long replies scroll.

- `v1.5.8` adds interface languages: Simplified Chinese, Traditional Chinese, and English, following the system language and switchable live in Settings → Appearance (open windows update too). App error messages are translated, including errors from the desktop backend; server output and AI replies stay as they are, and dates follow the chosen language. AI context compaction now follows the context window declared in the model metadata (at 75% of the window, no longer capped at 200k), with 200k estimated tokens as the default when none is declared. Type `/compact` in the AI chat to compact on demand, optionally followed by what the summary should keep. About and Updates shows the latest versions, with older ones in a collapsible, scrollable list.

- `v1.5.7` hardens AI automatic mode: commands with wildcards, device files, credential-like paths, `docker inspect`/`systemctl show` and endless `tail -f`/`docker stats` now require approval, paths are normalized before checks, and auto-approved reads refuse symlinks to credential files. Long reasoning streams are no longer cut off after five minutes; repeated tool-call IDs from compatible gateways and earlier-turn `reasoning_content` (rejected by DeepSeek) are handled. Compaction follows the model's declared context window (75%, up to 200k), and more context-overflow errors are recognized. Unreadable history records are skipped instead of disabling the AI panel, history saves no longer rewrite continuously while a reply streams, a temporary `/models` failure no longer clears saved models, tool polling backs off when idle, and abandoned remote temp files are cleaned up.

- `v1.5.6` replaces ambiguous AI tool status text with readable success/failure labels and moves exit codes into expanded details. Model, reasoning effort, and manual input choices are cached per API service, with permissions remembered per server. Selections save before the first message and carry over to new chats, reopened empty chats, and app restarts.

- `v1.5.5` adds per-server AI conversation history with reopen, continue, and delete actions; **+** preserves existing chats and starts an independent conversation. Chats and tool results are encrypted locally and survive restarts. Model, effort, and permissions remain editable during execution and apply to the next send; background output stays with its original task. About and Updates now includes expandable version history, highlights the installed version, and shows available update notes; bundled history is readable offline.

- `v1.5.3` reads AI models and reasoning levels from the configured service metadata, refreshes stale selections, and supports manual model IDs / reasoning efforts when discovery is unavailable or incomplete. Model, effort, and permissions now share one row; context usage moves to the footer.

- `v1.5.1` adds an AI server assistant sidebar with OpenAI-compatible configuration, encrypted keys, model/reasoning selection, multi-step Shell and code tools, streamed output, and cancellation. Four permission modes enforce risk-based one-time approvals; context compacts automatically at 200k estimated tokens while preserving recent tool groups and visible history.

- `v1.4.6` expands and scrolls the directory tree to the current folder when navigating; Command-click (macOS) or Ctrl-click (Windows/Linux) a terminal prompt to open its directory in the file panel, including remote home directories, Unicode, spaces, and wrapped prompts.
- `v1.4.5` adds compact SVG actions for completed downloads: reveal files in their containing folder or open them with the default app, and open downloaded folders directly. Archived folder downloads use file actions; buttons include tooltips and failures show a notice.

- `v1.4.3` fixes lingering floating tab previews when dragging a tab out on Windows, including delayed window creation and lost pointer capture; temporary preview windows are excluded from tab handoff targets.
- `v1.4.2` lays out Settings as a side menu: Appearance, Terminal, and About
  and updates on the left, the chosen menu's settings on the right, at a fixed
  size while switching; About and updates shows a dot when an update is waiting.
- `v1.4.1` adds a window transparency slider to Settings, so less of what is
  behind the window shows through the glass themes (most noticeable on
  Windows); 0% is fully opaque. Split pane labels now sit flush in the pane's
  top-right corner, and new installs start with a 14px terminal font instead of
  11px.
- `v1.4.0` adds jump hosts (chainable), port forwarding (local, remote and
  SOCKS5, running in the background with live status), split panes, broadcast
  input, command snippets and search in the terminal. Terminal selections are
  readable on light themes again, deleting from the server editor now always
  deletes the server being edited, and pull requests are checked by CI.
- `v1.3.0` adds in-app updates: iShell checks for a new release in the
  background at startup and every 6 hours, offers it in a corner prompt, and
  downloads, installs and restarts in one click. Settings gains an "About and
  updates" section to check manually or turn automatic checks off. Update
  packages are installed only after their signature is verified.
- `v1.2.2` reports each theme's real terminal background to programs that
  query it, so AI CLIs such as Codex and Claude Code pick matching light or
  dark styling and typed input stays visible on light themes.
- `v1.2.1` brightens every theme (near-white text, readable secondary text,
  lighter surface tints, livelier terminal colors) and gives the live
  monitoring panel one fixed set of vivid system colors in every theme.
- `v1.2.0` redesigns the theme system: refined palettes for all existing
  themes, four new floating-card themes (Otty-style Cloud and Dusk, Claude
  Dark and Claude Light), full 16-color terminal palettes per theme,
  theme-aware charts, meters and syntax colors, and SFTP detail columns that
  adapt to the panel width.
- `v1.1.20` adds a separate live tail viewer for remote log files, improves
  vertical drag-scrolling in the remote editor, refines SFTP detail column
  resizing, and polishes the pearl/light theme plus the add-server dialog.
- `v1.1.19` expands live monitoring with GPU/VRAM metrics and live Top 5
  process rankings for CPU and memory usage.
- `v1.1.18` adds a Settings toggle for the auto-hiding top bar and places new
  upload/download queue items at the top for easier progress tracking.
- `v1.1.17` improves remote file editing by automatically scrolling
  horizontally when a dragged text selection moves beyond the editor edge.
- `v1.1.16` consolidates SFTP file and folder uploads into accessible toolbar
  and context-menu submenus with reliable dismissal and focus behavior.
- `v1.1.15` adds transactional folder uploads with drag and drop, explicit
  full-replacement confirmation, atomic commits, rollback safeguards, and
  hardened cancellation/retry behavior across both SSH backends.
- `v1.1.14` fixes Linux CI linting for the macOS-only window reopen handler.
- `v1.1.13` strengthens SSH/SFTP reliability with connection timeouts, host-key
  persistence, isolated uploads, transfer safeguards, and CI Rust lint/test
  coverage.
- `v1.1.12` moves history command suggestions to the Alt shortcut and improves
  the empty suggestion header.
- `v1.1.11` adds Windows terminal copy and paste shortcuts through the
  clipboard.
- `v1.1.10` switches Windows to the Mica backdrop to reduce lag while moving
  or resizing the application window.
- `v1.1.9` improves indeterminate download progress for folder/archive
  transfers by showing live transferred bytes and an animated progress track.
- `v1.1.8` isolates bulk SFTP downloads on dedicated SSH connections so
  large transfers do not compete with interactive terminal traffic.
- `v1.1.7` adds remote folder downloads from the SFTP context menu, with
  archive (`.tar.gz`) and direct-download modes plus clearer queue progress.
- `v1.1.6` preserves the remote file editor highlight overlay height for
  trailing newlines, keeping selections and syntax highlighting aligned.
- `v1.1.5` keeps the remote file editor highlight layer aligned with the
  textarea while tightening monospace rendering for more predictable editing.
- `v1.1.4` compacts the connection tree spacing and gives the SFTP detail
  view clearer panel boundaries with steadier scrolling in tight layouts.
- `v1.1.3` tightens the SFTP detail layout with more compact columns and
  scroll-safe tool/stage sizing for constrained window widths.
- `v1.1.2` replaces the folder rename prompt with inline editing in the
  connection tree, keeping keyboard confirm/cancel behavior inside the panel.
- `v1.1.1` improves connection-tree selection and rename behavior, adds a
  draggable tab-bar spacer, and focuses the liquid glass theme variants.
- `v1.1.0` expands liquid glass into multiple theme variants, improves
  connection rename handling, and tightens glass layout behavior around panels
  and tabs.
- `v1.0.10` adds a liquid glass app theme and refines the server editor layout
  with clearer grouped sections, tighter controls, and polished form states.
- `v1.0.9` stabilizes release packaging by generating macOS DMG files directly
  in CI after building the `.app` bundle.
- `v1.0.8` improves native window lifecycle handling: macOS Dock reopen restores
  and focuses the main window, while non-macOS close uses window destruction.
- `v1.0.7` restores profile-level connection testing, adds clone and rename
  actions in the connection tree, and improves password editing controls.
- `v1.0.6` improves connection tree drag/drop reliability, restores double-click
  connection behavior during pointer handling, and sorts grouped servers by
  saved order.
- `v1.0.5` changes native window close behavior to close terminal tabs, reset
  transient panels, and hide the app cleanly.
- `v1.0.4` adds tab handoff between windows, improves connection tree dragging,
  splits the CSS into focused modules, and makes SFTP symlink handling safer.
- `v1.0.3` refines SFTP selection typing and keeps the release metadata aligned
  with the current source.
- `v1.0.2` adds SFTP-to-terminal directory jumps, host/IP copy in the status
  panel, and improves terminal readiness detection.
- `v1.0.1` refreshes the glass UI, adds persistent connection ordering, improves
  terminal/SFTP layout ergonomics, and expands the documentation.
- `v1.0.0` adds connection import/export, encrypted secret export, and a small
  remote text editor inside the SFTP browser.
- `v0.1.10` adds terminal history suggestions.
- `v0.1.9` tunes platform font rendering for terminal readability.
- `v0.1.7` / `v0.1.6` add and pool the Windows `russh` terminal backend.
- `v0.1.4` switches Unix-like remote sessions to the system OpenSSH transport.

</details>

## License

iShell is released under the [MIT License](LICENSE).
