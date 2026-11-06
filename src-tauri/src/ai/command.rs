//! Read/write classification of a shell command for the automatic permission
//! mode: commands that only read run without asking, anything that writes,
//! changes server state, or cannot be classified asks first.
//!
//! The command is split into simple commands (`;`, `&&`, `||`, `|`, `&`,
//! subshells, `$(…)`, backticks, process substitution); each is classified on
//! its own and the most cautious result wins. Redirections to files count as
//! writes. This is an approval policy, not a sandbox.

/// What running a command may do, from least to most cautious.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Effect {
    /// Only reads or queries.
    Read,
    /// Reads, but keeps running until the tool timeout or dumps a device.
    Endless(&'static str),
    /// Writes files or changes server state, or cannot be classified.
    Write(&'static str),
    /// Destroys data or interrupts the server.
    Destructive(&'static str),
}

impl Effect {
    fn rank(self) -> u8 {
        match self {
            Effect::Read => 0,
            Effect::Endless(_) => 1,
            Effect::Write(_) => 2,
            Effect::Destructive(_) => 3,
        }
    }
    fn max(self, other: Effect) -> Effect {
        if other.rank() > self.rank() {
            other
        } else {
            self
        }
    }
}

/// The result for a whole command line.
pub struct Analysis {
    pub effect: Effect,
    /// Every word, including assignments and redirection targets, for the
    /// credential-path check.
    pub words: Vec<String>,
    /// Unquoted words with glob characters, which expand to unseen names.
    pub globs: Vec<String>,
}

const UNPARSED: &str = "包含无法静态解析的 Shell 语法（如双引号内的命令替换或未闭合的引号）";
const UNKNOWN: &str = "无法确认该命令是否只读";
const WRITES: &str = "会写入文件或修改服务器状态";
const REDIRECT: &str = "重定向输出到文件，会写入或覆盖文件";
const RUNS_CODE: &str = "会执行脚本或任意代码，无法确认其影响";
const PACKAGES: &str = "会安装、更新或删除软件";
const SERVICES: &str = "会启动、停止或修改服务";
const DESTROYS: &str = "可能删除数据、格式化磁盘或中断服务器";
const FOLLOWS: &str =
    "持续输出的命令会一直运行到超时，建议改用一次性查询（如 tail -n、docker stats --no-stream）";
const DEVICE: &str = "读取设备文件可能无限输出或泄露磁盘数据";

struct Lexed {
    segments: Vec<Vec<String>>,
    globs: Vec<String>,
    redirect_targets: Vec<String>,
    inputs: Vec<String>,
}

fn is_separator(c: char) -> bool {
    matches!(c, ';' | '\n' | '|' | '&' | '(' | ')' | '`' | '<' | '>')
}

/// Reads one word starting at `i` (after optional blanks), stripping quotes.
fn read_word(chars: &[char], mut i: usize) -> (String, usize) {
    while i < chars.len() && matches!(chars[i], ' ' | '\t') {
        i += 1;
    }
    let mut word = String::new();
    while i < chars.len() {
        let c = chars[i];
        if c == '\'' || c == '"' {
            i += 1;
            while i < chars.len() && chars[i] != c {
                word.push(chars[i]);
                i += 1;
            }
            i += 1;
            continue;
        }
        if c.is_whitespace() || is_separator(c) {
            break;
        }
        if c == '\\' && i + 1 < chars.len() {
            i += 1;
        }
        word.push(chars[i]);
        i += 1;
    }
    (word, i)
}

// The final `end_segment!` resets state that is not read afterwards.
#[allow(unused_assignments)]
fn lex(command: &str) -> Option<Lexed> {
    let chars: Vec<char> = command.chars().collect();
    let mut out = Lexed {
        segments: Vec::new(),
        globs: Vec::new(),
        redirect_targets: Vec::new(),
        inputs: Vec::new(),
    };
    let mut words: Vec<String> = Vec::new();
    let mut word = String::new();
    let mut active = false;
    let mut glob = false;
    let mut heredocs: Vec<String> = Vec::new();
    let mut i = 0;

    macro_rules! end_word {
        () => {{
            if active {
                if glob {
                    out.globs.push(word.clone());
                }
                words.push(std::mem::take(&mut word));
                active = false;
                glob = false;
            }
        }};
    }
    macro_rules! end_segment {
        () => {{
            end_word!();
            if !words.is_empty() {
                out.segments.push(std::mem::take(&mut words));
            }
        }};
    }

    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        match c {
            ' ' | '\t' => end_word!(),
            '\'' => {
                active = true;
                i += 1;
                while i < chars.len() && chars[i] != '\'' {
                    word.push(chars[i]);
                    i += 1;
                }
                if i >= chars.len() {
                    return None;
                }
            }
            '"' => {
                active = true;
                i += 1;
                loop {
                    let c = *chars.get(i)?;
                    match c {
                        '"' => break,
                        // Substitutions run even inside double quotes.
                        '`' => return None,
                        '$' if chars.get(i + 1) == Some(&'(') => return None,
                        '\\' if matches!(chars.get(i + 1), Some('$' | '`' | '"' | '\\')) => {
                            word.push(chars[i + 1]);
                            i += 1;
                        }
                        _ => word.push(c),
                    }
                    i += 1;
                }
            }
            '\\' => {
                if let Some(n) = next {
                    if n != '\n' {
                        word.push(n);
                        active = true;
                    }
                    i += 1;
                }
            }
            '#' if !active => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
                continue;
            }
            '\n' => {
                end_segment!();
                // Skip here-document bodies; they are data, not commands.
                for delimiter in std::mem::take(&mut heredocs) {
                    i += 1;
                    loop {
                        let start = i;
                        while i < chars.len() && chars[i] != '\n' {
                            i += 1;
                        }
                        let line: String = chars[start..i].iter().collect();
                        if line.trim() == delimiter || i >= chars.len() {
                            break;
                        }
                        i += 1;
                    }
                }
            }
            ';' | '|' | '(' | ')' | '`' => end_segment!(),
            '$' if next == Some('(') => {
                end_segment!();
                i += 1;
            }
            '&' if next != Some('>') => end_segment!(),
            '<' if next == Some('(') => {
                end_segment!();
                i += 1;
            }
            '<' => {
                end_word!();
                if next == Some('<') {
                    i += 2;
                    if chars.get(i) == Some(&'<') {
                        // Here-string: the word is data.
                        let (_, j) = read_word(&chars, i + 1);
                        i = j;
                    } else {
                        if chars.get(i) == Some(&'-') {
                            i += 1;
                        }
                        let (delimiter, j) = read_word(&chars, i);
                        heredocs.push(delimiter);
                        i = j;
                    }
                    continue;
                }
                let (target, j) = read_word(&chars, i + 1);
                out.inputs.push(target);
                i = j;
                continue;
            }
            '>' | '&' => {
                // A file-descriptor number right before `>` is not a word.
                if active && !word.is_empty() && word.chars().all(|c| c.is_ascii_digit()) {
                    word.clear();
                    active = false;
                    glob = false;
                }
                end_word!();
                if c == '&' {
                    i += 1; // `&>`
                }
                i += 1;
                if chars.get(i) == Some(&'>') || chars.get(i) == Some(&'|') {
                    i += 1;
                }
                if chars.get(i) == Some(&'&') {
                    // `2>&1`, `>&-`: duplicates a descriptor, writes no file.
                    i += 1;
                    while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '-') {
                        i += 1;
                    }
                    continue;
                }
                let (target, j) = read_word(&chars, i);
                out.redirect_targets.push(target);
                i = j;
                continue;
            }
            '*' | '?' | '[' => {
                glob = true;
                active = true;
                word.push(c);
            }
            _ => {
                active = true;
                word.push(c);
            }
        }
        i += 1;
    }
    end_segment!();
    Some(out)
}

