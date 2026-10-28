//! Packing a local folder into a tar archive for upload, while detecting
//! changes to the source made during packing.

use super::*;

#[derive(Debug)]
pub(super) struct PreparedFolderArchive {
    pub(super) path: PathBuf,
    file: Option<fs::File>,
    pub(super) size: u64,
    pub(super) root_mode: u32,
}

impl PreparedFolderArchive {
    pub(super) fn file_mut(&mut self) -> &mut fs::File {
        self.file.as_mut().expect("prepared archive file missing")
    }
}

impl Drop for PreparedFolderArchive {
    fn drop(&mut self) {
        drop(self.file.take());
        let _ = fs::remove_file(&self.path);
    }
}

pub(super) struct CancelReader<'a> {
    pub(super) inner: fs::File,
    pub(super) is_canceled: &'a dyn Fn() -> bool,
}

impl Read for CancelReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if (self.is_canceled)() {
            return Err(io::Error::other("上传已停止"));
        }
        self.inner.read(buffer)
    }
}

pub(super) fn validate_archive_relative_path(path: &Path) -> Result<(), String> {
    if path.as_os_str().is_empty() {
        return Err("文件夹归档包含空路径".to_string());
    }
    for component in path.components() {
        match component {
            Component::Normal(value) if value.to_str().is_some() => {}
            Component::Normal(_) => return Err("文件夹包含非 UTF-8 文件名".to_string()),
            _ => return Err("文件夹包含不安全路径".to_string()),
        }
    }
    Ok(())
}

pub(super) fn same_local_file_identity(first: &fs::Metadata, second: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        first.dev() == second.dev()
            && first.ino() == second.ino()
            && first.file_type() == second.file_type()
    }
    #[cfg(not(unix))]
    {
        first.file_type() == second.file_type() && first.len() == second.len()
    }
}

pub(super) fn same_local_file_snapshot(first: &fs::Metadata, second: &fs::Metadata) -> bool {
    if !same_local_file_identity(first, second)
        || first.len() != second.len()
        || first.modified().ok() != second.modified().ok()
    {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        first.mode() == second.mode()
            && first.nlink() == second.nlink()
            && first.mtime() == second.mtime()
            && first.mtime_nsec() == second.mtime_nsec()
            && first.ctime() == second.ctime()
            && first.ctime_nsec() == second.ctime_nsec()
    }
    #[cfg(not(unix))]
    {
        first.permissions().readonly() == second.permissions().readonly()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum LocalFolderEntryKind {
    File,
    Directory,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct LocalFolderEntrySnapshot {
    relative_path: PathBuf,
    kind: LocalFolderEntryKind,
    len: u64,
    modified: Option<std::time::SystemTime>,
    readonly: bool,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(unix)]
    mode: u32,
    #[cfg(unix)]
    links: u64,
    #[cfg(unix)]
    modified_seconds: i64,
    #[cfg(unix)]
    modified_nanoseconds: i64,
    #[cfg(unix)]
    changed_seconds: i64,
    #[cfg(unix)]
    changed_nanoseconds: i64,
}

pub(super) fn local_folder_entry_snapshot(
    relative_path: PathBuf,
    metadata: &fs::Metadata,
) -> LocalFolderEntrySnapshot {
    let kind = if metadata.is_dir() {
        LocalFolderEntryKind::Directory
    } else {
        LocalFolderEntryKind::File
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        LocalFolderEntrySnapshot {
            relative_path,
            kind,
            len: metadata.len(),
            modified: metadata.modified().ok(),
            readonly: metadata.permissions().readonly(),
            device: metadata.dev(),
            inode: metadata.ino(),
            mode: metadata.mode(),
            links: metadata.nlink(),
            modified_seconds: metadata.mtime(),
            modified_nanoseconds: metadata.mtime_nsec(),
            changed_seconds: metadata.ctime(),
            changed_nanoseconds: metadata.ctime_nsec(),
        }
    }
    #[cfg(not(unix))]
    {
        LocalFolderEntrySnapshot {
            relative_path,
            kind,
            len: metadata.len(),
            modified: metadata.modified().ok(),
            readonly: metadata.permissions().readonly(),
        }
    }
}

pub(super) fn same_local_archive_identity(first: &fs::Metadata, second: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        first.dev() == second.dev() && first.ino() == second.ino()
    }
    #[cfg(not(unix))]
    {
        let _ = (first, second);
        false
    }
}

pub(super) fn open_local_regular_file_no_follow(path: &Path) -> Result<fs::File, String> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    options
        .open(path)
        .map_err(|err| format!("无法安全打开本地文件：{}：{err}", path.display()))
}

pub(super) fn local_directory_mode(metadata: &fs::Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o777
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        0o755
    }
}

