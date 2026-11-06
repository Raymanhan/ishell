use super::command::{self, Effect};
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Risk {
    pub level: &'static str,
    pub label: &'static str,
    pub reason: String,
}
fn risk(level: &'static str, label: &'static str, reason: &str) -> Risk {
    Risk {
        level,
        label,
        reason: reason.into(),
    }
}

/// Substrings that mark a path or command as touching credentials. The same
/// list is sent to the remote runner so a low-risk `read_file` cannot reach a
/// secret through a symbolic link.
pub const SENSITIVE_PATTERNS: &[&str] = &[
    ".ssh",
    "id_rsa",
    "id_ecdsa",
    "id_ed25519",
    "id_dsa",
    ".env",
    "environ",
    "secret",
    "credential",
    "token",
    "password",
    "htpasswd",
    "shadow",
    "sudoers",
    "private",
    ".pem",
    ".key",
    ".p12",
    ".pfx",
    ".keystore",
    "_history",
    ".netrc",
    ".pgpass",
    ".my.cnf",
    ".aws",
    ".kube",
    ".docker/config",
    ".gnupg",
    ".git-credentials",
];

pub fn sensitive(text: &str) -> bool {
    let text = text.to_lowercase();
    SENSITIVE_PATTERNS.iter().any(|part| text.contains(part))
}

/// Lexically normalize an absolute path (`//etc/./a/../b` -> `/etc/b`) so
/// prefix checks cannot be bypassed with redundant separators or dot segments.
pub(super) fn normalize_path(path: &str) -> String {
    let (prefix, rest) = match path.strip_prefix('~') {
        Some(rest) => ("~", rest),
        None => ("", path),
    };
    let mut parts: Vec<&str> = Vec::new();
    for part in rest.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            part => parts.push(part),
        }
    }
    format!("{prefix}/{}", parts.join("/"))
}

/// A word that names a file and may lead to a credential: a path, a
/// home-relative or dotted name, or an assignment holding one.
fn path_like(word: &str) -> bool {
    word.contains('/') || word.starts_with('~') || word.starts_with('.')
}

/// Automatic mode runs reads and asks for writes. Reads that may send a
/// credential to the model, or never finish, also ask. This is an approval
/// policy, not a sandbox.
pub fn assess(name: &str, args: &Value) -> Risk {
    if name == "run_code" {
        return risk(
            "high",
            "高风险",
            "任意代码可修改系统、访问网络或启动进程，需要检查完整代码",
        );
    }
    if name == "write_file" {
        let path = normalize_path(args["path"].as_str().unwrap_or_default());
        let path = path.as_str();
        if sensitive(path)
            || ["/etc/", "/boot/", "/usr/", "/bin/", "/sbin/", "/lib/"]
                .iter()
                .any(|prefix| path.starts_with(prefix))
        {
            return risk("high", "高风险", "将覆盖系统配置、程序或敏感文件");
        }
        return risk("medium", "中风险", "将创建或完整覆盖远端文件");
    }
    if name == "read_file" {
        let path = normalize_path(args["path"].as_str().unwrap_or_default());
        return if sensitive(&path) {
            risk(
                "high",
                "高风险",
                "文件名可能涉及密钥或秘密，读取内容会发送给模型",
            )
        } else if path.starts_with("/dev/") {
            risk("medium", "中风险", "读取设备文件可能无限输出或泄露磁盘数据")
        } else {
            risk("low", "低风险", "只读操作，不修改服务器")
        };
    }
    if name != "shell" {
        return risk("high", "高风险", "未知工具");
    }
    let analysis = command::analyze(args["command"].as_str().unwrap_or_default());
    match analysis.effect {
        Effect::Destructive(reason) => return risk("high", "高风险", reason),
        Effect::Write(reason) => return risk("medium", "中风险", reason),
        Effect::Endless(reason) => return risk("medium", "中风险", reason),
        Effect::Read => {}
    }
    // Reads are low risk unless they may hand a credential to the model.
    if analysis
        .words
        .iter()
        .any(|word| path_like(word) && sensitive(&normalize_path(word)))
    {
        return risk("high", "高风险", "可能读取密钥或凭证文件，内容会发送给模型");
    }
    // `sh -lc` expands wildcards to names the check above never saw
    // (`cat ~/.ss?/id_*`); only globs over home directories, hidden paths
    // and credential locations ask.
    if analysis.globs.iter().any(|glob| {
        let path = normalize_path(glob);
        glob.contains('$')
            || glob.starts_with('~')
            || glob.starts_with('.')
            || path.contains("/.")
            || [
                "/root",
                "/home",
                "/etc/ssh",
                "/proc",
                "/var/lib/docker/containers",
            ]
            .iter()
            .any(|prefix| path.starts_with(prefix))
    }) {
        return risk(
            "high",
            "高风险",
            "通配符可能匹配到主目录或密钥文件，展开后的实际文件无法确认",
        );
    }
    risk("low", "低风险", "只读操作，不修改服务器")
}

