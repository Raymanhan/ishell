//! Remote shell scripts and protocol markers used by uploads.

pub(super) const UPLOAD_TARGET_DIRECTORY_MARKER: &str = "__ISHELL_UPLOAD_TARGET_IS_DIRECTORY__";

pub(super) const UPLOAD_TARGET_UNSUPPORTED_MARKER: &str = "__ISHELL_UPLOAD_TARGET_UNSUPPORTED__";

pub(super) const UPLOAD_TARGET_CHANGED_MARKER: &str = "__ISHELL_UPLOAD_TARGET_CHANGED__";

pub(super) const UPLOAD_WRITE_FAILED_MARKER: &str = "__ISHELL_UPLOAD_WRITE_FAILED__";

pub(super) const UPLOAD_COMMIT_FAILED_MARKER: &str = "__ISHELL_UPLOAD_COMMIT_FAILED__";

pub(super) const UPLOAD_FOLDER_CONFLICT_MARKER: &str = "__ISHELL_UPLOAD_FOLDER_CONFLICT__";

pub(super) const UPLOAD_FOLDER_UNSAFE_MARKER: &str = "__ISHELL_UPLOAD_FOLDER_UNSAFE__";

pub(super) const UPLOAD_FOLDER_EXTRACT_FAILED_MARKER: &str =
    "__ISHELL_UPLOAD_FOLDER_EXTRACT_FAILED__";

pub(super) const UPLOAD_FOLDER_COMMIT_FAILED_MARKER: &str =
    "__ISHELL_UPLOAD_FOLDER_COMMIT_FAILED__";

pub(super) const UPLOAD_FOLDER_CHANGED_MARKER: &str = "__ISHELL_UPLOAD_FOLDER_CHANGED__";

pub(super) const UPLOAD_HEARTBEAT_MARKER: &str = "__ISHELL_UPLOAD_HEARTBEAT__";

pub(super) const FOLDER_TARGET_PROBE_SCRIPT: &str = r#"
import hashlib
import os
import re
import stat
import sys
import time

HEARTBEAT = "__ISHELL_UPLOAD_HEARTBEAT__"
last_heartbeat = 0.0


class ProbeFailure(Exception):
    pass


def heartbeat():
    global last_heartbeat
    current = time.monotonic()
    if current - last_heartbeat >= 5.0:
        print(HEARTBEAT, file=sys.stderr, flush=True)
        last_heartbeat = current


def system_mount_points():
    points = set()
    try:
        with open("/proc/self/mountinfo", "r", encoding="utf-8", errors="surrogateescape") as source:
            for line in source:
                fields = line.split(" - ", 1)[0].split()
                if len(fields) < 5:
                    continue
                decoded = re.sub(
                    r"\\([0-7]{3})",
                    lambda match: chr(int(match.group(1), 8)),
                    fields[4],
                )
                points.add(os.path.abspath(decoded))
    except OSError:
        pass
    return points


def is_mount_point(path, mount_points):
    return os.path.abspath(path) in mount_points or os.path.ismount(path)


def directory_snapshots(path):
    revision = hashlib.sha256()
    rename_stable = hashlib.sha256()
    mount_points = system_mount_points()
    if is_mount_point(path, mount_points):
        raise ProbeFailure("destination-is-mount-point")
    root_device = os.lstat(path).st_dev

    def visit(current, relative):
        heartbeat()
        value = os.lstat(current)
        if stat.S_ISLNK(value.st_mode):
            raise ProbeFailure("destination-symbolic-link")
        if not stat.S_ISDIR(value.st_mode):
            raise ProbeFailure("destination-not-directory")
        revision_fields = (
            relative, value.st_dev, value.st_ino, value.st_mode, value.st_size,
            value.st_mtime_ns, value.st_ctime_ns, value.st_nlink,
        )
        stable_fields = (
            relative, value.st_dev, value.st_ino, value.st_mode, value.st_size,
            value.st_mtime_ns, None if not relative else value.st_ctime_ns, value.st_nlink,
        )
        revision.update(repr(revision_fields).encode("utf-8", "surrogateescape"))
        rename_stable.update(repr(stable_fields).encode("utf-8", "surrogateescape"))
        with os.scandir(current) as entries:
            ordered = sorted(entries, key=lambda entry: entry.name)
        for entry in ordered:
            entry_path = os.path.join(current, entry.name)
            entry_relative = entry.name if not relative else relative + "/" + entry.name
            entry_value = os.lstat(entry_path)
            fields = (
                entry_relative, entry_value.st_dev, entry_value.st_ino,
                entry_value.st_mode, entry_value.st_size, entry_value.st_mtime_ns,
                entry_value.st_ctime_ns, entry_value.st_nlink,
            )
            encoded = repr(fields).encode("utf-8", "surrogateescape")
            revision.update(encoded)
            rename_stable.update(encoded)
            if stat.S_ISLNK(entry_value.st_mode):
                link_target = os.fsencode(os.readlink(entry_path))
                revision.update(link_target)
                rename_stable.update(link_target)
            elif stat.S_ISDIR(entry_value.st_mode):
                if entry_value.st_dev != root_device or is_mount_point(entry_path, mount_points):
                    raise ProbeFailure("destination-contains-mount-point")
                visit(entry_path, entry_relative)

    visit(path, "")
    return revision.hexdigest(), rename_stable.hexdigest()

