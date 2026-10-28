//! Downloading files and folders to the local machine.

use super::*;

/// Stream the stdout of `remote_command` into `local`, emitting throttled
/// progress events keyed by `transfer_id`. Shared by single-file downloads
/// and the folder download modes below, across both transport backends.
pub(super) fn stream_remote_to_file(
    app: &AppHandle,
    id: &str,
    remote_command: &str,
    total: u64,
    transfer_id: &str,
    local: &mut fs::File,
    is_canceled: &dyn Fn() -> bool,
) -> Result<(), String> {
    #[cfg(not(russh_backend))]
    {
        let (mut child, helper_path) =
            spawn_remote_ex(app, id, remote_command, false, true, false, false)?;
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| "无法读取 OpenSSH 下载输出".to_string())?;
        let progress = ProgressConfig::new(
            app,
            total,
            transfer_id,
            "sftp-download-progress",
            "下载已停止",
            is_canceled,
        );
        let copy_result = copy_with_progress(&mut stdout, local, progress);
        if copy_result.is_err() {
            let _ = child.kill();
        }
        let output = child
            .wait_with_output()
            .map_err(|err| format!("等待 OpenSSH 下载结束失败：{err}"));
        cleanup_askpass_helper(helper_path.as_ref());
        match copy_result {
            Ok(()) => {}
            Err(err) if err.kind() == io::ErrorKind::Interrupted => {
                return Err("下载已停止".to_string());
            }
            Err(err) => return Err(format!("下载失败：{err}")),
        }
        let output = output?;
        if !output.status.success() {
            return Err(format_process_error("下载失败", &output.stderr));
        }
        Ok(())
    }

    #[cfg(russh_backend)]
    {
        let server = get_server(app, id)?;
        let secret = read_secret(app, id).ok().filter(|value| !value.is_empty());
        emit_progress(app, "sftp-download-progress", transfer_id, 0, total, false);
        let mut last_emit = Instant::now();
        let mut on_progress = |transferred: u64| {
            if last_emit.elapsed() >= Duration::from_millis(80) {
                emit_progress(
                    app,
                    "sftp-download-progress",
                    transfer_id,
                    transferred,
                    total,
                    false,
                );
                last_emit = Instant::now();
            }
        };
        let result = crate::russh_transport::download(
            &server,
            secret.as_deref(),
            remote_command,
            local,
            is_canceled,
            &mut on_progress,
        );
        result.map_err(|err| match err {
            crate::russh_transport::TransferError::Canceled => "下载已停止".to_string(),
            crate::russh_transport::TransferError::Failed(msg) => format!("下载失败：{msg}"),
        })
    }
}

/// Pick a local file path under `dir` that doesn't collide with an existing
/// entry, appending " (n)" before the extension as needed.
pub(super) fn unique_file_path(dir: &Path, file_name: &str) -> PathBuf {
    let mut candidate = dir.join(file_name);
    let mut counter = 1;
    while candidate.exists() {
        let stem = Path::new(file_name)
            .file_stem()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| "download".to_string());
        let ext = Path::new(file_name)
            .extension()
            .map(|value| format!(".{}", value.to_string_lossy()))
            .unwrap_or_default();
        candidate = dir.join(format!("{stem} ({counter}){ext}"));
        counter += 1;
    }
    candidate
}

/// Pick a local directory path under `dir` that doesn't collide with an
/// existing entry, appending " (n)" as needed.
pub(super) fn unique_dir_path(dir: &Path, name: &str) -> PathBuf {
    let mut candidate = dir.join(name);
    let mut counter = 1;
    while candidate.exists() {
        candidate = dir.join(format!("{name} ({counter})"));
        counter += 1;
    }
    candidate
}

pub(super) fn remote_basename(path: &str) -> Option<&str> {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
}

pub(super) fn remote_parent(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rsplit_once('/') {
        Some(("", _)) | None => "/".to_string(),
        Some((parent, _)) => parent.to_string(),
    }
}

#[cfg(windows)]
pub(super) fn local_download_name(name: &str) -> String {
    sanitize_windows_file_name(name)
}

#[cfg(not(windows))]
pub(super) fn local_download_name(name: &str) -> String {
    name.to_string()
}