fn is_assignment(word: &str) -> bool {
    match word.split_once('=') {
        Some((name, _)) => {
            !name.is_empty()
                && !name.starts_with(|c: char| c.is_ascii_digit())
                && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        }
        None => false,
    }
}

/// Words that are neither options nor the values of `value_flags`.
fn positionals<'a>(args: &'a [String], value_flags: &[&str]) -> Vec<&'a str> {
    let mut out = Vec::new();
    let mut skip = false;
    for arg in args {
        if skip {
            skip = false;
            continue;
        }
        if arg.starts_with('-') && arg.len() > 1 {
            skip = value_flags.contains(&arg.as_str());
            continue;
        }
        out.push(arg.as_str());
    }
    out
}

fn has(args: &[String], options: &[&str]) -> bool {
    args.iter().any(|arg| options.contains(&arg.as_str()))
}

/// A short-option cluster such as `-tf` contains `letter`.
fn short_flag(args: &[String], letter: char) -> bool {
    args.iter()
        .any(|arg| arg.starts_with('-') && !arg.starts_with("--") && arg[1..].contains(letter))
}

/// Drops wrappers (`sudo`, `env`, `timeout`, …), assignments and shell
/// keywords in front of the actual program.
fn strip_prefix(words: &[String]) -> &[String] {
    let mut rest = words;
    loop {
        let Some(first) = rest.first() else {
            return rest;
        };
        let first = first.as_str();
        let take_options = |rest: &[String], valued: &[&str]| -> usize {
            let mut n = 1;
            while n < rest.len() && rest[n].starts_with('-') {
                if valued.contains(&rest[n].as_str()) {
                    n += 1;
                }
                n += 1;
            }
            n
        };
        let skip = if is_assignment(first)
            || matches!(
                first,
                "if" | "then"
                    | "else"
                    | "elif"
                    | "do"
                    | "while"
                    | "until"
                    | "!"
                    | "{"
                    | "}"
                    | "fi"
                    | "done"
                    | "esac"
                    | "time"
                    | "nohup"
                    | "exec"
                    | "builtin"
            ) {
            1
        } else {
            match first {
                "sudo" | "doas" => take_options(
                    rest,
                    &[
                        "-u", "-g", "-p", "-C", "-h", "-U", "-r", "-t", "-T", "--user", "--group",
                    ],
                ),
                "env" => {
                    let mut n = take_options(rest, &["-u", "--unset", "-C", "--chdir", "-S"]);
                    while n < rest.len() && is_assignment(&rest[n]) {
                        n += 1;
                    }
                    n
                }
                "nice" | "ionice" | "stdbuf" | "chrt" | "taskset" => {
                    take_options(rest, &["-n", "-c", "-p", "-o", "-i", "-e"])
                }
                "timeout" => take_options(rest, &["-s", "-k", "--signal", "--kill-after"]) + 1,
                "command" if rest.get(1).is_some_and(|w| w == "-v" || w == "-V") => {
                    return &rest[..0];
                }
                "command" => take_options(rest, &[]),
                _ => return rest,
            }
        };
        rest = &rest[skip.min(rest.len())..];
    }
}