remote_dir, folder_name, include_revision = sys.argv[1:4]
if include_revision not in ("0", "1"):
    print("changed invalid-probe-mode")
    sys.exit(0)
target = os.path.join(remote_dir, folder_name)
try:
    value = os.lstat(target)
except FileNotFoundError:
    print("missing")
else:
    if stat.S_ISLNK(value.st_mode):
        print("unsupported symbolic-link")
    elif stat.S_ISDIR(value.st_mode):
        if include_revision == "0":
            print("directory")
        else:
            try:
                revision, rename_stable = directory_snapshots(target)
                print("directory " + revision + " " + rename_stable)
            except ProbeFailure as error:
                print("unsupported " + str(error))
            except OSError as error:
                print("changed " + str(error))
    else:
        print("unsupported non-directory")
"#;

pub(super) const FOLDER_UPLOAD_ARTIFACT_CLEANUP_SCRIPT: &str = r#"
import os
import re
import stat
import sys


def lstat_optional(path):
    try:
        return os.lstat(path)
    except FileNotFoundError:
        return None


def system_mount_points():
    points = set()
    try:
        with open("/proc/self/mountinfo", "r", encoding="utf-8", errors="surrogateescape") as source:
            for line in source:
                fields = line.split(" - ", 1)[0].split()
                if len(fields) < 5:
                    continue
                decoded = re.sub(
                    r"\\([0-7]{3})",
                    lambda match: chr(int(match.group(1), 8)),
                    fields[4],
                )
                points.add(os.path.abspath(decoded))
    except OSError:
        pass
    return points


def is_mount_point(path, mount_points):
    return os.path.abspath(path) in mount_points or os.path.ismount(path)


def remove_tree(path, root_device=None, mount_points=None):
    value = lstat_optional(path)
    if value is None:
        return
    if stat.S_ISLNK(value.st_mode) or not stat.S_ISDIR(value.st_mode):
        os.unlink(path)
        return
    if mount_points is None:
        mount_points = system_mount_points()
    if is_mount_point(path, mount_points):
        return
    if root_device is None:
        root_device = value.st_dev
    elif value.st_dev != root_device:
        return
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass
    with os.scandir(path) as entries:
        children = list(entries)
    for entry in children:
        child = os.path.join(path, entry.name)
        child_value = os.lstat(child)
        if stat.S_ISDIR(child_value.st_mode) and not stat.S_ISLNK(child_value.st_mode):
            if child_value.st_dev != root_device or is_mount_point(child, mount_points):
                continue
            remove_tree(child, root_device, mount_points)
        else:
            os.unlink(child)
    try:
        os.rmdir(path)
    except OSError:
        pass


archive_path, staging_path = sys.argv[1:3]
archive_value = lstat_optional(archive_path)
if archive_value is not None and not stat.S_ISDIR(archive_value.st_mode):
    try:
        os.unlink(archive_path)
    except OSError:
        pass
try:
    remove_tree(staging_path)
except OSError:
    pass
"#;

pub(super) const TRANSACTIONAL_UPLOAD_SCRIPT: &str = r#"
import os
import shutil
import signal
import stat
import sys

