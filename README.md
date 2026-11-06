# iShell

[![Build installers](https://github.com/Raymanhan/ishell/actions/workflows/release.yml/badge.svg)](https://github.com/Raymanhan/ishell/actions/workflows/release.yml)
[![Release](https://img.shields.io/github/v/release/Raymanhan/ishell?label=release)](https://github.com/Raymanhan/ishell/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

iShell is a lightweight Tauri + React + Rust SSH workbench for managing remote
servers from one compact desktop interface. It combines server profiles,
interactive terminals, SFTP file operations, small-file text editing, command
history, live telemetry, and a translucent desktop UI.

**Languages**: English | [简体中文](README.zh-CN.md)

## Download

Get the latest installers from GitHub Releases:

**[Download iShell v1.5.12](https://github.com/Raymanhan/ishell/releases/tag/v1.5.12)**

Available packages:

- **Windows x64**: `.exe` and `.msi`
- **macOS Intel**: `.dmg`
- **macOS Apple Silicon**: `.dmg`
- **Linux x64**: `.AppImage`, `.deb`, and `.rpm`

## Highlights

- **Interface languages**: Simplified Chinese, Traditional Chinese, and
  English, following the system language by default and switchable live in
  Settings → Appearance.
- **SSH manager**: grouped and searchable connection tree with tags, notes, and
  per-host colors.
- **Persistent ordering**: connection order and folder placement are stored in
  the local database.
- **Secure secrets**: passwords are stored through the OS keychain/secret store,
  not as plain text in exported connection files.
- **Import and export**: export selected hosts or folders as JSON/ZIP, with
  optional passphrase-protected secrets.
- **Interactive terminals**: xterm-powered tabs backed by real PTY sessions,
  reconnect support, tab cloning, tab reordering, tab handoff between windows,
  command history, and search in the terminal output.
- **Split panes and broadcast input**: split a tab into up to four nested
  panes, and mirror typing to several sessions at once.
- **Command snippets**: save frequent commands and send or run them with one
  click, on every broadcast session if broadcasting.
- **Jump hosts**: reach a server through another saved server, chained if
  needed, with each hop using its own user and password or key.
- **Port forwarding**: local (-L), remote (-R) and dynamic SOCKS5 (-D) forwards
  per server, running in the background with live status.
- **OpenSSH and russh transports**: macOS/Linux use the system OpenSSH client;
  Windows uses a pure-Rust `russh` backend with pooled sessions.
- **SFTP browser**: column or tree browsing, upload, download, rename, delete,
  mkdir, context menus, symlink-aware entries, terminal directory jump, remote
  text editing for small files, and a separate live tail viewer for log files.
- **Live monitoring**: CPU, GPU, memory, swap, disk, load, process rankings,
  and network throughput per connected host, plus one-click host/IP copy.
- **Glass desktop UI**: transparent native window, nine themes (including
  Otty-style and Claude Code-style floating-card themes), xterm transparency,
  and platform-tuned font rendering.

## Quick Start

1. Download the installer for your platform from
   [Releases](https://github.com/Raymanhan/ishell/releases/latest).
2. Install and open iShell.
3. Open the connection manager from the top bar.
4. Create a folder if needed, then add a server profile.
5. Choose password or SSH key authentication and save the profile.
6. Double-click a server, or use the context menu, to open a terminal tab.
7. Use the top bar to open SFTP, live status, command history, settings, or
   connection management.

## User Guide

### Connections

- Use the connection manager to search, select, group, edit, import, export, and
  delete server profiles.
- Right-click a server to connect, clone, rename, edit, export, or delete it.
- Right-click a folder or empty area to rename folders, create folders, add
  servers, import, or export.
- Multi-select supported items before running bulk export or delete actions.
- New and edited servers keep a `sortOrder`, so the connection tree remains
  stable after restart.
- Connection groups are sorted by saved order, then by natural name order for
  predictable browsing.

### Server Profiles

Each profile includes:

- Name, host, port, username, group, tags, color, and notes
- Authentication type: password or private key
- Optional private key path
- Optional jump host: another saved server to connect through first; a jump
  host can have its own jump host (up to three hops)
- A built-in connection test before saving
- Password visibility toggle while editing

Secrets are stored separately from profile metadata. When exporting
connections, secret export is optional and can be passphrase-protected.

### Terminal Tabs

- Each connected host opens as a tab.
- Tabs can be activated, closed, cloned, reconnected, and reordered.
- Tabs can be dragged out and handed off to another iShell window.
- Closing the native window closes active terminal tabs and hides the app
  instead of leaving background sessions behind.
- Right-click a tab for tab-level actions.
- The top bar can stay visible or auto-hide until the pointer reaches the top
  edge.
- The terminal font size is configurable in Settings.
- Command history can be searched and pasted back into the active terminal.
- Search the terminal output with `⌘F` (macOS) or `Ctrl+Shift+F`
  (Windows/Linux), with case, whole-word and regex options.

### Split Panes and Broadcast Input

- Right-click a tab and choose **Split right** or **Split down**, or press
  `⌘D` / `⇧⌘D` (macOS) or `Ctrl+Shift+D` / `Ctrl+Shift+E` (Windows/Linux) in
  a terminal. The new pane connects to the same server.
- Right-click a server in the connection manager and choose **Connect in
  split** to open a different server next to the current pane.
- Splits nest, up to four panes per tab. Drag the dividers to resize, click a
  pane to focus it; the file and monitoring panels follow the focused pane.
- The broadcast button in the top bar mirrors what you type in one selected
  session to the others. It starts with the panes of the current tab (or every
  session when the tab is not split); the bar below the terminals toggles
  individual sessions.

### Command Snippets

- Open **Snippets** from the top bar to save frequent commands with a name and
  an optional note.
- A snippet either runs right away (Enter is pressed) or is only typed in for
  editing; multi-line snippets are sent line by line.
- Click a snippet to send it to the focused pane, or to every broadcast session
  while broadcasting.
- Snippets are stored in the local database.

### Port Forwarding

Open **Port forwarding** from the top bar to add rules for the current server:

- **Local (-L)**: a port on this computer that reaches an address the server
  can reach, e.g. a database only open to the server.
- **Remote (-R)**: a port on the server whose connections are passed to an
  address this computer can reach.
- **SOCKS (-D)**: a SOCKS5 proxy on this computer that reaches the network
  through the server.

Forwards run in the background independent of tabs and all stop when iShell
quits. The panel shows each forward's live state and, on failure, the reason.
A forward can start automatically when a terminal to its server connects. Jump
hosts apply to forwards too.

### SFTP

Open the file panel for the active terminal tab to browse the remote filesystem.

Supported operations:

- Switch between tree/detail and multi-column browsing.
- Opening a directory expands its ancestors and scrolls the tree to the current directory.
- Hold `Command` (macOS) or `Ctrl` (Windows/Linux) and click a `user@host:directory` terminal prompt to open that directory in the file panel. Home-directory paths (`~`) and absolute paths are supported.
- Upload files or folders to the current directory, including folder drag and drop. If a same-named remote folder exists, iShell asks before replacing it in full; replacement does not merge and removes remote-only entries.
- Download selected files; newly queued transfers appear at the top of the
  transfer list.
- Create folders, rename entries, and delete one or more entries.
- Symlinks are shown with link icons and safer delete messaging.
- Jump the active terminal to the selected remote directory from the SFTP
  context menu.
- Open small text files in the built-in editor and save changes back to the
  remote host.
- Open a live tail viewer for a selected file to follow appended log output in
  a dedicated desktop window.
- Drag text selection beyond the editor's left or right edge to keep selecting
  while the editor scrolls horizontally.
- Use the path bar to jump directly to a directory.

Text editing is intentionally limited to small files so the UI remains
responsive and safe for remote sessions.

### Live Tail Viewer

- Open **Live Tail** from the SFTP context menu for a file on the active host.
- iShell opens the viewer in a separate desktop window so long-running logs do
  not take over the main workbench.
- Choose how many trailing lines to load before following new output.
- Pause following, resume at the bottom, clear the current buffer, or restart
  the tail session from the viewer toolbar.
- The viewer streams through the same SSH backend as the active host and stops
  its remote process when the window closes.

### Live Status

The status panel samples remote host information through SSH:

- CPU usage
- GPU usage and VRAM when the remote host exposes supported metrics
- Memory and swap
- Disk mounts
- Load average
- Process count
- Top CPU and memory processes
- Network upload/download throughput
- Host/IP copy shortcut

### AI Server Assistant

1. Open **Settings → AI Assistant**, enter an OpenAI-compatible API base URL and key, read model metadata from the service’s `/models` endpoint, select a default model, and save. Models missing from discovery can be added under manual model IDs. Keys are encrypted in the local SQLite database with the existing local encryption key; they are not stored in browser storage or connection exports.
2. Connect to a server and click the **sparkles SVG button** at the top right. Model, reasoning effort, and agent permissions share one row below the composer. Models and available efforts come from service metadata, including `supported_reasoning_efforts` and Codex `supported_reasoning_levels`; **Default** is used when no levels are declared. The model and effort menus also offer manual input; manually entered models work without `/models`, and explicit effort values are forwarded as entered. Metadata refreshes on startup, after saving settings, or from the sidebar refresh button. Model/effort selections are validated before requests.
3. Open the sidebar’s **history icon** to view, continue, or delete conversations for the current server. **+** starts an independent conversation and preserves previous records. Running tasks remain accessible through history and must be stopped before deletion. Model, effort, and permission controls remain editable during execution; changes apply to the next send, while the current task keeps its starting settings.
4. Describe a deployment or operations task. The agent can run Shell commands, read/write files, and execute generated Python, Shell, or Node.js code. Every step exposes its command/code, output, and a readable success/failure status, with the real exit code available in expanded details. The server needs Python 3; JavaScript also needs Node.js. Non-interactive elevation uses existing `sudo -n` privileges.

Model, reasoning effort, and manual input choices are cached locally as soon as they change, separately for each model service; permissions are remembered per server. New chats, reopened empty chats, and app restarts reuse these choices. Existing history and unsent drafts keep their own settings.

Choose permissions below the composer, or set the default for new chats in settings:

| Mode | Behavior |
| --- | --- |
| Suggestions only | No server tools are executed |
| Confirm before execution | Every tool requires approval |
| Automatic, low risk (default) | Recognized low-risk queries run automatically; writes, arbitrary code, and unrecognized commands require approval |
| Full access | Tools for the requested task run without individual approval |

A step that needs approval opens its tool card to show the target server, the working directory, and the complete command/code, with Deny and Allow once; the risk assessment decides whether to ask but is not shown on the card. Tool cards stay collapsed and are titled with the model's short description of the step; consecutive tool calls are grouped. Classification uses conservative rules and is not a sandbox; SSH account privileges still apply.

Conversations and tasks stay bound to their originating terminal connection. Switching tabs does not redirect a running task. Closing the sidebar preserves the conversation; closing or reconnecting the terminal requests cancellation. Stop is available at any time; completed changes are retained. Tools default to a 120-second timeout, allow up to 1800 seconds, and return bounded output with truncation markers.

Context automatically compacts at **75% of the context window declared in the model metadata** (200k estimated tokens when the metadata declares none) into a summary that retains the original task, recent complete tool groups, key results, and remaining work. Visible chat history remains available; failed/canceled compaction preserves the original context. A provider context-limit error also triggers one compaction attempt. Type `/compact` in the chat to compact on demand; text after it (for example `/compact keep the nginx changes`) tells the summary what to retain. Typing `/` in the input lists the available commands (`/compact`, `/new`, `/history`, `/settings`), chosen with the arrow keys, Tab and Enter. Hover one of your messages to edit it and run the task again from there: the conversation and model context after it are replaced, and actions already run on the server are not undone; messages folded into a summary cannot be edited. Automatic mode treats wildcards, device files, credential-like paths, `docker inspect`/`systemctl show` (which print environment values) as requiring approval, and an auto-approved `read_file` refuses links that resolve to credential files. Conversations and tool results are encrypted locally and can be reopened after restarting; interrupted tasks never resume automatically. Task messages, necessary server details, and tool output are sent to the configured model API.

Open **Settings → About and Updates → Version History** to expand release notes, with the installed version expanded by default. Available updates show their notes too. History is bundled for offline use and shares the release changelog source.

### Settings

Settings lists its categories on the left and the chosen category's settings
on the right:

- **Appearance**
  - Language: 简体中文, 繁體中文, or English; switches immediately in every open
    window. Error messages from the app are translated too; server output and AI
    replies stay as they are.
  - Theme: Cloud, Dusk, Claude Dark, Claude Light, Graphite, Midnight, Jade,
    Obsidian, or Ivory
  - Window transparency: 100% keeps each theme's own glass, lower values let
    less of what is behind the window show through, 0% is fully opaque
  - Auto-hide top bar toggle
- **Terminal**
  - Terminal font size
  - Default line count for new live tail viewer windows
- **AI Assistant**: API endpoint, encrypted key, model list, default agent permissions, and context compaction (75% of the declared window, 200k by default)
- **About and updates**: current version, a manual update check, and automatic
  checks (on launch and every 6 hours)

When a newer release is available, iShell offers it in a small prompt; it
downloads, verifies and installs the update, then restarts. On Linux, in-app
updates apply to the AppImage; `.deb` and `.rpm` installs update through a new
package from the release page.

Every theme uses Tauri native window effects where available, with a
transparent xterm background so the terminal and panels share one desktop
surface. Cloud, Dusk and the two Claude themes float the terminal, dashboard
and docked panels as rounded cards on a frosted chrome; each theme ships its
own 16-color terminal palette.

## Requirements

- Node.js 22 or newer
- Rust stable toolchain
- Tauri system dependencies for your platform
- OpenSSH on macOS and Linux
- Linux runtime secret storage requires a Secret Service provider such as GNOME
  Keyring or KWallet.

On Linux, install the WebKitGTK and bundling dependencies required by Tauri:

```bash
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf libssl-dev
```

## Development

```bash
npm install
npm run tauri -- dev
```

Frontend-only preview:

```bash
npm run dev
```

Build and verify (CI runs the same on every pull request):

```bash
npm run build
cd src-tauri
cargo clippy --all-targets -- -D warnings
cargo clippy --all-targets --features force-russh -- -D warnings
cargo test
cargo test --features force-russh
```

### Translations

UI text is written in Simplified Chinese and wrapped in `t("…")`; the source
text is the message id, and `src/i18n/locales/*.ts` map it to each language.
Backend messages (Rust and the remote runner) are extracted as templates, so
`translateMessage()` also translates filled-in errors such as
`模型 API 返回 401：…`.

```bash
node scripts/i18n.mjs check
```

`check` lists missing or unused entries (CI fails on missing ones through
`npm test`). Add translations with `node scripts/i18n.mjs merge en new.json`,
where `new.json` maps source text to English. Traditional Chinese is generated
with OpenCC (`pip install opencc-python-reimplemented`, then
`node scripts/i18n.mjs zh-tw`).

## Local Installer Build

```bash
npm ci
npm run tauri -- build
```

Build outputs are written under `src-tauri/target/*/release/bundle/`.

For macOS Intel and Apple Silicon local builds:

```bash
rustup target add x86_64-apple-darwin
npm run tauri -- build --target x86_64-apple-darwin

rustup target add aarch64-apple-darwin
npm run tauri -- build --target aarch64-apple-darwin
```

## Release

Release builds are generated automatically when a `v*` tag is pushed. They can
also be run manually from the **Build installers** workflow in GitHub Actions.

```bash
git tag v1.5.12
git push origin v1.5.12
```

The release workflow builds Windows, Linux, macOS Intel, and macOS Apple Silicon
packages and attaches the installer files to the GitHub release.

### In-app updates

The in-app updater downloads `latest.json` from the latest GitHub release and
only installs packages signed with the project's updater key. The public key is
in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`); the private key is
kept as repository secrets:

- `TAURI_SIGNING_PRIVATE_KEY`: contents of the private key file
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: its password

To generate the key pair, run this in the project directory (it asks for a password):

```bash
npm run tauri signer generate -- -w ~/.tauri/ishell.key
```

With these set, the release workflow signs the update packages (`.app.tar.gz`
for macOS, the NSIS installer for Windows, the AppImage for Linux) and publishes
`latest.json` alongside the installers. Without them the release still builds,
just without update packages. Keep the private key safe: releases signed with a
different key are rejected by installed copies.

## Project Structure

```text
src/
  api/              Tauri IPC wrappers and runtime detection
  components/       React UI components
  constants/        Theme tokens and shared constants
  features/         Hooks and helpers per feature: connections, panes,
                    transfer queues, snippets, port forwards, updates
  mocks/            Browser-preview demo data
  styles/           CSS modules for base, layout, controls, views, and themes
  utils/            Formatting, highlighting and drag helpers
  App.tsx           Workbench layout and tab/pane orchestration

src-tauri/src/
  commands.rs       Tauri command boundary
  models.rs         Serializable DTOs shared by commands
  openssh.rs        OpenSSH arguments, jump host ProxyCommand, askpass helper
  pool.rs           Transport invalidation / pooled-session boundary
  russh_transport.rs Pure-Rust SSH transport used by the Windows backend,
                    including jump hosts and port forwarding
  ssh/              Remote operations: commands, monitoring, SFTP, uploads,
                    downloads
  store.rs          Local database for servers, snippets and port forwards
  tail_monitor.rs   Live remote file tail process registry
  terminal.rs       Interactive terminal session registry
  tunnel.rs         Registry of running port forwards
  time.rs           Small time helper
  lib.rs            Tauri application assembly
```

## Recent Changes

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

## License

iShell is released under the MIT License. See [LICENSE](LICENSE).