/// Programs that only print or query.
const READ_ONLY: &[&str] = &[
    "ls",
    "ll",
    "la",
    "dir",
    "vdir",
    "cat",
    "tac",
    "head",
    "less",
    "more",
    "grep",
    "egrep",
    "fgrep",
    "rg",
    "ag",
    "ack",
    "wc",
    "sort",
    "uniq",
    "cut",
    "tr",
    "column",
    "paste",
    "join",
    "fold",
    "fmt",
    "nl",
    "diff",
    "cmp",
    "comm",
    "file",
    "stat",
    "du",
    "df",
    "free",
    "uptime",
    "ps",
    "pstree",
    "pgrep",
    "pidof",
    "lsof",
    "ss",
    "netstat",
    "nstat",
    "traceroute",
    "tracepath",
    "dig",
    "nslookup",
    "host",
    "whois",
    "whoami",
    "id",
    "groups",
    "who",
    "w",
    "last",
    "lastb",
    "lastlog",
    "users",
    "uname",
    "arch",
    "pwd",
    "which",
    "whereis",
    "type",
    "realpath",
    "readlink",
    "basename",
    "dirname",
    "md5sum",
    "sha1sum",
    "sha224sum",
    "sha256sum",
    "sha384sum",
    "sha512sum",
    "b2sum",
    "cksum",
    "base64",
    "base32",
    "xxd",
    "hexdump",
    "od",
    "strings",
    "tree",
    "lsblk",
    "blkid",
    "lscpu",
    "lsmem",
    "lspci",
    "lsusb",
    "lsmod",
    "lshw",
    "lsns",
    "lsattr",
    "lsb_release",
    "getfacl",
    "nproc",
    "getconf",
    "ulimit",
    "findmnt",
    "env",
    "printenv",
    "echo",
    "printf",
    "true",
    "false",
    "test",
    "[",
    "[[",
    ":",
    "sleep",
    "seq",
    "cal",
    "locale",
    "jq",
    "yq",
    "xmllint",
    "zcat",
    "zgrep",
    "zegrep",
    "zfgrep",
    "zless",
    "zmore",
    "xzcat",
    "bzcat",
    "lz4cat",
    "zstdcat",
    "cd",
    "export",
    "unset",
    "set",
    "alias",
    "read",
    "local",
    "declare",
    "shift",
    "return",
    "exit",
    "wait",
    "systemd-analyze",
    "loginctl",
    "getent",
    "namei",
    "expr",
    "bc",
    "dc",
    "factor",
    "ldd",
    "nm",
    "objdump",
    "readelf",
    "iconv",
    "numfmt",
    "dmidecode",
    "hostid",
    "pwdx",
    "ipcs",
    "quota",
    "virt-what",
    "systemd-detect-virt",
    "neofetch",
    "fastfetch",
    "apt-cache",
    "dpkg-query",
    "locate",
    "plocate",
    "mlocate",
    "fd",
    "fdfind",
    "for",
    "case",
    "select",
    "function",
    "iptables-save",
    "ip6tables-save",
    "lsinitramfs",
    "sensors",
    "tput",
    "shuf",
    "rev",
    "look",
    "tty",
    "logname",
    "md5",
    "sha1",
    "sum",
    "stty",
];

const SHELLS_AND_INTERPRETERS: &[&str] = &[
    "sh",
    "bash",
    "zsh",
    "dash",
    "ksh",
    "fish",
    "csh",
    "tcsh",
    "ash",
    "busybox",
    "python",
    "python2",
    "python3",
    "pypy",
    "pypy3",
    "node",
    "nodejs",
    "deno",
    "bun",
    "perl",
    "ruby",
    "php",
    "lua",
    "luajit",
    "java",
    "jshell",
    "Rscript",
    "julia",
    "tclsh",
    "expect",
    "osascript",
    "source",
    ".",
    "eval",
    "xonsh",
    "pwsh",
    "powershell",
];

const ALWAYS_WRITE: &[&str] = &[
    "mv",
    "cp",
    "ln",
    "mkdir",
    "touch",
    "chmod",
    "chown",
    "chgrp",
    "chattr",
    "setfacl",
    "truncate",
    "install",
    "rsync",
    "scp",
    "sftp",
    "ssh",
    "patch",
    "kill",
    "killall",
    "pkill",
    "useradd",
    "usermod",
    "adduser",
    "groupadd",
    "groupmod",
    "gpasswd",
    "passwd",
    "chpasswd",
    "chsh",
    "chfn",
    "visudo",
    "vipw",
    "vigr",
    "mkswap",
    "swapoff",
    "umount",
    "modprobe",
    "insmod",
    "rmmod",
    "depmod",
    "update-grub",
    "grub-install",
    "update-alternatives",
    "ldconfig",
    "systemd-run",
    "at",
    "batch",
    "logrotate",
    "vi",
    "vim",
    "nvim",
    "nano",
    "emacs",
    "ed",
    "ex",
    "screen",
    "tmux",
    "nc",
    "ncat",
    "netcat",
    "socat",
    "telnet",
    "ftp",
    "mail",
    "sendmail",
    "wall",
    "write",
    "make",
    "cmake",
    "gcc",
    "cc",
    "g++",
    "clang",
    "ld",
    "mysql",
    "mariadb",
    "psql",
    "mongo",
    "mongosh",
    "redis-cli",
    "sqlite3",
    "mysqladmin",
    "mysqldump",
    "pg_dump",
    "createdb",
    "dropdb",
    "setenforce",
    "setsebool",
    "chcon",
    "restorecon",
    "update-ca-certificates",
    "a2enmod",
    "a2dismod",
    "a2ensite",
    "a2dissite",
    "unlink",
    "mknod",
    "mkfifo",
    "split",
    "csplit",
    "lvcreate",
    "lvremove",
    "lvextend",
    "vgcreate",
    "pvcreate",
    "resize2fs",
    "xfs_growfs",
    "tune2fs",
    "e2fsck",
    "fsck",
    "growpart",
    "losetup",
    "cryptsetup",
    "exportfs",
    "quotaon",
    "quotaoff",
    "chroot",
    "unshare",
    "nsenter",
    "su",
    "runuser",
    "newgrp",
    "strace",
    "ltrace",
    "gdb",
    "pm2",
    "supervisorctl",
    "certbot",
    "acme.sh",
    "virtualenv",
    "venv",
    "conda",
    "mamba",
    "nvm",
    "rbenv",
    "pyenv",
    "sdk",
    "rustup",
    "ansible",
    "ansible-playbook",
    "salt",
    "puppet",
    "chef-client",
];

const DESTRUCTIVE: &[&str] = &[
    "rm",
    "rmdir",
    "shred",
    "wipefs",
    "dd",
    "reboot",
    "shutdown",
    "poweroff",
    "halt",
    "init",
    "telinit",
    "userdel",
    "groupdel",
    "deluser",
    "delgroup",
    "parted",
    "sfdisk",
    "gdisk",
    "sgdisk",
    "lvremove",
    "vgremove",
    "pvremove",
    "mdadm",
    "zpool",
    "blkdiscard",
];

/// Programs that print a device's contents.
const DUMPS_CONTENT: &[&str] = &[
    "cat",
    "tac",
    "head",
    "tail",
    "less",
    "more",
    "od",
    "xxd",
    "hexdump",
    "strings",
    "base64",
    "grep",
    "md5sum",
    "sha1sum",
    "sha256sum",
    "sha512sum",
    "cksum",
];

fn read_if(read: bool, reason: &'static str) -> Effect {
    if read {
        Effect::Read
    } else {
        Effect::Write(reason)
    }
}