SIZE_MISMATCH = "__ISHELL_UPLOAD_SIZE_MISMATCH__"
TARGET_DIRECTORY = "__ISHELL_UPLOAD_TARGET_IS_DIRECTORY__"
TARGET_UNSUPPORTED = "__ISHELL_UPLOAD_TARGET_UNSUPPORTED__"
TARGET_CHANGED = "__ISHELL_UPLOAD_TARGET_CHANGED__"
WRITE_FAILED = "__ISHELL_UPLOAD_WRITE_FAILED__"
COMMIT_FAILED = "__ISHELL_UPLOAD_COMMIT_FAILED__"


class UploadFailure(Exception):
    def __init__(self, code):
        self.code = code


def fail(marker, detail="", code=1):
    message = marker if not detail else marker + " " + detail
    print(message, file=sys.stderr, flush=True)
    raise UploadFailure(code)


def target_stat(path):
    try:
        return os.lstat(path)
    except FileNotFoundError:
        return None


def target_signature(value):
    if value is None:
        return None
    return (
        value.st_dev,
        value.st_ino,
        value.st_size,
        value.st_mtime_ns,
        value.st_ctime_ns,
    )


def validate_target(value):
    if value is None:
        return
    if stat.S_ISDIR(value.st_mode):
        fail(TARGET_DIRECTORY, code=73)
    if stat.S_ISLNK(value.st_mode):
        fail(TARGET_UNSUPPORTED, "symbolic-link", 73)
    if not stat.S_ISREG(value.st_mode):
        fail(TARGET_UNSUPPORTED, "non-regular-file", 73)
    if value.st_nlink != 1:
        fail(TARGET_UNSUPPORTED, "hard-links=" + str(value.st_nlink), 73)


def interrupted(_signum, _frame):
    fail(WRITE_FAILED, "interrupted", 130)


for signal_name in ("SIGHUP", "SIGINT", "SIGTERM"):
    signal_value = getattr(signal, signal_name, None)
    if signal_value is not None:
        signal.signal(signal_value, interrupted)


final_path, temp_path, expected_text = sys.argv[1:4]
expected = int(expected_text)
committed = False
temp_created = False

try:
    initial = target_stat(final_path)
    validate_target(initial)
    initial_signature = target_signature(initial)

    try:
        descriptor = os.open(
            temp_path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o666,
        )
        temp_created = True
        with os.fdopen(descriptor, "wb", buffering=0) as output:
            transferred = 0
            while True:
                chunk = sys.stdin.buffer.read(64 * 1024)
                if not chunk:
                    break
                view = memoryview(chunk)
                while view:
                    written = output.write(view)
                    if written is None:
                        written = len(view)
                    if written <= 0:
                        raise OSError("remote temporary file accepted no data")
                    transferred += written
                    view = view[written:]
    except UploadFailure:
        raise
    except Exception as error:
        fail(WRITE_FAILED, str(error), 74)

    if transferred != expected:
        fail(
            SIZE_MISMATCH,
            "expected=" + str(expected) + " actual=" + str(transferred),
            75,
        )

    current = target_stat(final_path)
    validate_target(current)
    if target_signature(current) != initial_signature:
        fail(TARGET_CHANGED, code=76)

    if initial is not None:
        try:
            temp_stat = os.lstat(temp_path)
            if (temp_stat.st_uid, temp_stat.st_gid) != (initial.st_uid, initial.st_gid):
                os.chown(temp_path, initial.st_uid, initial.st_gid)
            shutil.copystat(final_path, temp_path, follow_symlinks=False)
            os.utime(temp_path, None, follow_symlinks=False)
        except Exception as error:
            fail(COMMIT_FAILED, "metadata: " + str(error), 77)

        if target_signature(target_stat(final_path)) != initial_signature:
            fail(TARGET_CHANGED, code=76)
    elif target_stat(final_path) is not None:
        fail(TARGET_CHANGED, code=76)

    try:
        os.replace(temp_path, final_path)
        committed = True
    except Exception as error:
        fail(COMMIT_FAILED, str(error), 77)
except UploadFailure as error:
    sys.exit(error.code)
except Exception as error:
    print(COMMIT_FAILED + " " + str(error), file=sys.stderr, flush=True)
    sys.exit(1)