#[cfg(any(windows, test))]
pub(super) fn sanitize_windows_file_name(name: &str) -> String {
    let characters = name.chars().collect::<Vec<_>>();
    let trailing_start = characters
        .iter()
        .rposition(|character| !matches!(character, ' ' | '.'))
        .map(|index| index + 1)
        .unwrap_or(0);
    let mut sanitized = String::new();
    for (index, character) in characters.into_iter().enumerate() {
        let must_encode = character < '\u{20}'
            || matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            )
            || (index >= trailing_start && matches!(character, ' ' | '.'));
        if must_encode {
            sanitized.push_str(&format!("~{:04X}~", character as u32));
        } else if character == '~' {
            // Escape the marker itself so the mapping remains collision-free.
            sanitized.push_str("~~");
        } else {
            sanitized.push(character);
        }
    }
    if sanitized.is_empty() {
        sanitized = "_".to_string();
    }

    let stem = sanitized
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end()
        .to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'));
    if reserved {
        sanitized.insert_str(0, "~DEV~");
    }

    const MAX_SAFE_UTF16_UNITS: usize = 180;
    if sanitized.encode_utf16().count() > MAX_SAFE_UTF16_UNITS {
        let digest = Sha256::digest(name.as_bytes());
        let suffix = format!(
            "~{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
            digest[0], digest[1], digest[2], digest[3], digest[4], digest[5], digest[6], digest[7]
        );
        let suffix_units = suffix.encode_utf16().count();
        let mut shortened = String::new();
        let mut used_units = 0;
        for character in sanitized.chars() {
            let units = character.len_utf16();
            if used_units + units + suffix_units > MAX_SAFE_UTF16_UNITS {
                break;
            }
            shortened.push(character);
            used_units += units;
        }
        shortened.push_str(&suffix);
        sanitized = shortened;
    }

    sanitized
}

#[cfg(any(windows, test))]
pub(super) fn windows_safe_archive_path(raw: &[u8], allow_parent: bool) -> Result<PathBuf, String> {
    let raw = String::from_utf8_lossy(raw).replace('\\', "/");
    let mut path = PathBuf::new();
    for component in raw.split('/') {
        match component {
            "" | "." => {}
            ".." if allow_parent => path.push(".."),
            ".." => return Err("归档包含不安全的上级目录路径".to_string()),
            value => path.push(sanitize_windows_file_name(value)),
        }
    }
    if path.as_os_str().is_empty() {
        return Err("归档包含空路径".to_string());
    }
    Ok(path)
}

#[cfg(any(windows, test))]
pub(super) fn sanitize_archive_for_windows(
    source: &Path,
    destination: &Path,
) -> Result<(), String> {
    let input = fs::File::open(source).map_err(|err| format!("无法打开待转换归档：{err}"))?;
    let output = fs::File::create(destination).map_err(|err| format!("无法创建兼容归档：{err}"))?;
    let mut archive = tar::Archive::new(input);
    let mut builder = tar::Builder::new(output);
    let entries = archive
        .entries()
        .map_err(|err| format!("无法读取归档条目：{err}"))?;

    for entry in entries {
        let mut entry = entry.map_err(|err| format!("无法读取归档条目：{err}"))?;
        let safe_path = windows_safe_archive_path(entry.path_bytes().as_ref(), false)?;
        let mut header = entry.header().clone();
        header
            .set_path(&safe_path)
            .map_err(|err| format!("无法转换 Windows 文件名：{err}"))?;
        if let Some(link_name) = entry.link_name_bytes() {
            let safe_link = windows_safe_archive_path(link_name.as_ref(), true)?;
            header
                .set_link_name(&safe_link)
                .map_err(|err| format!("无法转换归档链接：{err}"))?;
        }
        header.set_cksum();
        builder
            .append(&header, &mut entry)
            .map_err(|err| format!("无法写入兼容归档：{err}"))?;
    }

    builder
        .finish()
        .map_err(|err| format!("无法完成兼容归档：{err}"))
}