/// `docker`, `podman`, `nerdctl`, `docker-compose`.
fn container(program: &str, args: &[String]) -> Effect {
    let valued = [
        "-H",
        "--host",
        "--context",
        "-c",
        "--config",
        "-l",
        "--log-level",
        "-f",
        "--file",
        "-p",
        "--project-name",
        "--project-directory",
        "--env-file",
        "--profile",
        "--tail",
        "-n",
        "--since",
        "--until",
        "--format",
        "--filter",
    ];
    let words = positionals(args, &valued);
    let (_group, action) = if program == "docker-compose" {
        ("compose", words.first().copied())
    } else {
        match words.first().copied() {
            Some(
                group @ ("container" | "image" | "network" | "volume" | "system" | "compose"
                | "buildx" | "node" | "service" | "stack" | "plugin" | "secret" | "config"
                | "context" | "manifest" | "trust" | "builder" | "swarm"),
            ) => (group, words.get(1).copied()),
            other => ("", other),
        }
    };
    let Some(action) = action else {
        return Effect::Read;
    };
    // `-f` before the action is a compose file; after `logs` it follows.
    let after: Vec<String> = args
        .iter()
        .skip_while(|arg| arg.as_str() != action)
        .skip(1)
        .cloned()
        .collect();
    let follow = has(&after, &["-f", "--follow"]) || short_flag(&after, 'f');
    match action {
        "stats" if !has(args, &["--no-stream"]) => Effect::Endless(FOLLOWS),
        "events" => Effect::Endless(FOLLOWS),
        "logs" if follow => Effect::Endless(FOLLOWS),
        "ps" | "ls" | "list" | "images" | "info" | "version" | "stats" | "top" | "logs"
        | "inspect" | "port" | "diff" | "history" | "search" | "df" | "show" | "config"
        | "--version" | "-v" | "help" | "--help" => Effect::Read,
        _ => Effect::Write(SERVICES),
    }
}

fn kubectl(args: &[String]) -> Effect {
    let valued = [
        "-n",
        "--namespace",
        "--context",
        "--kubeconfig",
        "-l",
        "--selector",
        "-o",
        "--output",
        "-c",
        "--container",
        "--cluster",
        "--user",
        "--since",
        "--tail",
        "--field-selector",
        "-s",
        "--server",
    ];
    let words = positionals(args, &valued);
    if has(args, &["-w", "--watch"])
        || (words.first() == Some(&"logs") && has(args, &["-f", "--follow"]))
    {
        return Effect::Endless(FOLLOWS);
    }
    match words.first().copied() {
        None => Effect::Read,
        Some(
            "get" | "describe" | "logs" | "top" | "explain" | "api-resources" | "api-versions"
            | "version" | "cluster-info" | "events" | "diff" | "auth",
        ) => Effect::Read,
        Some("config") => read_if(
            matches!(
                words.get(1).copied(),
                Some("view" | "get-contexts" | "current-context" | "get-clusters" | "get-users")
            ),
            SERVICES,
        ),
        Some("rollout") => read_if(
            matches!(words.get(1).copied(), Some("status" | "history")),
            SERVICES,
        ),
        _ => Effect::Write(SERVICES),
    }
}

fn git(args: &[String]) -> Effect {
    let valued = ["-C", "-c", "--git-dir", "--work-tree", "--namespace"];
    let mut start = 0;
    while start < args.len() && args[start].starts_with('-') {
        if valued.contains(&args[start].as_str()) {
            start += 1;
        }
        start += 1;
    }
    let Some(sub) = args.get(start) else {
        return Effect::Read;
    };
    let rest = &args[start + 1..];
    let rest_words = positionals(
        rest,
        &[
            "--contains",
            "--no-contains",
            "--merged",
            "--no-merged",
            "--points-at",
            "--format",
            "--sort",
            "-n",
            "--pretty",
            "--since",
            "--until",
            "--author",
            "--grep",
            "-S",
            "-G",
        ],
    );
    let read = match sub.as_str() {
        "status" | "log" | "diff" | "show" | "rev-parse" | "describe" | "blame" | "ls-files"
        | "ls-tree" | "ls-remote" | "shortlog" | "grep" | "cat-file" | "rev-list" | "show-ref"
        | "for-each-ref" | "count-objects" | "whatchanged" | "name-rev" | "merge-base"
        | "check-ignore" | "check-attr" | "var" | "help" | "version" | "--version" | "fsck"
        | "show-branch" | "cherry" | "range-diff" => true,
        "reflog" => matches!(rest_words.first().copied(), None | Some("show")),
        "branch" => {
            has(rest, &["-l", "--list", "--show-current"])
                || (!has(
                    rest,
                    &[
                        "-d",
                        "-D",
                        "--delete",
                        "-m",
                        "-M",
                        "--move",
                        "-c",
                        "-C",
                        "--copy",
                        "-u",
                        "--set-upstream-to",
                        "--unset-upstream",
                        "-f",
                        "--force",
                        "--edit-description",
                    ],
                ) && rest_words.is_empty())
        }
        "tag" => {
            !has(rest, &["-d", "--delete", "-a", "-s", "-f", "--force", "-m"])
                && (rest_words.is_empty() || has(rest, &["-l", "--list"]))
        }
        "remote" => matches!(rest_words.first().copied(), None | Some("show" | "get-url")),
        "stash" => matches!(rest_words.first().copied(), Some("list" | "show")),
        "config" => {
            has(
                rest,
                &[
                    "--get",
                    "--get-all",
                    "--get-regexp",
                    "--list",
                    "-l",
                    "--get-urlmatch",
                ],
            ) || (rest_words.len() == 1
                && !has(
                    rest,
                    &[
                        "--unset",
                        "--unset-all",
                        "--add",
                        "--replace-all",
                        "-e",
                        "--edit",
                    ],
                ))
        }
        "worktree" => rest_words.first() == Some(&"list"),
        "submodule" => matches!(rest_words.first().copied(), Some("status" | "summary")),
        _ => false,
    };
    read_if(read, WRITES)
}