pub(super) fn collect_local_folder_snapshot(
    root: &Path,
    directory: &Path,
    archive_path: Option<&Path>,
    archive_identity: Option<&fs::Metadata>,
    is_canceled: &dyn Fn() -> bool,
) -> Result<Vec<LocalFolderEntrySnapshot>, String> {
    let mut snapshot = Vec::new();
    collect_local_folder_snapshot_entries(
        root,
        directory,
        archive_path,
        archive_identity,
        is_canceled,
        &mut snapshot,
    )?;
    snapshot.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(snapshot)
}

pub(super) fn collect_local_folder_snapshot_entries(
    root: &Path,
    directory: &Path,
    archive_path: Option<&Path>,
    archive_identity: Option<&fs::Metadata>,
    is_canceled: &dyn Fn() -> bool,
    snapshot: &mut Vec<LocalFolderEntrySnapshot>,
) -> Result<(), String> {
    if is_canceled() {
        return Err("上传已停止".to_string());
    }
    let before =
        fs::symlink_metadata(directory).map_err(|err| format!("无法读取本地文件夹：{err}"))?;
    if before.file_type().is_symlink() || !before.is_dir() {
        return Err("本地文件夹包含符号链接或目录已发生变化".to_string());
    }
    let mut entries = fs::read_dir(directory)
        .map_err(|err| format!("无法读取本地文件夹：{err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("无法读取本地文件夹条目：{err}"))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if is_canceled() {
            return Err("上传已停止".to_string());
        }
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "本地文件夹条目越界".to_string())?;
        validate_archive_relative_path(relative)?;
        let metadata =
            fs::symlink_metadata(&path).map_err(|err| format!("无法读取本地文件夹条目：{err}"))?;
        if archive_path.is_some_and(|archive_path| path == archive_path)
            || archive_identity.is_some_and(|archive_identity| {
                same_local_archive_identity(&metadata, archive_identity)
            })
        {
            continue;
        }
        if metadata.file_type().is_symlink() {
            return Err(format!("文件夹包含符号链接：{}", path.display()));
        }
        if metadata.is_dir() {
            collect_local_folder_snapshot_entries(
                root,
                &path,
                archive_path,
                archive_identity,
                is_canceled,
                snapshot,
            )?;
        } else if !metadata.is_file() {
            return Err(format!("文件夹包含特殊文件：{}", path.display()));
        } else {
            snapshot.push(local_folder_entry_snapshot(
                relative.to_path_buf(),
                &metadata,
            ));
        }
    }
    let after =
        fs::symlink_metadata(directory).map_err(|err| format!("无法再次检查本地文件夹：{err}"))?;
    if !same_local_file_snapshot(&before, &after) {
        return Err(format!(
            "本地文件夹遍历期间发生变化：{}",
            directory.display()
        ));
    }
    let relative = directory
        .strip_prefix(root)
        .map_err(|_| "本地文件夹条目越界".to_string())?;
    snapshot.push(local_folder_entry_snapshot(relative.to_path_buf(), &after));
    Ok(())
}

pub(super) fn append_local_folder_entries(
    builder: &mut tar::Builder<fs::File>,
    root: &Path,
    directory: &Path,
    archive_path: &Path,
    archive_identity: &fs::Metadata,
    is_canceled: &dyn Fn() -> bool,
) -> Result<(), String> {
    if is_canceled() {
        return Err("上传已停止".to_string());
    }
    let directory_metadata =
        fs::symlink_metadata(directory).map_err(|err| format!("无法读取本地文件夹：{err}"))?;
    if directory_metadata.file_type().is_symlink() || !directory_metadata.is_dir() {
        return Err("本地文件夹包含符号链接或目录已发生变化".to_string());
    }

    let mut entries = fs::read_dir(directory)
        .map_err(|err| format!("无法读取本地文件夹：{err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("无法读取本地文件夹条目：{err}"))?;
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        if is_canceled() {
            return Err("上传已停止".to_string());
        }
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "本地文件夹条目越界".to_string())?;
        validate_archive_relative_path(relative)?;
        let metadata =
            fs::symlink_metadata(&path).map_err(|err| format!("无法读取本地文件夹条目：{err}"))?;
        if path == archive_path || same_local_archive_identity(&metadata, archive_identity) {
            continue;
        }
        let file_type = metadata.file_type();
        if file_type.is_symlink() {
            return Err(format!("文件夹包含符号链接：{}", path.display()));
        }
        if metadata.is_dir() {
            let mut header = tar::Header::new_gnu();
            header.set_metadata(&metadata);
            header.set_entry_type(tar::EntryType::Directory);
            header.set_size(0);
            header.set_cksum();
            builder
                .append_data(&mut header, relative, io::empty())
                .map_err(|err| format!("无法写入文件夹归档：{err}"))?;
            append_local_folder_entries(
                builder,
                root,
                &path,
                archive_path,
                archive_identity,
                is_canceled,
            )?;
        } else if metadata.is_file() {
            let file = open_local_regular_file_no_follow(&path)?;
            let opened_metadata = file
                .metadata()
                .map_err(|err| format!("无法读取本地文件信息：{err}"))?;
            if !opened_metadata.is_file() {
                return Err(format!("本地文件已发生变化：{}", path.display()));
            }
            if !same_local_file_identity(&metadata, &opened_metadata) {
                return Err(format!("本地文件打开期间发生变化：{}", path.display()));
            }
            let mut header = tar::Header::new_gnu();
            header.set_metadata(&opened_metadata);
            header.set_entry_type(tar::EntryType::Regular);
            header.set_size(opened_metadata.len());
            header.set_cksum();
            let mut reader = CancelReader {
                inner: file,
                is_canceled,
            };
            builder
                .append_data(&mut header, relative, &mut reader)
                .map_err(|err| {
                    if is_canceled() {
                        "上传已停止".to_string()
                    } else {
                        format!("无法写入文件夹归档：{err}")
                    }
                })?;
            let after = fs::symlink_metadata(&path)
                .map_err(|err| format!("无法再次检查本地文件：{err}"))?;
            if !same_local_file_snapshot(&opened_metadata, &after) {
                return Err(format!("本地文件归档期间发生变化：{}", path.display()));
            }
        } else {
            return Err(format!("文件夹包含特殊文件：{}", path.display()));
        }
    }
    let after =
        fs::symlink_metadata(directory).map_err(|err| format!("无法再次检查本地文件夹：{err}"))?;
    if !same_local_file_snapshot(&directory_metadata, &after) {
        return Err(format!(
            "本地文件夹归档期间发生变化：{}",
            directory.display()
        ));
    }
    Ok(())
}

