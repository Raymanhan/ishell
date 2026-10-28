//! Remote file operations: directory listing, create/rename/delete, and
//! reading or writing small text files for the built-in editor.

use super::*;

pub(super) const MAX_TEXT_EDIT_BYTES: u64 = 1024 * 1024;

pub(super) const LIST_SCRIPT: &str = r#"import grp
import json
import os
import pwd
import stat
import sys

path = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else "/"
items = []
with os.scandir(path) as entries:
    for entry in entries:
        try:
            st = entry.stat(follow_symlinks=False)
        except OSError:
            continue
        is_symlink = stat.S_ISLNK(st.st_mode)
        target_is_dir = False
        link_target = None
        if is_symlink:
            try:
                target = entry.stat(follow_symlinks=True)
                target_is_dir = stat.S_ISDIR(target.st_mode)
            except OSError:
                target_is_dir = False
            try:
                link_target = os.readlink(entry.path)
            except OSError:
                link_target = None
        try:
            owner = pwd.getpwuid(st.st_uid).pw_name
        except KeyError:
            owner = None
        try:
            group = grp.getgrgid(st.st_gid).gr_name
        except KeyError:
            group = None
        full_path = ("/" + entry.name) if path == "/" else path.rstrip("/") + "/" + entry.name
        items.append({
            "name": entry.name,
            "path": full_path,
            "isDir": stat.S_ISDIR(st.st_mode) or target_is_dir,
            "isSymlink": is_symlink,
            "linkTarget": link_target,
            "targetIsDir": target_is_dir if is_symlink else None,
            "size": st.st_size,
            "uid": st.st_uid,
            "gid": st.st_gid,
            "owner": owner,
            "group": group,
            "permissions": st.st_mode,
            "modifiedAt": int(st.st_mtime),
        })
print(json.dumps(items, ensure_ascii=False, separators=(",", ":")))
"#;

pub fn list_sftp(
    _pool: &SshPool,
    app: &AppHandle,
    id: &str,
    path: &str,
) -> Result<Vec<SftpEntry>, String> {
    let current_path = if path.trim().is_empty() {
        "/"
    } else {
        path.trim()
    };
    let raw = run_remote_python(app, id, LIST_SCRIPT, &[current_path])?;
    let mut mapped: Vec<SftpEntry> =
        serde_json::from_str(&raw).map_err(|err| format!("无法解析远程目录列表：{err}"))?;
    mapped.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(mapped)
}

pub fn make_directory(
    _pool: &SshPool,
    app: &AppHandle,
    id: &str,
    path: &str,
) -> Result<(), String> {
    run_remote_shell(
        app,
        id,
        &format!("mkdir -p -- {}", openssh::shell_quote(path)),
    )
    .map(|_| ())
    .map_err(|err| format!("无法创建目录：{err}"))
}

pub fn remove_entry(
    _pool: &SshPool,
    app: &AppHandle,
    id: &str,
    path: &str,
    is_dir: bool,
) -> Result<(), String> {
    let command = if is_dir {
        format!("rm -rf -- {}", openssh::shell_quote(path))
    } else {
        format!("rm -f -- {}", openssh::shell_quote(path))
    };
    run_remote_shell(app, id, &command)
        .map(|_| ())
        .map_err(|err| format!("无法删除：{err}"))
}

pub fn rename_entry(
    _pool: &SshPool,
    app: &AppHandle,
    id: &str,
    from: &str,
    to: &str,
) -> Result<(), String> {
    run_remote_shell(
        app,
        id,
        &format!(
            "mv -f -- {} {}",
            openssh::shell_quote(from),
            openssh::shell_quote(to)
        ),
    )
    .map(|_| ())
    .map_err(|err| format!("无法重命名：{err}"))
}

pub fn read_text_file(
    _pool: &SshPool,
    app: &AppHandle,
    id: &str,
    path: &str,
) -> Result<String, String> {
    let size = remote_file_size(app, id, path)?;
    if size > MAX_TEXT_EDIT_BYTES {
        return Err(format!(
            "文件超过可编辑大小限制（最大 {}）",
            format_bytes(MAX_TEXT_EDIT_BYTES)
        ));
    }

    let raw = read_remote_file_bytes(app, id, path)?;
    if raw.len() as u64 > MAX_TEXT_EDIT_BYTES {
        return Err(format!(
            "文件超过可编辑大小限制（最大 {}）",
            format_bytes(MAX_TEXT_EDIT_BYTES)
        ));
    }
    text_from_bytes(raw)
}

pub fn write_text_file(
    _pool: &SshPool,
    app: &AppHandle,
    id: &str,
    path: &str,
    content: &str,
) -> Result<(), String> {
    if content.len() as u64 > MAX_TEXT_EDIT_BYTES {
        return Err(format!(
            "内容超过可编辑大小限制（最大 {}）",
            format_bytes(MAX_TEXT_EDIT_BYTES)
        ));
    }
    if content.as_bytes().contains(&0) {
        return Err("仅支持保存文本内容".to_string());
    }
    let size = remote_file_size(app, id, path).map_err(|err| format!("无法确认远程文件：{err}"))?;
    if size > MAX_TEXT_EDIT_BYTES {
        return Err(format!(
            "文件超过可编辑大小限制（最大 {}）",
            format_bytes(MAX_TEXT_EDIT_BYTES)
        ));
    }
    text_from_bytes(read_remote_file_bytes(app, id, path)?)?;
    let remote_command = format!("cat > {}", openssh::shell_quote(path));
    run_remote_command(app, id, &remote_command, Some(content.as_bytes()))
        .map(|_| ())
        .map_err(|err| format!("保存文件失败：{err}"))
}

pub(super) fn text_from_bytes(raw: Vec<u8>) -> Result<String, String> {
    if raw.contains(&0) {
        return Err("仅支持编辑文本文件，当前文件像是二进制文件".to_string());
    }
    String::from_utf8(raw).map_err(|_| "仅支持编辑 UTF-8 文本文件".to_string())
}