/// Package managers: listing and searching read; anything else changes software.
fn packages(program: &str, args: &[String]) -> Effect {
    let words = positionals(
        args,
        &["-c", "--config", "-C", "--prefix", "-r", "--registry"],
    );
    let first = words.first().copied();
    let version = has(args, &["--version", "-V", "-v", "--help", "-h"]) && words.is_empty();
    let read = version
        || match program {
            "apt" | "aptitude" => matches!(
                first,
                Some(
                    "list"
                        | "show"
                        | "search"
                        | "policy"
                        | "showpkg"
                        | "depends"
                        | "rdepends"
                        | "madison"
                        | "changelog"
                        | "show-versions"
                        | "help"
                        | "showsrc"
                )
            ),
            "apt-get" => has(
                args,
                &["-s", "--simulate", "--dry-run", "--just-print", "--no-act"],
            ),
            "dpkg" => has(
                args,
                &[
                    "-l",
                    "--list",
                    "-L",
                    "--listfiles",
                    "-s",
                    "--status",
                    "-S",
                    "--search",
                    "-p",
                    "--print-avail",
                    "--get-selections",
                    "--print-architecture",
                    "--audit",
                    "-C",
                    "-c",
                    "--contents",
                    "-I",
                    "--info",
                    "--compare-versions",
                ],
            ),
            "yum" | "dnf" | "microdnf" => matches!(
                first,
                Some(
                    "list"
                        | "info"
                        | "search"
                        | "provides"
                        | "whatprovides"
                        | "repolist"
                        | "repoinfo"
                        | "check-update"
                        | "deplist"
                        | "repoquery"
                        | "history"
                        | "updateinfo"
                        | "help"
                )
            ),
            "rpm" => !args.iter().any(|a| {
                a.starts_with("-i")
                    || a.starts_with("-U")
                    || a.starts_with("-e")
                    || a.starts_with("-F")
                    || matches!(
                        a.as_str(),
                        "--install"
                            | "--upgrade"
                            | "--erase"
                            | "--freshen"
                            | "--import"
                            | "--rebuilddb"
                            | "--initdb"
                            | "--setperms"
                            | "--setugids"
                    )
            }),
            "zypper" => matches!(
                first,
                Some(
                    "search"
                        | "se"
                        | "info"
                        | "if"
                        | "list-updates"
                        | "lu"
                        | "packages"
                        | "pa"
                        | "repos"
                        | "lr"
                        | "patches"
                        | "products"
                        | "pd"
                        | "patterns"
                        | "pt"
                        | "what-provides"
                        | "wp"
                        | "help"
                )
            ),
            "apk" => matches!(
                first,
                Some("info" | "list" | "search" | "policy" | "dot" | "stats" | "version")
            ),
            "pacman" | "yay" | "paru" => args.iter().any(|a| {
                a.starts_with("-Q")
                    || a.starts_with("-Ss")
                    || a.starts_with("-Si")
                    || a.starts_with("-Sl")
                    || a.starts_with("-Sg")
                    || a.starts_with("-F")
            }),
            "snap" => matches!(
                first,
                Some(
                    "list"
                        | "info"
                        | "find"
                        | "version"
                        | "services"
                        | "changes"
                        | "connections"
                        | "interfaces"
                        | "aliases"
                        | "warnings"
                        | "help"
                )
            ),
            "flatpak" => matches!(
                first,
                Some("list" | "info" | "search" | "remotes" | "remote-ls" | "history")
            ),
            "brew" => matches!(
                first,
                Some(
                    "list"
                        | "ls"
                        | "info"
                        | "search"
                        | "outdated"
                        | "deps"
                        | "uses"
                        | "config"
                        | "doctor"
                        | "leaves"
                        | "desc"
                        | "--prefix"
                        | "--cellar"
                )
            ),
            "pip" | "pip3" | "pipx" => matches!(
                first,
                Some(
                    "list"
                        | "show"
                        | "freeze"
                        | "check"
                        | "search"
                        | "index"
                        | "help"
                        | "debug"
                        | "inspect"
                )
            ),
            "npm" | "pnpm" | "yarn" => match first {
                Some(
                    "ls" | "list" | "ll" | "la" | "view" | "info" | "show" | "outdated" | "root"
                    | "prefix" | "bin" | "doctor" | "why" | "explain" | "search" | "help"
                    | "whoami" | "ping",
                ) => true,
                Some("audit") => !words.contains(&"fix"),
                Some("config") => matches!(words.get(1).copied(), Some("get" | "list" | "ls")),
                Some("version") => words.len() == 1,
                _ => false,
            },
            "gem" => matches!(
                first,
                Some(
                    "list"
                        | "info"
                        | "search"
                        | "query"
                        | "environment"
                        | "which"
                        | "contents"
                        | "specification"
                        | "outdated"
                        | "help"
                )
            ),
            "cargo" => matches!(
                first,
                Some(
                    "search"
                        | "tree"
                        | "metadata"
                        | "pkgid"
                        | "locate-project"
                        | "verify-project"
                        | "version"
                        | "help"
                )
            ),
            "go" => match first {
                Some("version" | "list" | "doc" | "help") => true,
                Some("env") => !has(args, &["-w", "-u"]),
                _ => false,
            },
            "composer" => matches!(
                first,
                Some(
                    "show"
                        | "info"
                        | "list"
                        | "outdated"
                        | "depends"
                        | "why"
                        | "prohibits"
                        | "why-not"
                        | "licenses"
                        | "search"
                        | "validate"
                        | "diagnose"
                        | "check-platform-reqs"
                )
            ),
            "helm" => match first {
                Some(
                    "list" | "ls" | "status" | "get" | "history" | "show" | "search" | "template"
                    | "version" | "env" | "lint",
                ) => true,
                Some("repo" | "plugin") => words.get(1) == Some(&"list"),
                _ => false,
            },
            "terraform" | "tofu" => match first {
                Some(
                    "plan" | "show" | "output" | "validate" | "version" | "providers" | "graph",
                ) => true,
                Some("state") => matches!(words.get(1).copied(), Some("list" | "show" | "pull")),
                Some("fmt") => has(args, &["-check"]),
                _ => false,
            },
            _ => false,
        };
    read_if(read, PACKAGES)
}

