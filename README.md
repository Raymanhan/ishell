# iShell

iShell is a lightweight Tauri + React + Rust SSH workbench with a compact
desktop interface for managing servers, terminals, SFTP files, and live host
status from one place.

> Repository: <https://github.com/Raymanhan/ishell>

## Features

- **SSH manager** — grouped, searchable host list with keychain-encrypted secrets.
- **Interactive terminal** — real PTY sessions rendered with xterm, one per tab.
- **SFTP** — Miller-column file browser with upload, download, mkdir, rename and delete.
- **Live monitoring** — per-host CPU / memory / disk / load dashboard.

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
  ssh.rs            SSH, SFTP and status sampling
  store.rs          Server persistence and keychain secrets
  terminal.rs       Interactive terminal session registry
  time.rs           Small time helper
  lib.rs            Tauri application assembly
```

## Development

```bash
npm install
npm run tauri -- dev
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
git tag v0.1.0
git push origin v0.1.0
```

The release workflow builds Windows, Linux, and macOS packages and attaches the
installer files to the GitHub release.

## License

iShell is released under the MIT License. See [LICENSE](LICENSE).