pub fn needs_approval(mode: &str, risk: &Risk) -> bool {
    mode == "ask" || (mode == "auto" && risk.level != "low")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn level(command: &str) -> &'static str {
        assess("shell", &json!({ "command": command })).level
    }

    #[test]
    fn reads_run_automatically() {
        for command in [
            "pwd",
            "ls -la /srv",
            "df -h",
            "free -m && uptime",
            "ps aux | grep nginx | head -20",
            "cat /etc/nginx/nginx.conf",
            "cat /etc/passwd",
            "tail -n 200 /var/log/syslog 2>/dev/null",
            "journalctl -u nginx --since today --no-pager | tail -50",
            "systemctl status nginx",
            "systemctl show nginx",
            "systemctl --user list-units",
            "docker ps -a",
            "docker inspect db",
            "docker logs --tail 50 web",
            "docker compose -f /srv/app/compose.yml ps",
            "docker compose logs --tail 100",
            "docker stats --no-stream",
            "docker system df",
            "kubectl get pods -n prod -o wide",
            "kubectl logs api-0 --tail 100",
            "git -C /srv/app status",
            "git log --oneline -n 5",
            "git branch -a",
            "git config --get remote.origin.url",
            "apt list --installed | grep nginx",
            "dpkg -l | grep openssl",
            "rpm -qa | sort",
            "pip list",
            "npm ls --depth 0",
            "find /var/log -name '*.log' -mtime +7",
            "find /srv -type f -exec grep -l TODO {} \\;",
            "ls /var/log/*.log",
            "du -sh /var/* 2>/dev/null | sort -h",
            "ss -tlnp",
            "ip addr show",
            "iptables -L -n",
            "ufw status verbose",
            "nginx -t",
            "sed -n '1,20p' /etc/hosts",
            "awk '$3 > 100 {print $1}' /var/log/access.log",
            "curl -fsSL https://example.com/health",
            "curl -I http://127.0.0.1:8080",
            "wget -qO- http://127.0.0.1/status",
            "tar -tzf /srv/backup.tgz",
            "crontab -l",
            "date +%F",
            "hostname -I",
            "sudo -n cat /var/log/nginx/error.log | tail -n 50",
            "timeout 5 ping -c 3 1.1.1.1",
            "top -bn1 | head -20",
            "echo hello",
            "for f in /etc/nginx/sites-enabled/x; do cat $f; done",
            "env | sort",
            "python3 --version",
            "openssl x509 -in /etc/ssl/certs/site.crt -noout -dates",
            "if [ -f /etc/os-release ]; then cat /etc/os-release; fi",
            "lsblk && cat /proc/meminfo",
            "command -v docker",
        ] {
            assert_eq!(level(command), "low", "{command}");
        }
    }

    #[test]
    fn writes_ask_first() {
        for command in [
            "rm -rf /srv/a",
            "mkdir -p /srv/app",
            "touch /tmp/x",
            "chmod 600 /srv/app/config",
            "cp a b",
            "mv a b",
            "sudo systemctl restart nginx",
            "systemctl enable --now nginx",
            "service nginx reload",
            "ls; reboot",
            "echo $(reboot)",
            "ls `rm -rf /tmp/x`",
            "echo \"$(rm -rf /tmp/x)\"",
            "date 01010000",
            "hostname newname",
            "python3 script.py",
            "python3 -c 'print(1)'",
            "bash -c 'ls'",
            "./deploy.sh",
            "/tmp/ls",
            "ls | sh",
            "printf x > /etc/config",
            "echo x >> ~/.bashrc",
            "cat a | tee /srv/b",
            "cat > /srv/app.conf <<EOF\nserver {}\nEOF",
            "sed -i 's/a/b/' /etc/hosts",
            "awk '{print > \"out.txt\"}' in.txt",
            "find /tmp -name '*.tmp' -delete",
            "find /tmp -exec rm {} \\;",
            "curl -o /tmp/x https://example.com",
            "curl -X POST https://example.com/api",
            "curl -d a=1 https://example.com/api",
            "wget https://example.com/file.tgz",
            "tar -xzf a.tgz",
            "tar czf backup.tgz /srv",
            "gzip big.log",
            "apt-get install -y nginx",
            "apt update",
            "yum install nginx",
            "pip install requests",
            "npm install",
            "npm run build",
            "docker run -d nginx",
            "docker exec web ls",
            "docker compose up -d",
            "docker compose -f x.yml pull",
            "docker system prune -f",
            "kubectl apply -f deploy.yaml",
            "kubectl delete pod api-0",
            "git pull",
            "git checkout main",
            "git branch new-feature",
            "git config user.name x",
            "crontab -r",
            "kill -9 123",
            "iptables -A INPUT -p tcp --dport 22 -j ACCEPT",
            "ip link set eth0 down",
            "sysctl -w net.ipv4.ip_forward=1",
            "ufw allow 22",
            "nginx -s reload",
            "useradd deploy",
            "mysql -e 'drop database x'",
            "some-unknown-tool --apply",
            "$CMD",
            "vim /etc/hosts",
            "mkfs.ext4 /dev/sdb1",
            "dd if=/dev/zero of=/dev/sdb",
            "echo 'unterminated",
        ] {
            assert_ne!(level(command), "low", "{command}");
        }
        for command in [
            "rm -rf /srv/a",
            "reboot",
            "mkfs.ext4 /dev/sdb1",
            "dd if=/dev/zero of=/dev/sdb",
        ] {
            assert_eq!(level(command), "high", "{command}");
        }
    }

    #[test]
    fn reads_that_may_leak_secrets_or_never_finish_ask_first() {
        for command in [
            "cat /root/.ssh/id_rsa",
            "cat /srv/app/.env",
            "cat /proc/1/environ",
            "cat /root/.bash_history",
            "cat /srv/app/tls.key",
            "cat ~/.ss?/id_*",
            "head /home/a/.ssh*/id_[er]*",
            "cat /root/*",
            "cat < /root/.ssh/id_ed25519",
            "F=~/.ssh/id_rsa; cat $F",
        ] {
            assert_eq!(level(command), "high", "{command}");
        }
        for command in [
            "tail -f /var/log/syslog",
            "tail -qF a.log",
            "docker logs --follow web",
            "docker logs -f web",
            "docker compose logs -f",
            "docker stats",
            "kubectl get pods -w",
            "journalctl -fu nginx",
            "ping 1.1.1.1",
            "top",
            "vmstat 1",
            "watch df -h",
            "cat /dev/sda",
            "head //dev/./zero",
        ] {
            assert_eq!(level(command), "medium", "{command}");
        }
        // Mentioning a secret-sounding word is not reading a credential file.
        assert_eq!(level("grep -i token /var/log/app.log"), "low");
        assert_eq!(level("journalctl -u app | grep password"), "low");
    }

    #[test]
    fn file_tools_follow_the_same_rule() {
        for path in [
            "//etc/nginx/nginx.conf",
            "/srv/../etc/hosts",
            "/./usr/bin/x",
        ] {
            assert_eq!(
                assess("write_file", &json!({"path":path,"content":""})).level,
                "high",
                "{path}"
            );
        }
        assert_eq!(
            assess(
                "write_file",
                &json!({"path":"/srv/app/config","content":"x"})
            )
            .level,
            "medium"
        );
        assert_eq!(
            assess("read_file", &json!({"path":"/var/log/app.log"})).level,
            "low"
        );
        assert_eq!(
            assess("read_file", &json!({"path":"/srv/../root/.ssh/id_rsa"})).level,
            "high"
        );
        assert_eq!(
            assess("read_file", &json!({"path":"/srv/.env"})).level,
            "high"
        );
        assert_eq!(
            assess("read_file", &json!({"path":"/dev/zero"})).level,
            "medium"
        );
        assert_eq!(normalize_path("~/a/../b//c"), "~/b/c");
    }

    #[test]
    fn permission_modes() {
        let read = assess("read_file", &json!({"path":"/var/log/app.log"}));
        let write = assess(
            "write_file",
            &json!({"path":"/srv/app/config","content":"x"}),
        );
        assert!(needs_approval("ask", &read));
        assert!(!needs_approval("auto", &read));
        assert!(needs_approval("auto", &write));
        assert!(!needs_approval("full", &write));
    }
}