fn classify(words: &[String]) -> Effect {
    let words = strip_prefix(words);
    let Some(first) = words.first() else {
        return Effect::Read;
    };
    if first.contains(['$', '`']) {
        return Effect::Write(UNKNOWN);
    }
    // A path program must come from a system directory to count as the
    // command of that name (`/tmp/ls` is not `ls`).
    let program = match first.rsplit_once('/') {
        Some((dir, name)) => {
            if matches!(
                dir,
                "/bin" | "/usr/bin" | "/usr/local/bin" | "/sbin" | "/usr/sbin" | "/usr/local/sbin"
            ) {
                name
            } else {
                return Effect::Write(RUNS_CODE);
            }
        }
        None => first.as_str(),
    };
    let args = &words[1..];
    let no_args_or_version = args.is_empty()
        || (args.len() == 1 && has(args, &["--version", "-V", "-v", "version", "--help", "-h"]));

    match program {
        "xargs" => {
            let rest = &args[positionals_start(
                args,
                &[
                    "-n",
                    "-I",
                    "-i",
                    "-L",
                    "-l",
                    "-P",
                    "-d",
                    "-s",
                    "-E",
                    "-e",
                    "-a",
                    "--max-args",
                    "--max-procs",
                    "--delimiter",
                    "--arg-file",
                    "--replace",
                ],
            )..];
            if rest.is_empty() {
                Effect::Read
            } else {
                classify(rest)
            }
        }
        "watch" | "htop" | "btop" | "atop" | "iftop" | "nload" | "iotop" | "glances" | "yes"
        | "nethogs" | "bmon" => Effect::Endless(FOLLOWS),
        "tail" => read_or_follow(args.iter().any(|a| {
            matches!(a.as_str(), "-f" | "-F" | "--follow")
                || a.starts_with("--follow=")
                || (a.starts_with('-') && !a.starts_with("--") && a[1..].contains(['f', 'F']))
        })),
        "top" => read_or_follow(!(short_flag(args, 'b') && short_flag(args, 'n'))),
        "ping" | "ping6" => read_or_follow(!(short_flag(args, 'c') || short_flag(args, 'w'))),
        "vmstat" | "iostat" | "mpstat" | "sar" | "pidstat" | "dstat" => {
            let numbers = args
                .iter()
                .filter(|a| a.chars().all(|c| c.is_ascii_digit()))
                .count();
            read_or_follow(numbers == 1)
        }
        "tcpdump" | "tshark" => {
            if has(args, &["-w"]) {
                Effect::Write(WRITES)
            } else {
                read_or_follow(!short_flag(args, 'c'))
            }
        }
        "journalctl" => {
            if args.iter().any(|a| {
                a.starts_with("--vacuum")
                    || matches!(
                        a.as_str(),
                        "--rotate"
                            | "--flush"
                            | "--sync"
                            | "--relinquish-var"
                            | "--smart-relinquish-var"
                            | "--setup-keys"
                            | "--update-catalog"
                    )
            }) {
                Effect::Write(WRITES)
            } else {
                read_or_follow(has(args, &["-f", "--follow"]) || short_flag(args, 'f'))
            }
        }
        "dmesg" => {
            if has(
                args,
                &[
                    "-c",
                    "-C",
                    "--clear",
                    "--read-clear",
                    "-D",
                    "-E",
                    "--console-off",
                    "--console-on",
                    "-n",
                    "--console-level",
                ],
            ) {
                Effect::Write(WRITES)
            } else {
                read_or_follow(has(args, &["-w", "-W", "--follow", "--follow-new"]))
            }
        }
        "date" => {
            let mut read = true;
            let mut skip = false;
            for arg in args {
                if skip {
                    skip = false;
                } else if matches!(arg.as_str(), "-s" | "--set") || arg.starts_with("--set=") {
                    read = false;
                } else if matches!(
                    arg.as_str(),
                    "-d" | "--date" | "-r" | "--reference" | "-f" | "--file"
                ) {
                    skip = true;
                } else if !arg.starts_with('-') && !arg.starts_with('+') {
                    read = false;
                }
            }
            read_if(read, WRITES)
        }
        "hostname" => read_if(
            args.iter().all(|a| {
                a.starts_with('-') && !matches!(a.as_str(), "-F" | "--file" | "-b" | "--boot")
            }),
            WRITES,
        ),
        "hostnamectl" | "timedatectl" | "localectl" => {
            let words = positionals(args, &["-H", "--host", "-M", "--machine"]);
            read_if(
                matches!(
                    words.first().copied(),
                    None | Some(
                        "status"
                            | "show"
                            | "list-timezones"
                            | "list-locales"
                            | "list-keymaps"
                            | "timesync-status"
                            | "show-timesync"
                            | "list-x11-keymap-models"
                            | "list-x11-keymap-layouts"
                    )
                ),
                SERVICES,
            )
        }
        "systemctl" => {
            let words = positionals(
                args,
                &[
                    "-H",
                    "--host",
                    "-M",
                    "--machine",
                    "-p",
                    "--property",
                    "-t",
                    "--type",
                    "--state",
                    "-n",
                    "--lines",
                    "-o",
                    "--output",
                ],
            );
            read_if(
                matches!(
                    words.first().copied(),
                    None | Some(
                        "status"
                            | "show"
                            | "cat"
                            | "list-units"
                            | "list-unit-files"
                            | "list-timers"
                            | "list-sockets"
                            | "list-jobs"
                            | "list-dependencies"
                            | "list-machines"
                            | "list-paths"
                            | "is-active"
                            | "is-enabled"
                            | "is-failed"
                            | "is-system-running"
                            | "get-default"
                            | "show-environment"
                            | "help"
                    )
                ),
                SERVICES,
            )
        }
        "service" => read_if(
            has(args, &["--status-all"]) || args.last().is_some_and(|a| a == "status"),
            SERVICES,
        ),
        "sysctl" => read_if(
            !has(args, &["-w", "--write", "-p", "--load", "--system"])
                && !args.iter().any(|a| a.contains('=')),
            WRITES,
        ),
        "mount" => read_if(
            positionals(args, &["-t", "--types", "-O", "--test-opts"]).is_empty()
                && !has(args, &["-a", "--all"]),
            WRITES,
        ),
        "swapon" => read_if(
            args.is_empty() || has(args, &["--show", "-s", "--summary"]),
            WRITES,
        ),
        "fdisk" | "sfdisk" | "gdisk" | "parted" => {
            if has(args, &["-l", "--list", "-L"]) || args.iter().any(|a| a == "print") {
                Effect::Read
            } else {
                Effect::Destructive(DESTROYS)
            }
        }
        "ip" => read_if(
            !args.iter().any(|a| {
                matches!(
                    a.as_str(),
                    "add"
                        | "del"
                        | "delete"
                        | "change"
                        | "replace"
                        | "set"
                        | "flush"
                        | "append"
                        | "prepend"
                        | "restore"
                        | "exec"
                        | "-batch"
                        | "-b"
                        | "attach"
                        | "detach"
                        | "save"
                )
            }),
            WRITES,
        ),
        "ifconfig" => read_if(args.len() <= 1, WRITES),
        "route" => read_if(args.iter().all(|a| a.starts_with('-')), WRITES),
        "arp" => read_if(
            !has(args, &["-d", "-s", "-f", "--delete", "--set", "--file"]),
            WRITES,
        ),
        "iptables" | "ip6tables" | "iptables-legacy" | "iptables-nft" | "ip6tables-legacy"
        | "ip6tables-nft" | "ebtables" | "arptables" => read_if(
            !has(
                args,
                &[
                    "-A",
                    "--append",
                    "-I",
                    "--insert",
                    "-D",
                    "--delete",
                    "-R",
                    "--replace",
                    "-F",
                    "--flush",
                    "-X",
                    "--delete-chain",
                    "-P",
                    "--policy",
                    "-N",
                    "--new-chain",
                    "-Z",
                    "--zero",
                    "-E",
                    "--rename-chain",
                ],
            ),
            WRITES,
        ),
        "nft" => read_if(
            positionals(args, &["-f", "--file", "-I", "--includepath"]).first() == Some(&"list"),
            WRITES,
        ),
        "ufw" => read_if(
            matches!(
                positionals(args, &[]).first().copied(),
                Some("status" | "show" | "version" | "app")
            ),
            WRITES,
        ),
        "firewall-cmd" => read_if(
            !args.iter().any(|a| {
                [
                    "--add",
                    "--remove",
                    "--reload",
                    "--complete-reload",
                    "--runtime-to-permanent",
                    "--set-",
                    "--new",
                    "--delete",
                    "--change",
                    "--panic",
                    "--load",
                    "--reset",
                ]
                .iter()
                .any(|p| a.starts_with(p))
            }),
            WRITES,
        ),
        "ethtool" => read_if(
            !has(
                args,
                &[
                    "-s",
                    "--change",
                    "-K",
                    "--features",
                    "--offload",
                    "-G",
                    "--set-ring",
                    "-A",
                    "--pause",
                    "-C",
                    "--coalesce",
                    "-L",
                    "--set-channels",
                    "-E",
                    "--change-eeprom",
                    "-r",
                    "--negotiate",
                    "-f",
                    "--flash",
                    "-W",
                    "--set-dump",
                    "-p",
                    "--identify",
                ],
            ),
            WRITES,
        ),
        "crontab" => read_if(has(args, &["-l"]), WRITES),
        "nginx" | "openresty" => read_if(
            has(args, &["-t", "-T", "-v", "-V", "-h", "-?"])
                || short_flag(args, 't')
                || short_flag(args, 'T'),
            SERVICES,
        ),
        "apachectl" | "apache2ctl" | "httpd" | "apache2" => read_if(
            has(
                args,
                &[
                    "-t",
                    "-S",
                    "-M",
                    "-v",
                    "-V",
                    "-l",
                    "-L",
                    "configtest",
                    "status",
                    "fullstatus",
                    "-D",
                ],
            ),
            SERVICES,
        ),
        "openssl" => read_if(
            !args
                .iter()
                .any(|a| a == "-out" || a == "-keyout" || a.starts_with("-out=")),
            WRITES,
        ),
        "curl" => {
            let mut write = false;
            let mut i = 0;
            while i < args.len() {
                let a = args[i].as_str();
                let method = if a == "-X" || a == "--request" {
                    args.get(i + 1).map(|m| m.to_uppercase())
                } else if let Some(m) = a.strip_prefix("-X").filter(|m| !m.is_empty()) {
                    Some(m.to_uppercase())
                } else {
                    a.strip_prefix("--request=").map(|m| m.to_uppercase())
                };
                if let Some(method) = method {
                    write |= !matches!(method.as_str(), "GET" | "HEAD" | "OPTIONS");
                }
                if a.starts_with("--") {
                    write |= a == "--output"
                        || a.starts_with("--output=")
                        || a.starts_with("--remote-name")
                        || a == "--upload-file"
                        || a.starts_with("--data")
                        || a.starts_with("--form")
                        || a == "--json"
                        || a == "--output-dir"
                        || a == "--create-dirs"
                        || a == "--cookie-jar";
                } else if a.starts_with('-')
                    && !a.starts_with("-X")
                    && !a.starts_with("-H")
                    && !a.starts_with("-A")
                    && !a.starts_with("-u")
                    && !a.starts_with("-b")
                    && !a.starts_with("-e")
                {
                    write |= a[1..].contains(['o', 'O', 'T', 'd', 'F', 'c']);
                }
                i += 1;
            }
            read_if(!write, WRITES)
        }
        "wget" => {
            let mut stdout = has(
                args,
                &["--spider", "-O-", "-qO-", "-qO", "--output-document=-"],
            );
            for pair in args.windows(2) {
                if matches!(pair[0].as_str(), "-O" | "-qO" | "--output-document")
                    && matches!(pair[1].as_str(), "-" | "/dev/null")
                {
                    stdout = true;
                }
            }
            read_if(stdout, WRITES)
        }
        "tar" | "bsdtar" => {
            let mut letters = String::new();
            for (index, arg) in args.iter().enumerate() {
                if let Some(cluster) = arg.strip_prefix('-').filter(|c| !c.starts_with('-')) {
                    letters.push_str(cluster);
                } else if index == 0 && !arg.starts_with('-') {
                    letters.push_str(arg);
                }
            }
            let long_write = has(
                args,
                &[
                    "--extract",
                    "--get",
                    "--create",
                    "--append",
                    "--update",
                    "--delete",
                    "--concatenate",
                ],
            );
            let read = !long_write
                && (has(args, &["--list"])
                    || (letters.contains('t') && !letters.contains(['x', 'c', 'r', 'u', 'A'])));
            read_if(read, WRITES)
        }
        "unzip" => read_if(
            has(args, &["-l", "-v", "-t", "-Z", "-p", "-c", "-z"]),
            WRITES,
        ),
        "gzip" | "gunzip" | "bzip2" | "bunzip2" | "xz" | "unxz" | "zstd" | "unzstd" | "lz4"
        | "pigz" | "lzma" => read_if(
            has(args, &["--stdout", "--to-stdout", "--list", "--test"])
                || args.iter().any(|a| {
                    a.starts_with('-') && !a.starts_with("--") && a[1..].contains(['c', 'l', 't'])
                }),
            WRITES,
        ),
        "find" => {
            let mut effect = Effect::Read;
            let mut i = 0;
            while i < args.len() {
                let a = args[i].as_str();
                if matches!(a, "-delete" | "-fprint" | "-fprint0" | "-fprintf" | "-fls") {
                    effect = effect.max(Effect::Write(WRITES));
                } else if matches!(a, "-exec" | "-execdir" | "-ok" | "-okdir") {
                    let start = i + 1;
                    let mut end = start;
                    while end < args.len() && args[end] != ";" && args[end] != "+" {
                        end += 1;
                    }
                    effect = effect.max(classify(&args[start..end]));
                    i = end;
                }
                i += 1;
            }
            effect
        }
        "sed" => read_if(
            !args.iter().any(|a| {
                a.starts_with("--in-place")
                    || (a.starts_with('-') && !a.starts_with("--") && a[1..].contains('i'))
            }),
            WRITES,
        ),
        "awk" | "gawk" | "mawk" | "nawk" | "busybox-awk" => read_if(
            !has(args, &["-i", "--include"])
                // Output redirection (`print > "file"`), pipes to commands and
                // system() are writes; a bare `>` is usually a comparison.
                && !args.iter().any(|a| {
                    ["system(", "> \"", ">\"", "| \"", "|\"", "| getline", "|&"]
                        .iter()
                        .any(|p| a.contains(p))
                }),
            RUNS_CODE,
        ),
        "tee" => read_if(
            positionals(args, &[])
                .iter()
                .all(|p| matches!(*p, "/dev/null" | "/dev/stdout" | "/dev/stderr")),
            WRITES,
        ),
        "docker" | "podman" | "nerdctl" | "docker-compose" | "podman-compose" => {
            container(program, args)
        }
        "kubectl" | "oc" | "microk8s.kubectl" => kubectl(args),
        "k3s" | "microk8s" if args.first().is_some_and(|a| a == "kubectl") => kubectl(&args[1..]),
        "git" => git(args),
        "apt" | "apt-get" | "aptitude" | "dpkg" | "yum" | "dnf" | "microdnf" | "rpm" | "zypper"
        | "apk" | "pacman" | "yay" | "paru" | "snap" | "flatpak" | "brew" | "pip" | "pip3"
        | "pipx" | "npm" | "pnpm" | "yarn" | "gem" | "cargo" | "go" | "composer" | "helm"
        | "terraform" | "tofu" => packages(program, args),
        "certbot" => read_if(
            matches!(
                positionals(args, &[]).first().copied(),
                Some("certificates" | "plugins")
            ) || has(args, &["--version"]),
            SERVICES,
        ),
        "pm2" => read_if(
            matches!(
                positionals(args, &[]).first().copied(),
                Some(
                    "list"
                        | "ls"
                        | "status"
                        | "show"
                        | "describe"
                        | "info"
                        | "jlist"
                        | "prettylist"
                )
            ),
            SERVICES,
        ),
        "supervisorctl" => read_if(
            matches!(
                positionals(args, &["-c", "--configuration"])
                    .first()
                    .copied(),
                Some("status" | "avail" | "pid" | "version")
            ),
            SERVICES,
        ),
        _ if SHELLS_AND_INTERPRETERS.contains(&program) => {
            if !args.is_empty() && no_args_or_version {
                Effect::Read
            } else {
                Effect::Write(RUNS_CODE)
            }
        }
        _ if DESTRUCTIVE.contains(&program) || program.starts_with("mkfs") => {
            Effect::Destructive(DESTROYS)
        }
        _ if ALWAYS_WRITE.contains(&program) => Effect::Write(WRITES),
        _ if READ_ONLY.contains(&program) => {
            if DUMPS_CONTENT.contains(&program)
                && args.iter().any(|a| {
                    let path = super::permissions::normalize_path(a);
                    path.starts_with("/dev/")
                        && !matches!(
                            path.as_str(),
                            "/dev/null" | "/dev/stdin" | "/dev/stdout" | "/dev/stderr"
                        )
                        && !path.starts_with("/dev/fd/")
                })
            {
                Effect::Endless(DEVICE)
            } else {
                Effect::Read
            }
        }
        _ if no_args_or_version && !args.is_empty() => Effect::Read,
        _ => Effect::Write(UNKNOWN),
    }
}

