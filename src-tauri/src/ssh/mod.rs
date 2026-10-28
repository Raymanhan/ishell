//! Everything iShell does on a remote host over SSH. Submodules share this
//! module's imports and each other's helpers through `use super::*`.

#[cfg(any(windows, test))]
use sha2::{Digest, Sha256};
#[cfg(not(russh_backend))]
use std::io::{BufRead, BufReader};
#[cfg(not(russh_backend))]
use std::process::{Command, Stdio};
use std::{
    fs,
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(not(russh_backend))]
use crate::store::jump_hops;
use crate::{
    models::{
        DiskMount, NetworkSample, ProcessUsage, ServerInput, ServerRecord, ServerStatus, SftpEntry,
        UploadProgress,
    },
    openssh,
    pool::SshPool,
    store::{get_server, read_secret},
    time::{now, now_fractional},
};

mod archive;
mod download;
mod monitor;
mod remote;
mod sftp;
mod upload;
mod upload_scripts;

use archive::*;
pub use download::*;
pub use monitor::*;
pub use remote::*;
pub use sftp::*;
pub use upload::*;
use upload_scripts::*;

fn emit_progress(
    app: &AppHandle,
    event_name: &str,
    transfer_id: &str,
    transferred: u64,
    total: u64,
    done: bool,
) {
    app.emit(
        event_name,
        UploadProgress {
            transfer_id: transfer_id.to_string(),
            transferred,
            total,
            done,
        },
    )
    .ok();
}

fn format_bytes(bytes: u64) -> String {
    if bytes >= 1024 * 1024 {
        format!("{} MB", bytes / 1024 / 1024)
    } else if bytes >= 1024 {
        format!("{} KB", bytes / 1024)
    } else {
        format!("{bytes} B")
    }
}