finally:
    if temp_created and not committed:
        try:
            os.unlink(temp_path)
        except FileNotFoundError:
            pass
        except OSError:
            pass
"#;

pub(super) const TRANSACTIONAL_FOLDER_UPLOAD_SCRIPT: &str = r#"
import ctypes
import errno
import hashlib
import os
import re
import signal
import stat
import sys
import tarfile
import time
from pathlib import PurePosixPath

SIZE_MISMATCH = "__ISHELL_UPLOAD_SIZE_MISMATCH__"
WRITE_FAILED = "__ISHELL_UPLOAD_WRITE_FAILED__"
CONFLICT = "__ISHELL_UPLOAD_FOLDER_CONFLICT__"
UNSAFE = "__ISHELL_UPLOAD_FOLDER_UNSAFE__"
EXTRACT_FAILED = "__ISHELL_UPLOAD_FOLDER_EXTRACT_FAILED__"
COMMIT_FAILED = "__ISHELL_UPLOAD_FOLDER_COMMIT_FAILED__"
CHANGED = "__ISHELL_UPLOAD_FOLDER_CHANGED__"
HEARTBEAT = "__ISHELL_UPLOAD_HEARTBEAT__"
last_heartbeat = 0.0
commit_phase = False
pending_interrupt = False


class UploadFailure(Exception):
    def __init__(self, code):
        self.code = code


def fail(marker, detail="", code=1):
    message = marker if not detail else marker + " " + detail
    print(message, file=sys.stderr, flush=True)
    raise UploadFailure(code)


def heartbeat():
    global last_heartbeat
    current = time.monotonic()
    if current - last_heartbeat >= 5.0:
        try:
            print(HEARTBEAT, file=sys.stderr, flush=True)
        except BrokenPipeError:
            if not globals().get("upload_committed", False):
                raise
        last_heartbeat = current


def lstat_optional(path):
    try:
        return os.lstat(path)
    except FileNotFoundError:
        return None


def system_mount_points():
    points = set()
    try:
        with open("/proc/self/mountinfo", "r", encoding="utf-8", errors="surrogateescape") as source:
            for line in source:
                fields = line.split(" - ", 1)[0].split()
                if len(fields) < 5:
                    continue
                decoded = re.sub(
                    r"\\([0-7]{3})",
                    lambda match: chr(int(match.group(1), 8)),
                    fields[4],
                )
                points.add(os.path.abspath(decoded))
    except OSError:
        pass
    return points


def is_mount_point(path, mount_points):
    return os.path.abspath(path) in mount_points or os.path.ismount(path)


def require_safe_directory(path, label):
    value = lstat_optional(path)
    if value is None:
        fail(UNSAFE, label + "-missing", 73)
    if stat.S_ISLNK(value.st_mode):
        fail(UNSAFE, label + "-symbolic-link", 73)
    if not stat.S_ISDIR(value.st_mode):
        fail(UNSAFE, label + "-not-directory", 73)


def require_safe_ancestors(path):
    absolute = os.path.abspath(path)
    if not absolute.startswith(os.sep):
        fail(UNSAFE, "remote-directory-not-absolute", 73)
    current = os.sep
    for component in [part for part in absolute.split(os.sep) if part]:
        current = os.path.join(current, component)
        value = lstat_optional(current)
        if value is None:
            fail(UNSAFE, "remote-directory-missing", 73)
        if stat.S_ISLNK(value.st_mode):
            fail(UNSAFE, "remote-directory-symbolic-link", 73)
        if not stat.S_ISDIR(value.st_mode):
            fail(UNSAFE, "remote-directory-component-not-directory", 73)