fn read_or_follow(follows: bool) -> Effect {
    if follows {
        Effect::Endless(FOLLOWS)
    } else {
        Effect::Read
    }
}

/// Index of the first word after `args`' options (and option values).
fn positionals_start(args: &[String], valued: &[&str]) -> usize {
    let mut i = 0;
    while i < args.len() && args[i].starts_with('-') {
        if valued.contains(&args[i].as_str()) {
            i += 1;
        }
        i += 1;
    }
    i.min(args.len())
}

pub fn analyze(command: &str) -> Analysis {
    let Some(lexed) = lex(command) else {
        return Analysis {
            effect: Effect::Write(UNPARSED),
            words: command.split_whitespace().map(str::to_string).collect(),
            globs: Vec::new(),
        };
    };
    let mut effect = Effect::Read;
    if lexed.redirect_targets.iter().any(|target| {
        !matches!(
            target.as_str(),
            "/dev/null" | "/dev/stdout" | "/dev/stderr" | "/dev/tty"
        ) && !target.starts_with("/dev/fd/")
    }) {
        effect = Effect::Write(REDIRECT);
    }
    for segment in &lexed.segments {
        effect = effect.max(classify(segment));
    }
    let mut words: Vec<String> = lexed.segments.into_iter().flatten().collect();
    words.extend(lexed.inputs);
    words.extend(lexed.redirect_targets);
    Analysis {
        effect,
        words,
        globs: lexed.globs,
    }
}