pub(super) fn prepare_archive_for_local_unpack(
    source: &Path,
    transfer_id: &str,
) -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        let destination = source.with_file_name(format!(".ishell-safe-{transfer_id}.tar.tmp"));
        sanitize_archive_for_windows(source, &destination)?;
        Ok(destination)
    }

    #[cfg(not(windows))]
    {
        let _ = transfer_id;
        Ok(source.to_path_buf())
    }
}

pub fn download_file(
    _pool: &SshPool,
    app: &AppHandle,
    id: &str,
    remote_path: &str,
    transfer_id: &str,
    is_canceled: &dyn Fn() -> bool,
) -> Result<String, String> {
    let file_name = remote_basename(remote_path)
        .map(local_download_name)
        .unwrap_or_else(|| "download".to_string());
    let total = remote_file_size(app, id, remote_path).unwrap_or(0);

    let download_dir = app
        .path()
        .download_dir()
        .map_err(|err| format!("无法定位下载目录：{err}"))?;
    fs::create_dir_all(&download_dir).ok();

    let local_path = unique_file_path(&download_dir, &file_name);
    let mut local =
        fs::File::create(&local_path).map_err(|err| format!("无法创建本地文件：{err}"))?;
    let remote_command = format!("cat -- {}", openssh::shell_quote(remote_path));

    if let Err(err) = stream_remote_to_file(
        app,
        id,
        &remote_command,
        total,
        transfer_id,
        &mut local,
        is_canceled,
    ) {
        drop(local);
        let _ = fs::remove_file(&local_path);
        return Err(err);
    }

    let actual = local.metadata().map(|metadata| metadata.len()).unwrap_or(0);
    if total > 0 && actual != total {
        drop(local);
        let _ = fs::remove_file(&local_path);
        return Err(format!(
            "下载文件大小不一致：预期 {total} 字节，实际 {actual} 字节"
        ));
    }

    emit_progress(
        app,
        "sftp-download-progress",
        transfer_id,
        total,
        total,
        true,
    );
    Ok(local_path.to_string_lossy().to_string())
}