def directory_snapshots(path):
    revision = hashlib.sha256()
    rename_stable = hashlib.sha256()
    mount_points = system_mount_points()
    if is_mount_point(path, mount_points):
        fail(UNSAFE, "destination-is-mount-point", 73)
    root_device = os.lstat(path).st_dev

    def visit(current, relative):
        heartbeat()
        value = os.lstat(current)
        if stat.S_ISLNK(value.st_mode):
            fail(UNSAFE, "destination-symbolic-link", 73)
        if not stat.S_ISDIR(value.st_mode):
            fail(UNSAFE, "destination-not-directory", 73)
        revision_fields = (
            relative, value.st_dev, value.st_ino, value.st_mode, value.st_size,
            value.st_mtime_ns, value.st_ctime_ns, value.st_nlink,
        )
        stable_fields = (
            relative, value.st_dev, value.st_ino, value.st_mode, value.st_size,
            value.st_mtime_ns, None if not relative else value.st_ctime_ns, value.st_nlink,
        )
        revision.update(repr(revision_fields).encode("utf-8", "surrogateescape"))
        rename_stable.update(repr(stable_fields).encode("utf-8", "surrogateescape"))
        with os.scandir(current) as entries:
            ordered = sorted(entries, key=lambda entry: entry.name)
        for entry in ordered:
            entry_path = os.path.join(current, entry.name)
            entry_relative = entry.name if not relative else relative + "/" + entry.name
            entry_value = os.lstat(entry_path)
            fields = (
                entry_relative, entry_value.st_dev, entry_value.st_ino,
                entry_value.st_mode, entry_value.st_size, entry_value.st_mtime_ns,
                entry_value.st_ctime_ns, entry_value.st_nlink,
            )
            encoded = repr(fields).encode("utf-8", "surrogateescape")
            revision.update(encoded)
            rename_stable.update(encoded)
            if stat.S_ISLNK(entry_value.st_mode):
                link_target = os.fsencode(os.readlink(entry_path))
                revision.update(link_target)
                rename_stable.update(link_target)
            elif stat.S_ISDIR(entry_value.st_mode):
                if entry_value.st_dev != root_device or is_mount_point(entry_path, mount_points):
                    fail(UNSAFE, "destination-contains-mount-point", 73)
                visit(entry_path, entry_relative)

    visit(path, "")
    return revision.hexdigest(), rename_stable.hexdigest()


def try_exchange_directories(first, second):
    libc = ctypes.CDLL(None, use_errno=True)
    first_bytes = os.fsencode(first)
    second_bytes = os.fsencode(second)
    renameat2 = getattr(libc, "renameat2", None)
    if renameat2 is not None:
        renameat2.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        ]
        renameat2.restype = ctypes.c_int
        result = renameat2(-100, first_bytes, -100, second_bytes, 2)
    else:
        renamex_np = getattr(libc, "renamex_np", None)
        if renamex_np is None:
            return False
        renamex_np.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        renamex_np.restype = ctypes.c_int
        result = renamex_np(first_bytes, second_bytes, 2)
    if result == 0:
        return True
    error_number = ctypes.get_errno()
    unsupported = {
        errno.ENOSYS,
        errno.EINVAL,
        errno.EXDEV,
        getattr(errno, "ENOTSUP", errno.EINVAL),
        getattr(errno, "EOPNOTSUPP", errno.EINVAL),
    }
    if error_number in unsupported:
        return False
    raise OSError(error_number, os.strerror(error_number))


def safe_member_parts(member):
    raw = member.name
    if not raw or raw.startswith("/"):
        fail(UNSAFE, "archive-absolute-or-empty-path", 73)
    parts = [part for part in PurePosixPath(raw).parts if part not in ("", ".")]
    if not parts or any(part == ".." for part in parts):
        fail(UNSAFE, "archive-parent-path", 73)
    if member.issym() or member.islnk():
        fail(UNSAFE, "archive-link", 73)
    if not (member.isdir() or member.isfile()):
        fail(UNSAFE, "archive-special-file", 73)
    return parts


