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

**[Download iShell v1.1.16](https://github.com/Raymanhan/ishell/releases/tag/v1.1.16)**

Available packages:

- **Windows x64**: `.exe` and `.msi`
- **macOS Intel**: `.dmg`
- **macOS Apple Silicon**: `.dmg`
- **Linux x64**: `.AppImage`, `.deb`, and `.rpm`

## Highlights

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
  and command history.
- **OpenSSH and russh transports**: macOS/Linux use the system OpenSSH client;
  Windows uses a pure-Rust `russh` backend with pooled sessions.
- **SFTP browser**: column or tree browsing, upload, download, rename, delete,
  mkdir, context menus, symlink-aware entries, terminal directory jump, and
  remote text editing for small files.
- **Live monitoring**: CPU, memory, swap, disk, load, processes, and network
  throughput per connected host, plus one-click host/IP copy.
- **Glass desktop UI**: transparent native window, glass gray theme, xterm
  transparency, and platform-tuned font rendering.

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
- The terminal font size is configurable in Settings.
- Command history can be searched and pasted back into the active terminal.

### SFTP

Open the file panel for the active terminal tab to browse the remote filesystem.

Supported operations:

- Switch between tree/detail and multi-column browsing.
- Upload files or folders to the current directory, including folder drag and drop. If a same-named remote folder exists, iShell asks before replacing it in full; replacement does not merge and removes remote-only entries.
- Download selected files.
- Create folders, rename entries, and delete one or more entries.
- Symlinks are shown with link icons and safer delete messaging.
- Jump the active terminal to the selected remote directory from the SFTP
  context menu.
- Open small text files in the built-in editor and save changes back to the
  remote host.
- Use the path bar to jump directly to a directory.

Text editing is intentionally limited to small files so the UI remains
responsive and safe for remote sessions.

### Live Status

The status panel samples remote host information through SSH:

- CPU usage
- Memory and swap
- Disk mounts
- Load average
- Process count
- Network upload/download throughput
- Host/IP copy shortcut

### Settings

Settings currently include:

- Glass gray desktop theme
- Terminal font size

The glass theme uses Tauri native window effects where available, with a
transparent xterm background so the terminal and panels share one desktop
surface.

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

Build and verify:

```bash
npm run build
cd src-tauri
cargo check
cargo check --features force-russh
```

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
git tag v1.1.16
git push origin v1.1.16
```

The release workflow builds Windows, Linux, macOS Intel, and macOS Apple Silicon
packages and attaches the installer files to the GitHub release.

## Project Structure

```text
src/
  api/              Tauri IPC wrappers and runtime detection
  components/       React UI components
  constants/        Theme tokens and shared constants
  features/         Feature-owned types and helpers
  mocks/            Browser-preview demo data
  styles/           CSS modules for base, layout, controls, views, and themes
  utils/            Formatting and filtering helpers
  App.tsx           Application orchestration

src-tauri/src/
  commands.rs       Tauri command boundary
  models.rs         Serializable DTOs shared by commands
  openssh.rs        OpenSSH argument construction and multiplexing helpers
  pool.rs           Transport invalidation / pooled-session boundary
  russh_transport.rs Pure-Rust SSH transport used by the Windows backend
  ssh.rs            SSH, SFTP, file editing, and status sampling
  store.rs          Server persistence and OS keychain secret storage
  terminal.rs       Interactive terminal session registry
  time.rs           Small time helper
  lib.rs            Tauri application assembly
```

## Recent Changes

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