/// Download a remote directory either as a compressed archive (`mode ==
/// "archive"`, saved as `<name>.tar.gz`) or "as-is" (`mode == "raw"`,
/// streamed as an uncompressed tar and unpacked locally to preserve the
/// original folder structure).
pub fn download_folder(
    _pool: &SshPool,
    app: &AppHandle,
    id: &str,
    remote_path: &str,
    transfer_id: &str,
    mode: &str,
    is_canceled: &dyn Fn() -> bool,
) -> Result<String, String> {
    let trimmed = remote_path.trim_end_matches('/');
    let remote = if trimmed.is_empty() { "/" } else { trimmed };
    let parent = remote_parent(remote);
    let base_name = remote_basename(remote)
        .map(str::to_string)
        .ok_or_else(|| "无效的远程路径".to_string())?;
    let local_base_name = local_download_name(&base_name);

    let download_dir = app
        .path()
        .download_dir()
        .map_err(|err| format!("无法定位下载目录：{err}"))?;
    fs::create_dir_all(&download_dir).ok();

    match mode {
        "archive" => {
            let local_path = unique_file_path(&download_dir, &format!("{local_base_name}.tar.gz"));
            let mut local =
                fs::File::create(&local_path).map_err(|err| format!("无法创建本地文件：{err}"))?;
            let remote_command = format!(
                "tar czf - -C {} -- {}",
                openssh::shell_quote(&parent),
                openssh::shell_quote(&base_name)
            );
            if let Err(err) = stream_remote_to_file(
                app,
                id,
                &remote_command,
                0,
                transfer_id,
                &mut local,
                is_canceled,
            ) {
                drop(local);
                let _ = fs::remove_file(&local_path);
                return Err(err);
            }
            let total = local.metadata().map(|meta| meta.len()).unwrap_or(0);
            emit_progress(
                app,
                "sftp-download-progress",
                transfer_id,
                total,
                total,
                true,
            );
            Ok(local_path.to_string_lossy().to_string())
        }
        "raw" => {
            let tmp_path = download_dir.join(format!(".ishell-{transfer_id}.tar.tmp"));
            let mut tmp_file =
                fs::File::create(&tmp_path).map_err(|err| format!("无法创建临时文件：{err}"))?;
            let remote_command = format!(
                "tar cf - -C {} -- {}",
                openssh::shell_quote(&parent),
                openssh::shell_quote(&base_name)
            );
            if let Err(err) = stream_remote_to_file(
                app,
                id,
                &remote_command,
                0,
                transfer_id,
                &mut tmp_file,
                is_canceled,
            ) {
                drop(tmp_file);
                let _ = fs::remove_file(&tmp_path);
                return Err(err);
            }
            let total = tmp_file.metadata().map(|meta| meta.len()).unwrap_or(0);
            drop(tmp_file);

            let unpack_path = match prepare_archive_for_local_unpack(&tmp_path, transfer_id) {
                Ok(path) => path,
                Err(err) => {
                    let _ = fs::remove_file(&tmp_path);
                    return Err(err);
                }
            };

            // The tar stream already contains `<base_name>/...` as its top-level
            // entry, so unpack into a scratch root first and then move that
            // extracted folder into its final, collision-free destination name.
            let extract_root = download_dir.join(format!(".ishell-extract-{transfer_id}"));
            let extract_result = fs::File::open(&unpack_path)
                .map_err(|err| format!("无法打开临时归档：{err}"))
                .and_then(|tar_file| {
                    tar::Archive::new(tar_file)
                        .unpack(&extract_root)
                        .map_err(|err| format!("解压失败：{err}"))
                });
            let _ = fs::remove_file(&tmp_path);
            if unpack_path != tmp_path {
                let _ = fs::remove_file(&unpack_path);
            }
            if let Err(err) = extract_result {
                let _ = fs::remove_dir_all(&extract_root);
                return Err(err);
            }

            let extracted = extract_root.join(&local_base_name);
            let dest_dir = unique_dir_path(&download_dir, &local_base_name);
            let move_result =
                fs::rename(&extracted, &dest_dir).map_err(|err| format!("无法移动解压结果：{err}"));
            let _ = fs::remove_dir_all(&extract_root);
            move_result?;

            emit_progress(
                app,
                "sftp-download-progress",
                transfer_id,
                total,
                total,
                true,
            );
            Ok(dest_dir.to_string_lossy().to_string())
        }
        other => Err(format!("未知的下载模式：{other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use uuid::Uuid;

    #[test]
    fn remote_paths_always_use_posix_separators() {
        assert_eq!(remote_basename("/tmp/a\\b.txt"), Some("a\\b.txt"));
        assert_eq!(remote_parent("/tmp/a\\b.txt"), "/tmp");
    }

    #[test]
    fn sanitizes_windows_reserved_names_and_characters() {
        assert_eq!(
            sanitize_windows_file_name("bad:name?.txt"),
            "bad~003A~name~003F~.txt"
        );
        assert_eq!(sanitize_windows_file_name("CON.txt"), "~DEV~CON.txt");
        assert_eq!(
            sanitize_windows_file_name("trailing. "),
            "trailing~002E~~0020~"
        );
        assert!(
            sanitize_windows_file_name(&"x".repeat(255))
                .encode_utf16()
                .count()
                <= 180
        );
    }

    #[test]
    fn rewrites_tar_paths_for_windows_unpacking() {
        let root = std::env::temp_dir().join(format!("ishell-tar-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source.tar");
        let destination = root.join("destination.tar");

        let output = fs::File::create(&source).unwrap();
        let mut builder = tar::Builder::new(output);
        let mut header = tar::Header::new_gnu();
        header.set_path("bad:name/CON.txt").unwrap();
        header.set_size(2);
        header.set_mode(0o644);
        header.set_cksum();
        builder.append(&header, Cursor::new(b"ok")).unwrap();
        builder.finish().unwrap();

        sanitize_archive_for_windows(&source, &destination).unwrap();
        let input = fs::File::open(&destination).unwrap();
        let mut archive = tar::Archive::new(input);
        let paths = archive
            .entries()
            .unwrap()
            .map(|entry| entry.unwrap().path().unwrap().into_owned())
            .collect::<Vec<PathBuf>>();

        assert_eq!(paths, vec![PathBuf::from("bad~003A~name/~DEV~CON.txt")]);
        fs::remove_dir_all(root).unwrap();
    }
}
