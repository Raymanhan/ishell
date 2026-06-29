# iShell

iShell is a lightweight Tauri + React + Rust SSH workbench for managing remote
servers from one compact desktop interface. It brings together server profiles,
interactive terminals, SFTP file operations, quick text editing, command history,
and live host telemetry.

> Repository: <https://github.com/Raymanhan/ishell>

## Features

- **SSH manager** — grouped, searchable host list with color tags, notes, and
  secrets stored outside exported connection files.
- **Connection import / export** — export all or selected folders as JSON or ZIP,
  with optional passphrase protection for saved secrets.
- **Interactive terminal** — xterm-powered tabs backed by a real PTY, with
  reconnect support, platform-tuned fonts, command submission tracking, and
  history suggestions.
- **OpenSSH and russh transports** — Unix-like platforms use the system OpenSSH
  client with multiplexing; Windows uses a pure-Rust `russh` backend with pooled
  sessions.
- **SFTP browser** — Miller-column navigation with upload, download, mkdir,
  rename, delete, and remote text editing for small files.
- **Live monitoring** — per-host CPU, memory, disk, load, process, and network
  throughput telemetry.
- **Cross-platform desktop builds** — Windows, macOS Intel, macOS Apple Silicon,
  and Linux installers are built through GitHub Actions.

## Downloads

Installers are published from GitHub Releases:

- **Windows**: NSIS/MSI installer from the `ishell-windows-x64` artifact.
- **macOS Intel**: DMG from the `ishell-macos-intel` artifact.
- **macOS Apple Silicon**: DMG from the `ishell-macos-arm` artifact.
- **Linux**: DEB/RPM/AppImage bundles from the `ishell-linux-x64` artifact.

Release builds are generated automatically when a `v*` tag is pushed. They can
also be run manually from the **Build installers** workflow in GitHub Actions.

## Requirements

- Node.js 22 or newer
- Rust stable toolchain
- Tauri system dependencies for your platform
- OpenSSH on macOS and Linux
- Linux runtime secret storage requires a Secret Service provider such as
  GNOME Keyring or KWallet.

On Linux, install the WebKitGTK and bundling dependencies required by Tauri:

```bash
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf libssl-dev
```

## Structure

```text
src/
  api/              Tauri IPC wrappers and runtime detection
  components/       Pure React UI components
  constants/        Shared UI constants
  features/         Feature-owned types and helpers
  mocks/            Browser-preview demo data
  utils/            Pure formatting/filtering helpers
  App.tsx           Application orchestration only

src-tauri/src/
  commands.rs       Tauri command boundary
  models.rs         Serializable DTOs shared by commands
  openssh.rs        OpenSSH argument construction and multiplexing helpers
  pool.rs           Transport invalidation / pooled-session boundary
  russh_transport.rs Pure-Rust SSH transport used by the Windows backend
  ssh.rs            SSH, SFTP and status sampling
  store.rs          Server persistence and OS keychain secret storage
  terminal.rs       Interactive terminal session registry
  time.rs           Small time helper
  lib.rs            Tauri application assembly
```

## Development

```bash
npm install
npm run tauri -- dev
```

For frontend-only iteration with mock data:

```bash
npm run dev
```

To compile the pure-Rust SSH backend on non-Windows hosts:

```bash
cd src-tauri
cargo check --features force-russh
```

## Verification

```bash
npm run build
cd src-tauri && cargo check
```

## Build Installers Locally

```bash
npm ci
npm run tauri -- build
```

Build outputs are written under `src-tauri/target/*/release/bundle/`.

For macOS Intel and Apple Silicon builds:

```bash
rustup target add x86_64-apple-darwin
npm run tauri -- build --target x86_64-apple-darwin

rustup target add aarch64-apple-darwin
npm run tauri -- build --target aarch64-apple-darwin
```

## Release

```bash
git tag v1.0.0
git push origin v1.0.0
```

The release workflow builds Windows, Linux, and macOS packages and attaches the
installer files to the GitHub release.

## Recent Changes

- `v1.0.0` adds connection import / export, encrypted secret export, and a small
  remote text editor inside the SFTP browser.
- `v0.1.10` adds terminal history suggestions.
- `v0.1.9` tunes platform font rendering for terminal readability.
- `v0.1.7` / `v0.1.6` add and pool the Windows `russh` terminal backend.
- `v0.1.4` switches Unix-like remote sessions to the system OpenSSH transport.

## License

iShell is released under the MIT License. See [LICENSE](LICENSE).
