fn main() {
    // Use the pure-Rust `russh` transport on Windows (where spawning the system
    // `ssh` binary plus a POSIX askpass helper is not viable). The same path can
    // be forced on any host for testing via `--features force-russh`.
    println!("cargo:rustc-check-cfg=cfg(russh_backend)");
    let is_windows = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows");
    let forced = std::env::var_os("CARGO_FEATURE_FORCE_RUSSH").is_some();
    if is_windows || forced {
        println!("cargo:rustc-cfg=russh_backend");
    }

    tauri_build::build();
}