def extract_archive(archive_path, staging_path):
    try:
        with tarfile.open(archive_path, mode="r:") as archive:
            members = archive.getmembers()
            seen = set()
            prepared = []
            for member in members:
                heartbeat()
                parts = safe_member_parts(member)
                key = tuple(parts)
                if key in seen:
                    fail(UNSAFE, "archive-duplicate-path", 73)
                seen.add(key)
                prepared.append((member, parts))

            directory_attributes = []
            for member, parts in prepared:
                heartbeat()
                target = os.path.join(staging_path, *parts)
                if os.path.commonpath((staging_path, target)) != staging_path:
                    fail(UNSAFE, "archive-path-escape", 73)
                if member.isdir():
                    os.makedirs(target, exist_ok=True)
                    directory_attributes.append((target, member.mode, member.mtime))
                    continue
                os.makedirs(os.path.dirname(target), exist_ok=True)
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
                if hasattr(os, "O_NOFOLLOW"):
                    flags |= os.O_NOFOLLOW
                descriptor = os.open(target, flags, member.mode & 0o777)
                source = archive.extractfile(member)
                if source is None:
                    os.close(descriptor)
                    fail(EXTRACT_FAILED, "missing-file-data", 74)
                with source, os.fdopen(descriptor, "wb", buffering=0) as output:
                    while True:
                        chunk = source.read(64 * 1024)
                        if not chunk:
                            break
                        view = memoryview(chunk)
                        while view:
                            written = output.write(view)
                            if written is None:
                                written = len(view)
                            if written <= 0:
                                fail(EXTRACT_FAILED, "short-write", 74)
                            view = view[written:]
                        heartbeat()
                if os.lstat(target).st_size != member.size:
                    fail(EXTRACT_FAILED, "member-size-mismatch", 74)
                os.chmod(target, member.mode & 0o777)
                os.utime(target, (member.mtime, member.mtime))
            for target, mode, modified in reversed(directory_attributes):
                os.chmod(target, mode & 0o777)
                os.utime(target, (modified, modified))
    except UploadFailure:
        raise
    except Exception as error:
        fail(EXTRACT_FAILED, str(error), 74)


def remove_staging(path, root_device=None, mount_points=None):
    value = lstat_optional(path)
    if value is None:
        return
    if mount_points is None:
        mount_points = system_mount_points()
    if root_device is None:
        if is_mount_point(path, mount_points):
            raise OSError("refusing to remove mounted directory")
        root_device = value.st_dev
    elif value.st_dev != root_device or is_mount_point(path, mount_points):
        raise OSError("refusing to remove mounted directory")
    heartbeat()
    if stat.S_ISLNK(value.st_mode) or not stat.S_ISDIR(value.st_mode):
        os.unlink(path)
        return
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass
    with os.scandir(path) as entries:
        children = list(entries)
    for entry in children:
        child = os.path.join(path, entry.name)
        child_value = os.lstat(child)
        if stat.S_ISDIR(child_value.st_mode) and not stat.S_ISLNK(child_value.st_mode):
            if child_value.st_dev != root_device or is_mount_point(child, mount_points):
                raise OSError("refusing to remove mounted directory")
            remove_staging(child, root_device, mount_points)
        else:
            os.unlink(child)
        heartbeat()
    os.rmdir(path)


def interrupted(_signum, _frame):
    global pending_interrupt
    if commit_phase or globals().get("upload_committed", False):
        pending_interrupt = True
        return
    fail(WRITE_FAILED, "interrupted", 130)


for signal_name in ("SIGHUP", "SIGINT", "SIGTERM"):
    signal_value = getattr(signal, signal_name, None)
    if signal_value is not None:
        signal.signal(signal_value, interrupted)


def valid_snapshot_token(value):
    return len(value) == 64 and all(character in "0123456789abcdef" for character in value)


(
    remote_dir,
    folder_name,
    archive_path,
    staging_path,
    expected_text,
    root_mode_text,
    replace_text,
    expected_destination_revision,
    expected_destination_stable,
) = sys.argv[1:10]
expected = int(expected_text)
root_mode = int(root_mode_text, 8)
replace_existing = replace_text == "1"
archive_created = False
staging_created = False
placeholder_created = False
placeholder_signature = None
staging_contains_old = False
preserve_staging = False
upload_committed = False
destination = None