pub(super) fn prepare_folder_archive(
    local_path: &Path,
    transfer_id: &str,
    is_canceled: &dyn Fn() -> bool,
) -> Result<PreparedFolderArchive, String> {
    let metadata =
        fs::symlink_metadata(local_path).map_err(|err| format!("无法读取本地文件夹：{err}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("请选择不含符号链接的本地文件夹".to_string());
    }
    collect_local_folder_snapshot(local_path, local_path, None, None, is_canceled)?;
    let root_mode = local_directory_mode(&metadata);
    let safe_transfer_id: String = transfer_id
        .chars()
        .filter(|value| value.is_ascii_alphanumeric() || *value == '-' || *value == '_')
        .take(36)
        .collect();
    let path = std::env::temp_dir().join(format!(
        "ishell-folder-{}-{}.tar.tmp",
        if safe_transfer_id.is_empty() {
            "upload"
        } else {
            &safe_transfer_id
        },
        uuid::Uuid::new_v4()
    ));
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let output = options
        .open(&path)
        .map_err(|err| format!("无法创建本地文件夹归档：{err}"))?;
    let archive_identity = output
        .metadata()
        .map_err(|err| format!("无法读取本地文件夹归档信息：{err}"))?;
    let result = (|| -> Result<fs::File, String> {
        let initial_snapshot = collect_local_folder_snapshot(
            local_path,
            local_path,
            Some(&path),
            Some(&archive_identity),
            is_canceled,
        )?;
        let mut builder = tar::Builder::new(output);
        builder.follow_symlinks(false);
        append_local_folder_entries(
            &mut builder,
            local_path,
            local_path,
            &path,
            &archive_identity,
            is_canceled,
        )?;
        builder
            .finish()
            .map_err(|err| format!("无法完成本地文件夹归档：{err}"))?;
        let mut output = builder
            .into_inner()
            .map_err(|err| format!("无法完成本地文件夹归档：{err}"))?;
        output
            .flush()
            .map_err(|err| format!("无法刷新本地文件夹归档：{err}"))?;
        if is_canceled() {
            return Err("上传已停止".to_string());
        }
        let final_snapshot = collect_local_folder_snapshot(
            local_path,
            local_path,
            Some(&path),
            Some(&archive_identity),
            is_canceled,
        )?;
        if final_snapshot != initial_snapshot {
            return Err("本地文件夹在打包期间发生变化，请重试上传".to_string());
        }
        output
            .seek(SeekFrom::Start(0))
            .map_err(|err| format!("无法读取本地文件夹归档：{err}"))?;
        Ok(output)
    })();
    let file = match result {
        Ok(file) => file,
        Err(error) => {
            let _ = fs::remove_file(&path);
            return Err(error);
        }
    };
    let size = file
        .metadata()
        .map_err(|err| format!("无法读取本地文件夹归档信息：{err}"))?
        .len();
    Ok(PreparedFolderArchive {
        path,
        file: Some(file),
        size,
        root_mode,
    })
}
