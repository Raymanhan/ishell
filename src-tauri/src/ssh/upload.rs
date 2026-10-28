//! Transactional uploads of files and folders, with retry on connection loss.

use super::*;

pub(super) fn remote_upload_temp_path(remote_dir: &str) -> String {
    let name = format!(".ishell-upload-{}.tmp", uuid::Uuid::new_v4());
    if remote_dir == "/" {
        format!("/{name}")
    } else {
        format!("{}/{}", remote_dir.trim_end_matches('/'), name)
    }
}

pub(super) fn transactional_upload_command(
    remote_path: &str,
    temp_path: &str,
    expected_size: u64,
) -> String {
    let python_command = format!(
        "python3 -c {} {} {} {expected_size}",
        openssh::shell_quote(TRANSACTIONAL_UPLOAD_SCRIPT),
        openssh::shell_quote(remote_path),
        openssh::shell_quote(temp_path),
    );
    format!("sh -c {}", openssh::shell_quote(&python_command))
}

pub(super) fn remote_folder_upload_paths(remote_dir: &str) -> (String, String) {
    let token = uuid::Uuid::new_v4();
    let prefix = if remote_dir == "/" {
        String::new()
    } else {
        remote_dir.trim_end_matches('/').to_string()
    };
    (
        format!("{prefix}/.ishell-upload-{token}.tar.tmp"),
        format!("{prefix}/.ishell-upload-{token}.stage"),
    )
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct RemoteFolderRevision {
    revision: String,
    rename_stable: String,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum RemoteFolderTarget {
    Missing,
    Directory(Option<RemoteFolderRevision>),
    Unsupported(String),
    Changed(String),
}

pub(super) fn parse_remote_folder_target(raw: &str) -> Result<RemoteFolderTarget, String> {
    let state = raw.trim();
    if state == "missing" {
        Ok(RemoteFolderTarget::Missing)
    } else if state == "directory" {
        Ok(RemoteFolderTarget::Directory(None))
    } else if let Some(tokens) = state.strip_prefix("directory ") {
        let mut tokens = tokens.split_whitespace();
        let revision = tokens.next().unwrap_or_default();
        let rename_stable = tokens.next().unwrap_or_default();
        let valid_digest =
            |value: &str| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit());
        if tokens.next().is_some() || !valid_digest(revision) || !valid_digest(rename_stable) {
            return Err("远程目标版本令牌无效".to_string());
        }
        Ok(RemoteFolderTarget::Directory(Some(RemoteFolderRevision {
            revision: revision.to_ascii_lowercase(),
            rename_stable: rename_stable.to_ascii_lowercase(),
        })))
    } else if let Some(details) = state.strip_prefix("unsupported ") {
        Ok(RemoteFolderTarget::Unsupported(details.to_string()))
    } else if let Some(details) = state.strip_prefix("changed ") {
        Ok(RemoteFolderTarget::Changed(details.to_string()))
    } else {
        Err(format!("无法识别远程目标类型：{state}"))
    }
}

pub(super) fn probe_remote_folder_target(
    app: &AppHandle,
    id: &str,
    remote_dir: &str,
    folder_name: &str,
    include_revision: bool,
) -> Result<RemoteFolderTarget, String> {
    let include_revision = if include_revision { "1" } else { "0" };
    run_remote_python(
        app,
        id,
        FOLDER_TARGET_PROBE_SCRIPT,
        &[remote_dir, folder_name, include_revision],
    )
    .and_then(|raw| parse_remote_folder_target(&raw))
}

pub(super) fn folder_upload_conflict_error() -> String {
    format!("{UPLOAD_FOLDER_CONFLICT_MARKER} 目标文件夹已存在，请确认是否全量覆盖")
}

#[allow(clippy::too_many_arguments)]
pub(super) fn transactional_folder_upload_command(
    remote_dir: &str,
    folder_name: &str,
    archive_path: &str,
    staging_path: &str,
    expected_size: u64,
    root_mode: u32,
    replace_existing_folder: bool,
    expected_destination_revision: &str,
    expected_destination_stable: &str,
) -> String {
    transactional_folder_upload_command_with_script(
        TRANSACTIONAL_FOLDER_UPLOAD_SCRIPT,
        remote_dir,
        folder_name,
        archive_path,
        staging_path,
        expected_size,
        root_mode,
        replace_existing_folder,
        expected_destination_revision,
        expected_destination_stable,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn transactional_folder_upload_command_with_script(
    script: &str,
    remote_dir: &str,
    folder_name: &str,
    archive_path: &str,
    staging_path: &str,
    expected_size: u64,
    root_mode: u32,
    replace_existing_folder: bool,
    expected_destination_revision: &str,
    expected_destination_stable: &str,
) -> String {
    let replace_existing_folder = u8::from(replace_existing_folder);
    let python_command = format!(
        "python3 -c {} {} {} {} {} {expected_size} {root_mode:o} {replace_existing_folder} {} {}",
        openssh::shell_quote(script),
        openssh::shell_quote(remote_dir),
        openssh::shell_quote(folder_name),
        openssh::shell_quote(archive_path),
        openssh::shell_quote(staging_path),
        openssh::shell_quote(expected_destination_revision),
        openssh::shell_quote(expected_destination_stable),
    );
    format!("sh -c {}", openssh::shell_quote(&python_command))
}

pub(super) fn humanize_upload_error_message(message: &str) -> String {
    message
        .lines()
        .filter_map(|line| {
            if line.contains(UPLOAD_HEARTBEAT_MARKER) {
                None
            } else if line.contains(UPLOAD_TARGET_DIRECTORY_MARKER) {
                Some("目标路径是目录，无法覆盖".to_string())
            } else if let Some(details) = line
                .split_once(UPLOAD_TARGET_UNSUPPORTED_MARKER)
                .map(|(_, details)| details.trim())
            {
                if details.is_empty() {
                    Some("目标不是可安全替换的普通文件".to_string())
                } else {
                    Some(format!("目标不是可安全替换的普通文件（{details}）"))
                }
            } else if line.contains(UPLOAD_TARGET_CHANGED_MARKER) {
                Some("上传期间目标文件发生变化，已取消覆盖".to_string())
            } else if let Some(details) = line
                .split_once(openssh::UPLOAD_SIZE_MISMATCH_MARKER)
                .map(|(_, details)| details.trim())
            {
                if details.is_empty() {
                    Some("上传字节数校验失败".to_string())
                } else {
                    Some(format!("上传字节数校验失败（{details}）"))
                }
            } else if let Some(details) = line
                .split_once(UPLOAD_WRITE_FAILED_MARKER)
                .map(|(_, details)| details.trim())
            {
                if details.is_empty() {
                    Some("远程临时文件写入失败".to_string())
                } else {
                    Some(format!("远程临时文件写入失败（{details}）"))
                }
            } else if let Some(details) = line
                .split_once(UPLOAD_COMMIT_FAILED_MARKER)
                .map(|(_, details)| details.trim())
            {
                if details.is_empty() {
                    Some("远程文件提交失败".to_string())
                } else {
                    Some(format!("远程文件提交失败（{details}）"))
                }
            } else if line.contains(UPLOAD_FOLDER_CONFLICT_MARKER) {
                Some(folder_upload_conflict_error())
            } else if let Some(details) = line
                .split_once(UPLOAD_FOLDER_UNSAFE_MARKER)
                .map(|(_, details)| details.trim())
            {
                Some(if details == "destination-already-exists" {
                    "目标文件夹已存在，为避免破坏现有内容，本次上传未覆盖".to_string()
                } else if details.is_empty() {
                    "文件夹包含不安全条目或远程目标不安全".to_string()
                } else {
                    format!("文件夹包含不安全条目或远程目标不安全（{details}）")
                })
            } else if let Some(details) = line
                .split_once(UPLOAD_FOLDER_EXTRACT_FAILED_MARKER)
                .map(|(_, details)| details.trim())
            {
                Some(if details.is_empty() {
                    "远程解包失败".to_string()
                } else {
                    format!("远程解包失败（{details}）")
                })
            } else if let Some(details) = line
                .split_once(UPLOAD_FOLDER_COMMIT_FAILED_MARKER)
                .map(|(_, details)| details.trim())
            {
                Some(if details.is_empty() {
                    "远程文件夹提交失败".to_string()
                } else {
                    format!("远程文件夹提交失败（{details}）")
                })
            } else if let Some(details) = line
                .split_once(UPLOAD_FOLDER_CHANGED_MARKER)
                .map(|(_, details)| details.trim())
            {
                Some(if details.is_empty() {
                    "上传期间目标文件夹发生变化，已取消覆盖".to_string()
                } else {
                    format!("上传期间目标文件夹发生变化，已取消覆盖（{details}）")
                })
            } else {
                Some(line.to_string())
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn upload_file(
    _pool: &SshPool,
    app: &AppHandle,
    id: &str,
    local_path: &str,
    remote_dir: &str,
    transfer_id: &str,
    is_canceled: &dyn Fn() -> bool,
) -> Result<String, String> {
    let file_name = Path::new(local_path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .ok_or_else(|| "无效的本地文件路径".to_string())?;
    let remote_path = if remote_dir == "/" {
        format!("/{file_name}")
    } else {
        format!("{}/{}", remote_dir.trim_end_matches('/'), file_name)
    };

    let mut local = fs::File::open(local_path).map_err(|err| format!("无法打开本地文件：{err}"))?;
    let total = local
        .metadata()
        .map_err(|err| format!("无法读取本地文件信息：{err}"))?
        .len();
    #[cfg(not(russh_backend))]
    {
        let mut retries = 0;
        loop {
            let temp_path = remote_upload_temp_path(remote_dir);
            let remote_command = transactional_upload_command(&remote_path, &temp_path, total);
            let result = openssh_upload_attempt(
                app,
                id,
                &remote_command,
                &mut local,
                total,
                transfer_id,
                is_canceled,
                true,
            );
            match result {
                Ok(()) => break,
                Err(UploadAttemptError::Canceled) => {
                    let _ = remove_remote_file(app, id, &temp_path);
                    return Err("上传已停止".to_string());
                }
                Err(err) if should_retry_upload(&err, retries, is_canceled()) => {
                    let _ = remove_remote_file(app, id, &temp_path);
                    retries += 1;
                    if let Err(seek_err) = local.seek(SeekFrom::Start(0)) {
                        return Err(format!("无法重试上传：{seek_err}"));
                    }
                }
                Err(UploadAttemptError::Failed { message, .. }) => {
                    let _ = remove_remote_file(app, id, &temp_path);
                    return Err(message);
                }
            }
        }
    }

    #[cfg(russh_backend)]
    {
        let server = get_server(app, id)?;
        let secret = read_secret(app, id).ok().filter(|value| !value.is_empty());
        let mut retries = 0;
        loop {
            emit_progress(app, "sftp-upload-progress", transfer_id, 0, total, false);
            let mut last_emit = Instant::now();
            let mut on_progress = |transferred: u64| {
                if transferred >= total || last_emit.elapsed() >= Duration::from_millis(80) {
                    emit_progress(
                        app,
                        "sftp-upload-progress",
                        transfer_id,
                        transferred,
                        total,
                        false,
                    );
                    last_emit = Instant::now();
                }
            };
            let temp_path = remote_upload_temp_path(remote_dir);
            let remote_command = transactional_upload_command(&remote_path, &temp_path, total);
            let result = crate::russh_transport::upload(
                &server,
                secret.as_deref(),
                &remote_command,
                &mut local,
                false,
                is_canceled,
                &mut on_progress,
            );
            match result {
                Ok(()) => break,
                Err(crate::russh_transport::UploadError::Canceled) => {
                    let _ = remove_remote_file(app, id, &temp_path);
                    return Err("上传已停止".to_string());
                }
                Err(crate::russh_transport::UploadError::Failed { message, retryable }) => {
                    let err = UploadAttemptError::Failed {
                        message: format!("上传失败：{}", humanize_upload_error_message(&message)),
                        retryable,
                    };
                    if should_retry_upload(&err, retries, is_canceled()) {
                        let _ = remove_remote_file(app, id, &temp_path);
                        retries += 1;
                        if let Err(seek_err) = local.seek(SeekFrom::Start(0)) {
                            return Err(format!("无法重试上传：{seek_err}"));
                        }
                        continue;
                    }
                    let _ = remove_remote_file(app, id, &temp_path);
                    let UploadAttemptError::Failed { message, .. } = err;
                    return Err(message);
                }
            }
        }
    }

    emit_progress(app, "sftp-upload-progress", transfer_id, total, total, true);
    Ok(remote_path)
}

pub(super) fn remove_remote_folder_upload_artifacts(
    app: &AppHandle,
    id: &str,
    archive_path: &str,
    staging_path: &str,
    replace_existing_folder: bool,
) {
    if replace_existing_folder {
        // A transport failure after an atomic directory exchange has an
        // uncertain commit result. The staging path may then contain the old
        // destination, so a blind rm -rf could destroy the only recoverable
        // copy. The remote transaction cleans its own artifacts whenever it
        // can determine the outcome.
        return;
    }
    let _ = run_remote_python(
        app,
        id,
        FOLDER_UPLOAD_ARTIFACT_CLEANUP_SCRIPT,
        &[archive_path, staging_path],
    );
}

#[allow(clippy::too_many_arguments)]
pub fn upload_folder(
    _pool: &SshPool,
    app: &AppHandle,
    id: &str,
    local_path: &str,
    remote_dir: &str,
    transfer_id: &str,
    replace_existing_folder: bool,
    is_canceled: &dyn Fn() -> bool,
) -> Result<String, String> {
    let local_root = Path::new(local_path);
    let folder_name = local_root
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty() && *value != "." && *value != "..")
        .ok_or_else(|| "无效的本地文件夹名称".to_string())?
        .to_string();
    let remote_path = if remote_dir == "/" {
        format!("/{folder_name}")
    } else {
        format!("{}/{}", remote_dir.trim_end_matches('/'), folder_name)
    };
    if is_canceled() {
        return Err("上传已停止".to_string());
    }
    let (expected_destination_revision, expected_destination_stable) =
        match probe_remote_folder_target(
            app,
            id,
            remote_dir,
            &folder_name,
            replace_existing_folder,
        )? {
            RemoteFolderTarget::Missing if replace_existing_folder => {
                ("missing".to_string(), "missing".to_string())
            }
            RemoteFolderTarget::Missing => ("unchecked".to_string(), "unchecked".to_string()),
            RemoteFolderTarget::Directory(_) if !replace_existing_folder => {
                return Err(folder_upload_conflict_error());
            }
            RemoteFolderTarget::Directory(Some(revision)) => {
                (revision.revision, revision.rename_stable)
            }
            RemoteFolderTarget::Directory(None) => {
                return Err("远程目标版本预检未返回版本令牌，请重试上传".to_string());
            }
            RemoteFolderTarget::Unsupported(details) => {
                return Err(format!("远程目标不是可安全覆盖的文件夹（{details}）"));
            }
            RemoteFolderTarget::Changed(details) => {
                return Err(format!(
                    "远程目标在覆盖预检期间发生变化，请重试（{details}）"
                ));
            }
        };
    if is_canceled() {
        return Err("上传已停止".to_string());
    }
    emit_progress(app, "sftp-upload-progress", transfer_id, 0, 0, false);
    let mut archive = prepare_folder_archive(local_root, transfer_id, is_canceled)?;
    let total = archive.size;

    #[cfg(not(russh_backend))]
    {
        let mut retries = 0;
        loop {
            let (archive_path, staging_path) = remote_folder_upload_paths(remote_dir);
            let remote_command = transactional_folder_upload_command(
                remote_dir,
                &folder_name,
                &archive_path,
                &staging_path,
                total,
                archive.root_mode,
                replace_existing_folder,
                &expected_destination_revision,
                &expected_destination_stable,
            );
            let result = openssh_upload_attempt(
                app,
                id,
                &remote_command,
                archive.file_mut(),
                total,
                transfer_id,
                is_canceled,
                !replace_existing_folder,
            );
            match result {
                Ok(()) => break,
                Err(UploadAttemptError::Canceled) => {
                    remove_remote_folder_upload_artifacts(
                        app,
                        id,
                        &archive_path,
                        &staging_path,
                        replace_existing_folder,
                    );
                    return Err("上传已停止".to_string());
                }
                Err(error)
                    if !replace_existing_folder
                        && should_retry_upload(&error, retries, is_canceled()) =>
                {
                    remove_remote_folder_upload_artifacts(
                        app,
                        id,
                        &archive_path,
                        &staging_path,
                        replace_existing_folder,
                    );
                    retries += 1;
                    archive
                        .file_mut()
                        .seek(SeekFrom::Start(0))
                        .map_err(|err| format!("无法重试文件夹上传：{err}"))?;
                }
                Err(UploadAttemptError::Failed { message, .. }) => {
                    remove_remote_folder_upload_artifacts(
                        app,
                        id,
                        &archive_path,
                        &staging_path,
                        replace_existing_folder,
                    );
                    return Err(message);
                }
            }
        }
    }

    #[cfg(russh_backend)]
    {
        let server = get_server(app, id)?;
        let secret = read_secret(app, id).ok().filter(|value| !value.is_empty());
        let mut retries = 0;
        loop {
            emit_progress(app, "sftp-upload-progress", transfer_id, 0, total, false);
            let mut last_emit = Instant::now();
            let mut on_progress = |transferred: u64| {
                if transferred >= total || last_emit.elapsed() >= Duration::from_millis(80) {
                    emit_progress(
                        app,
                        "sftp-upload-progress",
                        transfer_id,
                        transferred,
                        total,
                        false,
                    );
                    last_emit = Instant::now();
                }
            };
            let (archive_path, staging_path) = remote_folder_upload_paths(remote_dir);
            let remote_command = transactional_folder_upload_command(
                remote_dir,
                &folder_name,
                &archive_path,
                &staging_path,
                total,
                archive.root_mode,
                replace_existing_folder,
                &expected_destination_revision,
                &expected_destination_stable,
            );
            let result = crate::russh_transport::upload(
                &server,
                secret.as_deref(),
                &remote_command,
                archive.file_mut(),
                replace_existing_folder,
                is_canceled,
                &mut on_progress,
            );
            match result {
                Ok(()) => break,
                Err(crate::russh_transport::UploadError::Canceled) => {
                    remove_remote_folder_upload_artifacts(
                        app,
                        id,
                        &archive_path,
                        &staging_path,
                        replace_existing_folder,
                    );
                    return Err("上传已停止".to_string());
                }
                Err(crate::russh_transport::UploadError::Failed { message, retryable }) => {
                    let error = UploadAttemptError::Failed {
                        message: format!("上传失败：{}", humanize_upload_error_message(&message)),
                        retryable,
                    };
                    if !replace_existing_folder
                        && should_retry_upload(&error, retries, is_canceled())
                    {
                        remove_remote_folder_upload_artifacts(
                            app,
                            id,
                            &archive_path,
                            &staging_path,
                            replace_existing_folder,
                        );
                        retries += 1;
                        archive
                            .file_mut()
                            .seek(SeekFrom::Start(0))
                            .map_err(|err| format!("无法重试文件夹上传：{err}"))?;
                        continue;
                    }
                    remove_remote_folder_upload_artifacts(
                        app,
                        id,
                        &archive_path,
                        &staging_path,
                        replace_existing_folder,
                    );
                    let UploadAttemptError::Failed { message, .. } = error;
                    return Err(message);
                }
            }
        }
    }

    emit_progress(app, "sftp-upload-progress", transfer_id, total, total, true);
    Ok(remote_path)
}

#[derive(Debug)]
pub(super) enum UploadAttemptError {
    #[cfg(not(russh_backend))]
    Canceled,
    Failed {
        message: String,
        retryable: bool,
    },
}

pub(super) fn should_retry_upload(
    error: &UploadAttemptError,
    retries: usize,
    is_canceled: bool,
) -> bool {
    retries == 0
        && !is_canceled
        && matches!(
            error,
            UploadAttemptError::Failed {
                retryable: true,
                ..
            }
        )
}

#[cfg(not(russh_backend))]
#[allow(clippy::too_many_arguments)]
pub(super) fn openssh_upload_attempt(
    app: &AppHandle,
    id: &str,
    remote_command: &str,
    local: &mut fs::File,
    total: u64,
    transfer_id: &str,
    is_canceled: &dyn Fn() -> bool,
    cancel_while_waiting: bool,
) -> Result<(), UploadAttemptError> {
    let (mut child, helper_path) =
        spawn_remote_ex(app, id, remote_command, true, false, true, false).map_err(|message| {
            UploadAttemptError::Failed {
                message: format!("上传失败：{message}"),
                retryable: false,
            }
        })?;

    let stderr_reader = child.stderr.take().map(|mut stderr| {
        std::thread::spawn(move || {
            let mut output = Vec::new();
            stderr.read_to_end(&mut output)?;
            Ok::<Vec<u8>, io::Error>(output)
        })
    });

    let mut stdin = match child.stdin.take() {
        Some(stdin) => stdin,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            let _ = join_stderr_reader(stderr_reader);
            cleanup_askpass_helper(helper_path.as_ref());
            return Err(UploadAttemptError::Failed {
                message: "上传失败：无法写入 OpenSSH 上传输入".to_string(),
                retryable: false,
            });
        }
    };
    let progress = ProgressConfig::new(
        app,
        total,
        transfer_id,
        "sftp-upload-progress",
        "上传已停止",
        is_canceled,
    );
    let copy_result = copy_upload_with_progress(local, &mut stdin, progress);
    drop(stdin);

    if matches!(
        &copy_result,
        Err(UploadCopyError::Canceled | UploadCopyError::Read { .. })
    ) {
        let _ = child.kill();
    }
    let mut canceled_while_waiting = false;
    let status = loop {
        if cancel_while_waiting && is_canceled() {
            canceled_while_waiting = true;
            let _ = child.kill();
            break child.wait();
        }
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(error) => break Err(error),
        }
    };
    if status.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    let stderr = join_stderr_reader(stderr_reader);
    cleanup_askpass_helper(helper_path.as_ref());

    let status = match status {
        Ok(status) => status,
        Err(wait_error) => {
            let fallback = copy_result
                .as_ref()
                .err()
                .map(UploadCopyError::description)
                .unwrap_or_else(|| "OpenSSH 上传进程提前结束".to_string());
            return Err(UploadAttemptError::Failed {
                message: format!("上传失败：{fallback}；等待 OpenSSH 上传结束失败：{wait_error}"),
                retryable: copy_result
                    .as_ref()
                    .err()
                    .is_some_and(upload_copy_is_connection_error),
            });
        }
    };
    let stderr =
        stderr.unwrap_or_else(|error| format!("无法读取 OpenSSH 错误输出：{error}").into_bytes());

    if canceled_while_waiting {
        return Err(UploadAttemptError::Canceled);
    }

    match copy_result {
        Err(UploadCopyError::Canceled) => Err(UploadAttemptError::Canceled),
        Err(error) => {
            let retryable = openssh_upload_is_retryable(&status, &stderr, Some(&error));
            Err(UploadAttemptError::Failed {
                message: format_upload_attempt_failure(&status, &stderr, &error.description()),
                retryable,
            })
        }
        Ok(_) if !status.success() => Err(UploadAttemptError::Failed {
            message: format_upload_attempt_failure(&status, &stderr, "OpenSSH 上传进程提前退出"),
            retryable: openssh_upload_is_retryable(&status, &stderr, None),
        }),
        Ok(_) => Ok(()),
    }
}

#[cfg(not(russh_backend))]
pub(super) fn join_stderr_reader(
    reader: Option<std::thread::JoinHandle<io::Result<Vec<u8>>>>,
) -> Result<Vec<u8>, String> {
    match reader {
        Some(reader) => reader
            .join()
            .map_err(|_| "OpenSSH 错误输出线程异常退出".to_string())?
            .map_err(|error| error.to_string()),
        None => Ok(Vec::new()),
    }
}

#[cfg(not(russh_backend))]
pub(super) fn upload_copy_is_connection_error(error: &UploadCopyError) -> bool {
    matches!(
        error,
        UploadCopyError::Write { error, .. }
            if matches!(
                error.kind(),
                io::ErrorKind::BrokenPipe
                    | io::ErrorKind::ConnectionReset
                    | io::ErrorKind::ConnectionAborted
                    | io::ErrorKind::NotConnected
                    | io::ErrorKind::UnexpectedEof
                    | io::ErrorKind::TimedOut
            )
    )
}

#[cfg(not(russh_backend))]
pub(super) fn openssh_upload_is_retryable(
    status: &std::process::ExitStatus,
    stderr: &[u8],
    copy_error: Option<&UploadCopyError>,
) -> bool {
    if matches!(copy_error, Some(UploadCopyError::Read { .. })) {
        return false;
    }
    let stderr = String::from_utf8_lossy(stderr);
    if stderr.contains(openssh::UPLOAD_SIZE_MISMATCH_MARKER) {
        return true;
    }
    let normalized = stderr.to_ascii_lowercase();
    let permanent_ssh_error = [
        "permission denied",
        "remote host identification has changed",
        "host key verification failed",
        "could not resolve hostname",
        "hostname contains invalid characters",
        "bad configuration option",
        "no such identity",
        "identity file",
        "load key",
        "invalid format",
        "no supported authentication methods",
        "too many authentication failures",
        "unable to negotiate",
    ]
    .iter()
    .any(|needle| normalized.contains(needle));
    if permanent_ssh_error {
        return false;
    }
    if status.code() == Some(255) {
        return true;
    }
    if status.code().is_some() && !status.success() {
        return false;
    }
    copy_error.is_some_and(upload_copy_is_connection_error)
}

/// Stream the file in chunks, emitting throttled progress events (at most every
/// ~80ms) so the UI can render a live progress bar without being flooded by one
/// event per chunk on large transfers.
#[cfg(not(russh_backend))]
pub(super) struct ProgressConfig<'a> {
    app: &'a AppHandle,
    total: u64,
    transfer_id: &'a str,
    event_name: &'a str,
    stop_message: &'a str,
    is_canceled: &'a dyn Fn() -> bool,
}

#[cfg(not(russh_backend))]
impl<'a> ProgressConfig<'a> {
    pub(super) fn new(
        app: &'a AppHandle,
        total: u64,
        transfer_id: &'a str,
        event_name: &'a str,
        stop_message: &'a str,
        is_canceled: &'a dyn Fn() -> bool,
    ) -> Self {
        Self {
            app,
            total,
            transfer_id,
            event_name,
            stop_message,
            is_canceled,
        }
    }
}

#[cfg(not(russh_backend))]
#[derive(Debug)]
pub(super) enum UploadCopyError {
    Canceled,
    Read { error: io::Error },
    Write { error: io::Error },
}

#[cfg(not(russh_backend))]
impl UploadCopyError {
    fn description(&self) -> String {
        match self {
            Self::Canceled => "上传已停止".to_string(),
            Self::Read { error, .. } => format!("读取本地文件失败：{error}"),
            Self::Write { error, .. } => format!("写入 OpenSSH 上传输入失败：{error}"),
        }
    }
}

/// Upload-specific copy loop that records exact progress and distinguishes local
/// read failures from connection-oriented child-stdin failures.
#[cfg(not(russh_backend))]
pub(super) fn copy_upload_stream(
    reader: &mut impl Read,
    writer: &mut impl Write,
    is_canceled: &dyn Fn() -> bool,
    on_progress: &mut dyn FnMut(u64),
) -> Result<u64, UploadCopyError> {
    let mut buffer = vec![0u8; 64 * 1024];
    let mut transferred = 0_u64;

    loop {
        if is_canceled() {
            return Err(UploadCopyError::Canceled);
        }
        let read = loop {
            match reader.read(&mut buffer) {
                Ok(read) => break read,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(UploadCopyError::Read { error }),
            }
        };
        if read == 0 {
            return Ok(transferred);
        }

        let mut offset = 0;
        while offset < read {
            if is_canceled() {
                return Err(UploadCopyError::Canceled);
            }
            match writer.write(&buffer[offset..read]) {
                Ok(0) => {
                    return Err(UploadCopyError::Write {
                        error: io::Error::new(
                            io::ErrorKind::WriteZero,
                            "OpenSSH 上传输入未接受数据",
                        ),
                    });
                }
                Ok(written) => {
                    offset += written;
                    transferred += written as u64;
                    on_progress(transferred);
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(UploadCopyError::Write { error }),
            }
        }
    }
}

#[cfg(not(russh_backend))]
pub(super) fn copy_upload_with_progress(
    reader: &mut impl Read,
    writer: &mut impl Write,
    progress: ProgressConfig<'_>,
) -> Result<u64, UploadCopyError> {
    let mut last_emit = Instant::now();
    emit_progress(
        progress.app,
        progress.event_name,
        progress.transfer_id,
        0,
        progress.total,
        false,
    );
    let mut on_progress = |transferred: u64| {
        if transferred >= progress.total || last_emit.elapsed() >= Duration::from_millis(80) {
            emit_progress(
                progress.app,
                progress.event_name,
                progress.transfer_id,
                transferred,
                progress.total,
                false,
            );
            last_emit = Instant::now();
        }
    };
    copy_upload_stream(reader, writer, progress.is_canceled, &mut on_progress)
}

#[cfg(not(russh_backend))]
pub(super) fn copy_with_progress(
    reader: &mut impl Read,
    writer: &mut impl Write,
    progress: ProgressConfig<'_>,
) -> io::Result<()> {
    let mut buffer = vec![0u8; 64 * 1024];
    let mut transferred: u64 = 0;
    let mut last_emit = Instant::now();
    emit_progress(
        progress.app,
        progress.event_name,
        progress.transfer_id,
        0,
        progress.total,
        false,
    );

    loop {
        if (progress.is_canceled)() {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                progress.stop_message.to_string(),
            ));
        }
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        if (progress.is_canceled)() {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                progress.stop_message.to_string(),
            ));
        }
        writer.write_all(&buffer[..read])?;
        transferred += read as u64;

        if last_emit.elapsed() >= Duration::from_millis(80) {
            emit_progress(
                progress.app,
                progress.event_name,
                progress.transfer_id,
                transferred,
                progress.total,
                false,
            );
            last_emit = Instant::now();
        }
    }

    Ok(())
}

#[cfg(not(russh_backend))]
pub(super) fn format_upload_attempt_failure(
    status: &std::process::ExitStatus,
    stderr: &[u8],
    fallback: &str,
) -> String {
    let stderr = humanize_upload_error_message(String::from_utf8_lossy(stderr).trim());
    if !stderr.is_empty() {
        format!("上传失败：{stderr}")
    } else if !status.success() {
        format!("上传失败（OpenSSH {status}）：{fallback}")
    } else {
        format!("上传失败：{fallback}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(not(russh_backend))]
    use std::io::Cursor;
    use uuid::Uuid;

    #[cfg(not(russh_backend))]
    struct BrokenPipeWriter {
        bytes_before_failure: usize,
        written: usize,
    }

    #[cfg(not(russh_backend))]
    impl Write for BrokenPipeWriter {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            if self.written >= self.bytes_before_failure {
                return Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed"));
            }
            let written = buffer.len().min(self.bytes_before_failure - self.written);
            self.written += written;
            Ok(written)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn retries_only_one_transactional_connection_failure() {
        let retryable = UploadAttemptError::Failed {
            message: "connection closed".to_string(),
            retryable: true,
        };
        assert!(should_retry_upload(&retryable, 0, false));
        assert!(!should_retry_upload(&retryable, 1, false));
        assert!(!should_retry_upload(&retryable, 0, true));

        let partial = UploadAttemptError::Failed {
            message: "connection closed".to_string(),
            retryable: true,
        };
        assert!(should_retry_upload(&partial, 0, false));

        let local_read_failure = UploadAttemptError::Failed {
            message: "local read failed".to_string(),
            retryable: false,
        };
        assert!(!should_retry_upload(&local_read_failure, 0, false));
    }

    #[test]
    fn transactional_upload_uses_unique_same_directory_temp_and_atomic_commit() {
        let first = remote_upload_temp_path("/srv/files");
        let second = remote_upload_temp_path("/srv/files");
        assert_ne!(first, second);
        assert!(first.starts_with("/srv/files/.ishell-upload-"));
        assert!(second.starts_with("/srv/files/.ishell-upload-"));

        let command = transactional_upload_command("/srv/files/final.bin", &first, 123);
        assert!(command.starts_with("sh -c "));
        assert!(command.contains("python3 -c"));
        assert!(command.contains(" 123"));
        assert!(command.contains("__ISHELL_UPLOAD_TARGET_IS_DIRECTORY__"));
        assert!(command.contains("__ISHELL_UPLOAD_SIZE_MISMATCH__"));
        assert!(command.contains("os.replace"));
        assert!(command.contains("os.unlink"));
    }

    #[test]
    fn prepares_retryable_folder_archive_without_root_wrapper() {
        let root = std::env::temp_dir().join(format!("ishell-folder-test-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("nested/empty")).unwrap();
        fs::write(root.join("alpha.txt"), b"alpha").unwrap();
        fs::write(root.join("nested/beta.txt"), b"beta").unwrap();
        let mut prepared = prepare_folder_archive(&root, "folder-test", &|| false).unwrap();
        let archive_path = prepared.path.clone();
        let mut input = prepared.file_mut().try_clone().unwrap();
        input.seek(std::io::SeekFrom::Start(0)).unwrap();
        let mut archive = tar::Archive::new(input);
        let mut paths = archive
            .entries()
            .unwrap()
            .map(|entry| entry.unwrap().path().unwrap().into_owned())
            .collect::<Vec<_>>();
        paths.sort();
        assert!(paths.contains(&PathBuf::from("alpha.txt")));
        assert!(paths.contains(&PathBuf::from("nested")));
        assert!(paths.contains(&PathBuf::from("nested/beta.txt")));
        assert!(!paths
            .iter()
            .any(|path| path.starts_with(root.file_name().unwrap())));
        drop(archive);
        drop(prepared);
        assert!(!archive_path.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn folder_archive_rejects_source_changes_after_its_temp_file_is_created() {
        let root = std::env::temp_dir().join(format!("ishell-folder-mutation-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("seed.txt"), b"seed").unwrap();
        let transfer_id = format!(
            "mutate-{}",
            Uuid::new_v4()
                .simple()
                .to_string()
                .chars()
                .take(8)
                .collect::<String>()
        );
        let archive_prefix = format!("ishell-folder-{transfer_id}-");
        let callbacks_after_archive = std::cell::Cell::new(0_u32);
        let injected = std::cell::Cell::new(false);
        let is_canceled = || {
            let archive_exists = fs::read_dir(std::env::temp_dir())
                .unwrap()
                .filter_map(Result::ok)
                .any(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with(&archive_prefix)
                });
            if archive_exists && !injected.get() {
                let count = callbacks_after_archive.get() + 1;
                callbacks_after_archive.set(count);
                if count == 3 {
                    fs::write(root.join("concurrent.txt"), b"concurrent").unwrap();
                    injected.set(true);
                }
            }
            false
        };

        let error = prepare_folder_archive(&root, &transfer_id, &is_canceled).unwrap_err();
        assert!(injected.get());
        assert!(error.contains("打包期间发生变化"), "{error}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn folder_packaging_cancel_error_is_not_retried_as_interrupted_io() {
        let path = std::env::temp_dir().join(format!("ishell-cancel-reader-{}", Uuid::new_v4()));
        fs::write(&path, b"data").unwrap();
        let file = fs::File::open(&path).unwrap();
        let mut reader = CancelReader {
            inner: file,
            is_canceled: &|| true,
        };
        let error = std::io::Read::read(&mut reader, &mut [0_u8; 4]).unwrap_err();
        assert_ne!(error.kind(), std::io::ErrorKind::Interrupted);
        fs::remove_file(path).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn folder_archive_rejects_symlinks_and_special_files() {
        use std::os::unix::fs::symlink;
        use std::os::unix::net::UnixListener;

        let root = PathBuf::from("/tmp").join(format!(
            "ifu-{}",
            Uuid::new_v4()
                .simple()
                .to_string()
                .chars()
                .take(8)
                .collect::<String>()
        ));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("target"), b"data").unwrap();
        symlink(root.join("target"), root.join("link")).unwrap();
        assert!(prepare_folder_archive(&root, "unsafe", &|| false)
            .unwrap_err()
            .contains("符号链接"));
        fs::remove_file(root.join("link")).unwrap();
        let _socket = match UnixListener::bind(root.join("socket")) {
            Ok(socket) => socket,
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                fs::remove_dir_all(root).unwrap();
                return;
            }
            Err(error) => panic!("failed to create Unix socket fixture: {error}"),
        };
        assert!(prepare_folder_archive(&root, "unsafe", &|| false)
            .unwrap_err()
            .contains("特殊文件"));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(not(russh_backend))]
    fn run_folder_upload_script(
        prepared: &mut PreparedFolderArchive,
        remote: &Path,
        folder_name: &str,
        replace_existing_folder: bool,
        expected_size: u64,
    ) -> (std::process::Output, String, String) {
        run_folder_upload_script_with_source(
            prepared,
            remote,
            folder_name,
            replace_existing_folder,
            expected_size,
            TRANSACTIONAL_FOLDER_UPLOAD_SCRIPT,
        )
    }

    #[cfg(not(russh_backend))]
    fn run_folder_upload_script_with_source(
        prepared: &mut PreparedFolderArchive,
        remote: &Path,
        folder_name: &str,
        replace_existing_folder: bool,
        expected_size: u64,
        script: &str,
    ) -> (std::process::Output, String, String) {
        let (archive_path, staging_path) = remote_folder_upload_paths(remote.to_str().unwrap());
        let (expected_revision, expected_stable) =
            folder_revision_tokens_for_test(remote, folder_name, replace_existing_folder);
        let command = transactional_folder_upload_command_with_script(
            script,
            remote.to_str().unwrap(),
            folder_name,
            &archive_path,
            &staging_path,
            expected_size,
            prepared.root_mode,
            replace_existing_folder,
            &expected_revision,
            &expected_stable,
        );
        let mut input = prepared.file_mut().try_clone().unwrap();
        input.seek(std::io::SeekFrom::Start(0)).unwrap();
        let output = std::process::Command::new("/bin/sh")
            .args(["-c", &command])
            .stdin(Stdio::from(input))
            .stderr(Stdio::piped())
            .output()
            .unwrap();
        (output, archive_path, staging_path)
    }

    #[cfg(not(russh_backend))]
    fn folder_revision_tokens_for_test(
        remote: &Path,
        folder_name: &str,
        replace_existing_folder: bool,
    ) -> (String, String) {
        if !replace_existing_folder {
            return ("unchecked".to_string(), "unchecked".to_string());
        }
        let target = remote.join(folder_name);
        let Ok(metadata) = fs::symlink_metadata(&target) else {
            return ("missing".to_string(), "missing".to_string());
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return ("missing".to_string(), "missing".to_string());
        }
        let output = std::process::Command::new("python3")
            .args([
                "-c",
                FOLDER_TARGET_PROBE_SCRIPT,
                remote.to_str().unwrap(),
                folder_name,
                "1",
            ])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        match parse_remote_folder_target(&String::from_utf8(output.stdout).unwrap()).unwrap() {
            RemoteFolderTarget::Directory(Some(revision)) => {
                (revision.revision, revision.rename_stable)
            }
            other => panic!("unexpected folder probe result: {other:?}"),
        }
    }

    #[cfg(not(russh_backend))]
    fn assert_folder_upload_artifacts_removed(archive_path: &str, staging_path: &str) {
        assert!(!Path::new(archive_path).exists());
        assert!(!Path::new(staging_path).exists());
        assert!(!Path::new(&format!("{staging_path}.backup")).exists());
    }

    #[cfg(not(russh_backend))]
    #[test]
    fn folder_upload_conflict_preserves_old_then_confirmed_replace_is_full() {
        let sandbox = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("ishell-folder-remote-{}", Uuid::new_v4()));
        let local = sandbox.join("source-folder");
        let remote = sandbox.join("remote");
        fs::create_dir_all(local.join("nested")).unwrap();
        fs::create_dir_all(&remote).unwrap();
        fs::write(local.join("nested/file.txt"), b"folder-data").unwrap();
        let mut prepared = prepare_folder_archive(&local, "remote-test", &|| false).unwrap();
        let destination = remote.join("source-folder");
        fs::create_dir_all(destination.join("old-only")).unwrap();
        fs::write(destination.join("keep.txt"), b"old-data").unwrap();
        fs::write(destination.join("old-only/remote.txt"), b"remote-only").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("keep.txt", destination.join("old-link")).unwrap();

        let expected_size = prepared.size;
        let (conflict, conflict_archive, conflict_staging) = run_folder_upload_script(
            &mut prepared,
            &remote,
            "source-folder",
            false,
            expected_size,
        );
        assert!(!conflict.status.success());
        assert!(String::from_utf8_lossy(&conflict.stderr).contains(UPLOAD_FOLDER_CONFLICT_MARKER));
        assert_eq!(fs::read(destination.join("keep.txt")).unwrap(), b"old-data");
        assert_folder_upload_artifacts_removed(&conflict_archive, &conflict_staging);

        let (output, archive_path, staging_path) =
            run_folder_upload_script(&mut prepared, &remote, "source-folder", true, expected_size);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            fs::read(destination.join("nested/file.txt")).unwrap(),
            b"folder-data"
        );
        assert!(!destination.join("keep.txt").exists());
        assert!(!destination.join("old-only").exists());
        assert!(!destination.join("old-link").exists());
        assert_folder_upload_artifacts_removed(&archive_path, &staging_path);
        fs::remove_dir_all(sandbox).unwrap();
    }

    #[cfg(not(russh_backend))]
    #[test]
    fn folder_replace_rolls_back_if_old_changes_during_atomic_commit() {
        let sandbox = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("ishell-folder-rollback-{}", Uuid::new_v4()));
        let local = sandbox.join("source-folder");
        let remote = sandbox.join("remote");
        let destination = remote.join("source-folder");
        fs::create_dir_all(&local).unwrap();
        fs::create_dir_all(&destination).unwrap();
        fs::write(local.join("new.txt"), b"new-data").unwrap();
        fs::write(destination.join("old.txt"), b"old-data").unwrap();
        let mut prepared = prepare_folder_archive(&local, "rollback-test", &|| false).unwrap();
        let expected_size = prepared.size;

        let exchange_marker =
            "            staging_contains_old = True\n\n            exchanged_destination";
        let injected_exchange = "            staging_contains_old = True\n            with open(os.path.join(staging_path, \"concurrent.txt\"), \"wb\") as changed:\n                changed.write(b\"concurrent\")\n\n            exchanged_destination";
        let rollback_script =
            TRANSACTIONAL_FOLDER_UPLOAD_SCRIPT.replacen(exchange_marker, injected_exchange, 1);
        assert_ne!(rollback_script, TRANSACTIONAL_FOLDER_UPLOAD_SCRIPT);

        let (output, archive_path, staging_path) = run_folder_upload_script_with_source(
            &mut prepared,
            &remote,
            "source-folder",
            true,
            expected_size,
            &rollback_script,
        );
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains(UPLOAD_FOLDER_CHANGED_MARKER));
        assert_eq!(fs::read(destination.join("old.txt")).unwrap(), b"old-data");
        assert_eq!(
            fs::read(destination.join("concurrent.txt")).unwrap(),
            b"concurrent"
        );
        assert!(!destination.join("new.txt").exists());
        assert_folder_upload_artifacts_removed(&archive_path, &staging_path);
        fs::remove_dir_all(sandbox).unwrap();
    }

    #[cfg(not(russh_backend))]
    #[test]
    fn folder_upload_does_not_overwrite_destination_created_during_transfer() {
        let sandbox = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("ishell-folder-race-{}", Uuid::new_v4()));
        let local = sandbox.join("raced-folder");
        let remote = sandbox.join("remote");
        fs::create_dir_all(&local).unwrap();
        fs::create_dir_all(&remote).unwrap();
        fs::write(local.join("new.txt"), b"new-data").unwrap();
        let mut prepared = prepare_folder_archive(&local, "race-test", &|| false).unwrap();
        let (archive_path, staging_path) = remote_folder_upload_paths(remote.to_str().unwrap());
        let command = transactional_folder_upload_command(
            remote.to_str().unwrap(),
            "raced-folder",
            &archive_path,
            &staging_path,
            prepared.size,
            prepared.root_mode,
            false,
            "unchecked",
            "unchecked",
        );
        let mut child = std::process::Command::new("/bin/sh")
            .args(["-c", &command])
            .stdin(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        for _ in 0..500 {
            if Path::new(&archive_path).exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        if !Path::new(&archive_path).exists() {
            drop(child.stdin.take());
            let output = child.wait_with_output().unwrap();
            panic!(
                "remote archive was not created: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        let destination = remote.join("raced-folder");
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("keep.txt"), b"concurrent").unwrap();
        let mut input = prepared.file_mut().try_clone().unwrap();
        input.seek(std::io::SeekFrom::Start(0)).unwrap();
        std::io::copy(&mut input, &mut child.stdin.take().unwrap()).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains(UPLOAD_FOLDER_CONFLICT_MARKER));
        assert_eq!(
            fs::read(destination.join("keep.txt")).unwrap(),
            b"concurrent"
        );
        assert!(!destination.join("new.txt").exists());
        assert_folder_upload_artifacts_removed(&archive_path, &staging_path);
        fs::remove_dir_all(sandbox).unwrap();
    }

    #[cfg(not(russh_backend))]
    #[test]
    fn folder_replace_rejects_remote_changes_while_archive_is_in_flight() {
        let sandbox = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("ishell-folder-revision-race-{}", Uuid::new_v4()));
        let local = sandbox.join("source-folder");
        let remote = sandbox.join("remote");
        let destination = remote.join("source-folder");
        fs::create_dir_all(&local).unwrap();
        fs::create_dir_all(&destination).unwrap();
        fs::write(local.join("new.txt"), b"new-data").unwrap();
        fs::write(destination.join("old.txt"), b"old-data").unwrap();
        let mut prepared = prepare_folder_archive(&local, "revision-race-test", &|| false).unwrap();
        let (expected_revision, expected_stable) =
            folder_revision_tokens_for_test(&remote, "source-folder", true);
        let (archive_path, staging_path) = remote_folder_upload_paths(remote.to_str().unwrap());
        let command = transactional_folder_upload_command(
            remote.to_str().unwrap(),
            "source-folder",
            &archive_path,
            &staging_path,
            prepared.size,
            prepared.root_mode,
            true,
            &expected_revision,
            &expected_stable,
        );
        let mut child = std::process::Command::new("/bin/sh")
            .args(["-c", &command])
            .stdin(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        for _ in 0..500 {
            if Path::new(&archive_path).exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        if !Path::new(&archive_path).exists() {
            drop(child.stdin.take());
            let output = child.wait_with_output().unwrap();
            panic!(
                "remote archive was not created: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        fs::write(destination.join("concurrent.txt"), b"concurrent").unwrap();
        let mut input = prepared.file_mut().try_clone().unwrap();
        input.seek(std::io::SeekFrom::Start(0)).unwrap();
        std::io::copy(&mut input, &mut child.stdin.take().unwrap()).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains(UPLOAD_FOLDER_CHANGED_MARKER));
        assert_eq!(fs::read(destination.join("old.txt")).unwrap(), b"old-data");
        assert_eq!(
            fs::read(destination.join("concurrent.txt")).unwrap(),
            b"concurrent"
        );
        assert!(!destination.join("new.txt").exists());
        assert_folder_upload_artifacts_removed(&archive_path, &staging_path);
        fs::remove_dir_all(sandbox).unwrap();
    }

    #[cfg(not(russh_backend))]
    #[test]
    fn folder_upload_script_refuses_to_cross_mount_points() {
        assert!(TRANSACTIONAL_FOLDER_UPLOAD_SCRIPT.contains("destination-is-mount-point"));
        assert!(TRANSACTIONAL_FOLDER_UPLOAD_SCRIPT.contains("destination-contains-mount-point"));
        assert!(TRANSACTIONAL_FOLDER_UPLOAD_SCRIPT.contains("refusing to remove mounted directory"));
        assert!(TRANSACTIONAL_FOLDER_UPLOAD_SCRIPT.contains("os.path.ismount"));
        assert!(TRANSACTIONAL_FOLDER_UPLOAD_SCRIPT.contains("/proc/self/mountinfo"));
    }

    #[cfg(all(not(russh_backend), unix))]
    #[test]
    fn folder_replace_failure_preserves_old_and_special_targets_are_rejected() {
        use std::os::unix::fs::symlink;

        let sandbox = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("ishell-folder-failure-{}", Uuid::new_v4()));
        let local = sandbox.join("source-folder");
        let remote = sandbox.join("remote");
        fs::create_dir_all(&local).unwrap();
        fs::create_dir_all(&remote).unwrap();
        fs::write(local.join("new.txt"), b"new-data").unwrap();
        let mut prepared = prepare_folder_archive(&local, "failure-test", &|| false).unwrap();

        let destination = remote.join("source-folder");
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("old.txt"), b"old-data").unwrap();
        let wrong_size = prepared.size + 1;
        let (failed, failed_archive, failed_staging) =
            run_folder_upload_script(&mut prepared, &remote, "source-folder", true, wrong_size);
        assert!(!failed.status.success());
        assert_eq!(fs::read(destination.join("old.txt")).unwrap(), b"old-data");
        assert!(!destination.join("new.txt").exists());
        assert_folder_upload_artifacts_removed(&failed_archive, &failed_staging);

        let file_target = remote.join("file-target");
        fs::write(&file_target, b"file-data").unwrap();
        let expected_size = prepared.size;
        let (file_result, file_archive, file_staging) =
            run_folder_upload_script(&mut prepared, &remote, "file-target", true, expected_size);
        assert!(!file_result.status.success());
        assert!(String::from_utf8_lossy(&file_result.stderr).contains(UPLOAD_FOLDER_UNSAFE_MARKER));
        assert_eq!(fs::read(&file_target).unwrap(), b"file-data");
        assert_folder_upload_artifacts_removed(&file_archive, &file_staging);

        let link_target = remote.join("link-target-data");
        let link_path = remote.join("link-target");
        fs::create_dir(&link_target).unwrap();
        fs::write(link_target.join("old.txt"), b"linked-old").unwrap();
        symlink(&link_target, &link_path).unwrap();
        let (link_result, link_archive, link_staging) =
            run_folder_upload_script(&mut prepared, &remote, "link-target", true, expected_size);
        assert!(!link_result.status.success());
        assert!(String::from_utf8_lossy(&link_result.stderr).contains(UPLOAD_FOLDER_UNSAFE_MARKER));
        assert!(fs::symlink_metadata(&link_path)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::read(link_target.join("old.txt")).unwrap(),
            b"linked-old"
        );
        assert_folder_upload_artifacts_removed(&link_archive, &link_staging);
        fs::remove_dir_all(sandbox).unwrap();
    }

    #[cfg(not(russh_backend))]
    #[test]
    fn transactional_upload_preserves_final_on_mismatch_and_replaces_on_success() {
        let root = std::env::temp_dir().join(format!("ishell-upload-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let final_path = root.join("final 'quoted name.bin");
        fs::write(&final_path, b"original").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&final_path, fs::Permissions::from_mode(0o751)).unwrap();
        }

        let failed_temp = root.join("failed 'quoted.tmp");
        let failed_command = transactional_upload_command(
            final_path.to_str().unwrap(),
            failed_temp.to_str().unwrap(),
            10,
        );
        let mut failed_child = std::process::Command::new("/bin/sh")
            .args(["-c", &failed_command])
            .stdin(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        failed_child
            .stdin
            .take()
            .unwrap()
            .write_all(b"short")
            .unwrap();
        let failed_output = failed_child.wait_with_output().unwrap();
        assert!(!failed_output.status.success());
        assert!(String::from_utf8_lossy(&failed_output.stderr)
            .contains(openssh::UPLOAD_SIZE_MISMATCH_MARKER));
        assert_eq!(fs::read(&final_path).unwrap(), b"original");
        assert!(!failed_temp.exists());

        let replacement = b"replacement";
        let success_temp = root.join("success 'quoted.tmp");
        let success_command = transactional_upload_command(
            final_path.to_str().unwrap(),
            success_temp.to_str().unwrap(),
            replacement.len() as u64,
        );
        let mut success_child = std::process::Command::new("/bin/sh")
            .args(["-c", &success_command])
            .stdin(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        success_child
            .stdin
            .take()
            .unwrap()
            .write_all(replacement)
            .unwrap();
        let success_output = success_child.wait_with_output().unwrap();
        assert!(
            success_output.status.success(),
            "{}",
            String::from_utf8_lossy(&success_output.stderr)
        );
        assert_eq!(fs::read(&final_path).unwrap(), replacement);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&final_path).unwrap().permissions().mode() & 0o777,
                0o751
            );
        }
        assert!(!success_temp.exists());

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;

            let symlink_target = root.join("symlink-target.bin");
            let symlink_path = root.join("symlink-upload.bin");
            let symlink_temp = root.join("symlink-upload.tmp");
            fs::write(&symlink_target, b"linked-original").unwrap();
            symlink(&symlink_target, &symlink_path).unwrap();
            let symlink_command = transactional_upload_command(
                symlink_path.to_str().unwrap(),
                symlink_temp.to_str().unwrap(),
                replacement.len() as u64,
            );
            let mut symlink_child = std::process::Command::new("/bin/sh")
                .args(["-c", &symlink_command])
                .stdin(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            symlink_child
                .stdin
                .take()
                .unwrap()
                .write_all(replacement)
                .unwrap();
            let symlink_output = symlink_child.wait_with_output().unwrap();
            assert!(!symlink_output.status.success());
            assert!(String::from_utf8_lossy(&symlink_output.stderr)
                .contains(UPLOAD_TARGET_UNSUPPORTED_MARKER));
            assert!(fs::symlink_metadata(&symlink_path)
                .unwrap()
                .file_type()
                .is_symlink());
            assert_eq!(fs::read(&symlink_target).unwrap(), b"linked-original");
            assert!(!symlink_temp.exists());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(not(russh_backend))]
    #[test]
    fn upload_copy_distinguishes_zero_and_partial_writes() {
        let mut reader = Cursor::new(b"payload".to_vec());
        let mut writer = BrokenPipeWriter {
            bytes_before_failure: 0,
            written: 0,
        };
        let error =
            copy_upload_stream(&mut reader, &mut writer, &|| false, &mut |_| {}).unwrap_err();
        assert!(matches!(error, UploadCopyError::Write { .. }));

        let mut reader = Cursor::new(b"payload".to_vec());
        let mut writer = BrokenPipeWriter {
            bytes_before_failure: 3,
            written: 0,
        };
        let error =
            copy_upload_stream(&mut reader, &mut writer, &|| false, &mut |_| {}).unwrap_err();
        assert!(matches!(error, UploadCopyError::Write { .. }));
    }

    #[cfg(not(russh_backend))]
    #[test]
    fn upload_failure_prefers_ssh_stderr_over_broken_pipe() {
        let output = std::process::Command::new("/bin/sh")
            .args(["-c", "printf 'authentication failed' >&2; exit 255"])
            .output()
            .unwrap();
        assert_eq!(
            format_upload_attempt_failure(
                &output.status,
                &output.stderr,
                "Broken pipe (os error 32)"
            ),
            "上传失败：authentication failed"
        );

        let marker = std::process::Command::new("/bin/sh")
            .args([
                "-c",
                "printf '__ISHELL_UPLOAD_SIZE_MISMATCH__ expected=10 actual=5' >&2; exit 75",
            ])
            .output()
            .unwrap();
        let message = format_upload_attempt_failure(
            &marker.status,
            &marker.stderr,
            "OpenSSH 上传进程提前退出",
        );
        assert!(message.contains("上传字节数校验失败"));
        assert!(!message.contains("__ISHELL_"));

        let conflict = humanize_upload_error_message(UPLOAD_FOLDER_CONFLICT_MARKER);
        assert!(conflict.contains(UPLOAD_FOLDER_CONFLICT_MARKER));
        assert!(conflict.contains("全量覆盖"));
    }

    #[cfg(not(russh_backend))]
    #[test]
    fn retry_classifier_accepts_connections_and_size_mismatch_not_remote_errors() {
        let connection = std::process::Command::new("/bin/sh")
            .args(["-c", "exit 255"])
            .output()
            .unwrap();
        assert!(openssh_upload_is_retryable(
            &connection.status,
            &connection.stderr,
            None
        ));

        let authentication = std::process::Command::new("/bin/sh")
            .args(["-c", "printf 'Permission denied (publickey)' >&2; exit 255"])
            .output()
            .unwrap();
        assert!(!openssh_upload_is_retryable(
            &authentication.status,
            &authentication.stderr,
            None
        ));

        let size_mismatch = std::process::Command::new("/bin/sh")
            .args([
                "-c",
                "printf '__ISHELL_UPLOAD_SIZE_MISMATCH__' >&2; exit 75",
            ])
            .output()
            .unwrap();
        assert!(openssh_upload_is_retryable(
            &size_mismatch.status,
            &size_mismatch.stderr,
            None
        ));

        let permission = std::process::Command::new("/bin/sh")
            .args(["-c", "printf 'Permission denied' >&2; exit 1"])
            .output()
            .unwrap();
        let broken_pipe = UploadCopyError::Write {
            error: io::Error::new(io::ErrorKind::BrokenPipe, "closed"),
        };
        assert!(!openssh_upload_is_retryable(
            &permission.status,
            &permission.stderr,
            Some(&broken_pipe)
        ));
    }
}