try:
    if replace_text not in ("0", "1"):
        fail(UNSAFE, "invalid-replace-flag", 73)
    if folder_name in ("", ".", "..") or "/" in folder_name or "\x00" in folder_name:
        fail(UNSAFE, "invalid-folder-name", 73)
    require_safe_ancestors(remote_dir)
    require_safe_directory(remote_dir, "remote-directory")
    remote_dir = os.path.abspath(remote_dir)
    remote_dir_value = os.lstat(remote_dir)
    remote_dir_signature = (remote_dir_value.st_dev, remote_dir_value.st_ino, remote_dir_value.st_mode)
    if os.path.dirname(os.path.abspath(archive_path)) != remote_dir:
        fail(UNSAFE, "archive-outside-remote-directory", 73)
    if os.path.dirname(os.path.abspath(staging_path)) != remote_dir:
        fail(UNSAFE, "staging-outside-remote-directory", 73)

    destination = os.path.join(remote_dir, folder_name)
    initial_destination = lstat_optional(destination)
    initial_destination_identity = None
    initial_destination_snapshot = None
    if initial_destination is not None:
        if stat.S_ISLNK(initial_destination.st_mode):
            fail(UNSAFE, "destination-symbolic-link", 73)
        if not stat.S_ISDIR(initial_destination.st_mode):
            fail(UNSAFE, "destination-not-directory", 73)
    if not replace_existing:
        if initial_destination is not None:
            fail(CONFLICT, "destination-already-exists", 73)
    elif expected_destination_revision == "missing":
        if expected_destination_stable != "missing":
            fail(UNSAFE, "invalid-missing-revision", 73)
        if initial_destination is not None:
            fail(CHANGED, "destination-created-after-confirmation", 76)
    else:
        if not (
            valid_snapshot_token(expected_destination_revision)
            and valid_snapshot_token(expected_destination_stable)
        ):
            fail(UNSAFE, "invalid-destination-revision", 73)
        if initial_destination is None:
            fail(CHANGED, "destination-removed-after-confirmation", 76)
        initial_destination_identity = (
            initial_destination.st_dev,
            initial_destination.st_ino,
            initial_destination.st_mode,
        )

    try:
        descriptor = os.open(archive_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        archive_created = True
        with os.fdopen(descriptor, "wb", buffering=0) as output:
            transferred = 0
            while True:
                chunk = sys.stdin.buffer.read(64 * 1024)
                if not chunk:
                    break
                view = memoryview(chunk)
                while view:
                    written = output.write(view)
                    if written is None:
                        written = len(view)
                    if written <= 0:
                        raise OSError("remote archive accepted no data")
                    transferred += written
                    view = view[written:]
    except UploadFailure:
        raise
    except Exception as error:
        fail(WRITE_FAILED, str(error), 74)

    if transferred != expected:
        fail(SIZE_MISMATCH, "expected=" + str(expected) + " actual=" + str(transferred), 75)

    try:
        os.mkdir(staging_path, 0o700)
        staging_created = True
    except Exception as error:
        fail(EXTRACT_FAILED, "staging: " + str(error), 74)

    extract_archive(archive_path, staging_path)
    heartbeat()
    current_remote_dir = os.lstat(remote_dir)
    if (current_remote_dir.st_dev, current_remote_dir.st_ino, current_remote_dir.st_mode) != remote_dir_signature:
        fail(UNSAFE, "remote-directory-changed", 73)

    current_destination = lstat_optional(destination)
    if expected_destination_revision == "missing" or not replace_existing:
        if current_destination is not None:
            if stat.S_ISLNK(current_destination.st_mode):
                fail(UNSAFE, "destination-symbolic-link", 73)
            if not stat.S_ISDIR(current_destination.st_mode):
                fail(UNSAFE, "destination-not-directory", 73)
            if replace_existing:
                fail(CHANGED, "destination-created-during-upload", 76)
            fail(CONFLICT, "destination-already-exists", 73)
    else:
        if current_destination is None:
            fail(CHANGED, "destination-removed-during-upload", 76)
        if stat.S_ISLNK(current_destination.st_mode):
            fail(UNSAFE, "destination-symbolic-link", 73)
        if not stat.S_ISDIR(current_destination.st_mode):
            fail(UNSAFE, "destination-not-directory", 73)
        current_identity = (
            current_destination.st_dev,
            current_destination.st_ino,
            current_destination.st_mode,
        )
        if current_identity != initial_destination_identity:
            fail(CHANGED, "destination-replaced-during-upload", 76)
        try:
            current_revision, initial_destination_snapshot = directory_snapshots(destination)
        except UploadFailure:
            raise
        except OSError as error:
            fail(CHANGED, "snapshot: " + str(error), 76)
        if (
            current_revision != expected_destination_revision
            or initial_destination_snapshot != expected_destination_stable
        ):
            fail(CHANGED, "destination-content-changed-during-upload", 76)

    os.chmod(staging_path, root_mode)

    commit_phase = True
    try:
        if expected_destination_revision == "missing" or not replace_existing:
            try:
                os.mkdir(destination, 0o700)
                placeholder_created = True
                placeholder_value = os.lstat(destination)
                placeholder_signature = (placeholder_value.st_dev, placeholder_value.st_ino)
            except FileExistsError:
                raced_destination = lstat_optional(destination)
                if (
                    raced_destination is not None
                    and stat.S_ISDIR(raced_destination.st_mode)
                    and not stat.S_ISLNK(raced_destination.st_mode)
                    and not replace_existing
                ):
                    fail(CONFLICT, "destination-already-exists", 73)
                fail(CHANGED, "destination-created-during-commit", 76)
            except UploadFailure:
                raise
            except Exception as error:
                fail(COMMIT_FAILED, "reservation: " + str(error), 77)
            try:
                os.replace(staging_path, destination)
            except Exception as error:
                try:
                    os.chmod(staging_path, 0o700)
                except OSError:
                    pass
                fail(COMMIT_FAILED, str(error), 77)
            staging_created = False
            placeholder_created = False
            upload_committed = True
        else:
            staging_value = os.lstat(staging_path)
            staging_identity = (staging_value.st_dev, staging_value.st_ino, staging_value.st_mode)
            try:
                _, staging_snapshot = directory_snapshots(staging_path)
            except UploadFailure:
                raise
            except OSError as error:
                fail(COMMIT_FAILED, "staging-snapshot: " + str(error), 77)
            if not try_exchange_directories(destination, staging_path):
                fail(COMMIT_FAILED, "atomic-directory-exchange-unavailable", 77)
            staging_contains_old = True

            exchanged_destination = os.lstat(destination)
            exchanged_old = os.lstat(staging_path)
            exchanged_destination_identity = (
                exchanged_destination.st_dev,
                exchanged_destination.st_ino,
                exchanged_destination.st_mode,
            )
            exchanged_old_identity = (
                exchanged_old.st_dev,
                exchanged_old.st_ino,
                exchanged_old.st_mode,
            )
            old_changed = (
                exchanged_destination_identity != staging_identity
                or exchanged_old_identity != initial_destination_identity
            )
            if not old_changed:
                try:
                    _, exchanged_old_snapshot = directory_snapshots(staging_path)
                    old_changed = exchanged_old_snapshot != initial_destination_snapshot
                except (UploadFailure, OSError):
                    old_changed = True
            if old_changed:
                new_changed = True
                try:
                    _, exchanged_new_snapshot = directory_snapshots(destination)
                    new_changed = exchanged_new_snapshot != staging_snapshot
                except (UploadFailure, OSError):
                    pass
                if try_exchange_directories(destination, staging_path):
                    staging_contains_old = False
                    preserve_staging = new_changed
                    detail = "destination-content-changed-during-commit"
                    if preserve_staging:
                        detail += "; replacement-preserved-at=" + staging_path
                    fail(CHANGED, detail, 76)
                preserve_staging = True
                fail(
                    COMMIT_FAILED,
                    "rollback-failed; old-directory-preserved-at=" + staging_path,
                    77,
                )
            upload_committed = True
    except UploadFailure:
        raise
    except Exception as error:
        fail(COMMIT_FAILED, str(error), 77)
    finally:
        commit_phase = False

    if upload_committed and staging_contains_old:
        try:
            remove_staging(staging_path)
            staging_created = False
            staging_contains_old = False
        except OSError:
            pass
except UploadFailure as error:
    sys.exit(error.code)
except Exception as error:
    print(COMMIT_FAILED + " " + str(error), file=sys.stderr, flush=True)
    sys.exit(1)
finally:
    commit_phase = False
    if placeholder_created and destination is not None:
        try:
            placeholder_value = os.lstat(destination)
            if (
                stat.S_ISDIR(placeholder_value.st_mode)
                and not stat.S_ISLNK(placeholder_value.st_mode)
                and (placeholder_value.st_dev, placeholder_value.st_ino) == placeholder_signature
            ):
                os.rmdir(destination)
        except OSError:
            pass
    if staging_created and not staging_contains_old and not preserve_staging:
        try:
            remove_staging(staging_path)
        except OSError:
            pass
    if upload_committed and staging_contains_old:
        try:
            remove_staging(staging_path)
        except OSError:
            pass
    if archive_created:
        try:
            os.unlink(archive_path)
        except OSError:
            pass
"#;
