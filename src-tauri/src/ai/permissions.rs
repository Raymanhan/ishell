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

fn sensitive(text: &str) -> bool {
    let text = text.to_lowercase();
    [
        ".ssh",
        "id_rsa",
        "id_ed25519",
        ".env",
        "secret",
        "credential",
        "token",
        "/etc/shadow",
        "/etc/sudoers",
        "/etc/passwd",
    ]
    .iter()
    .any(|part| text.contains(part))
}

/// Conservative classification: arbitrary code and unrecognized shell syntax
/// require approval in automatic mode. This is an approval policy, not a sandbox.
pub fn assess(name: &str, args: &Value) -> Risk {
    if name == "run_code" {
        return risk(
            "high",
            "高风险",
            "任意代码可修改系统、访问网络或启动进程，需要检查完整代码",
        );
    }
    if name == "write_file" {
        let path = args["path"].as_str().unwrap_or_default();
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
        return if sensitive(args["path"].as_str().unwrap_or_default()) {
            risk(
                "high",
                "高风险",
                "文件名可能涉及密钥或秘密，读取内容会发送给模型",
            )
        } else {
            risk("low", "低风险", "读取文本文件，不主动修改服务器")
        };
    }
    if name != "shell" {
        return risk("high", "高风险", "未知工具");
    }
    let command = args["command"].as_str().unwrap_or_default().trim();
    if sensitive(command) {
        return risk("high", "高风险", "命令可能访问身份凭证或敏感配置");
    }
    if command.contains([
        '\n', '\r', ';', '|', '&', '>', '<', '$', '`', '(', ')', '{', '}', '\\', '\'', '"',
    ]) {
        return risk(
            "high",
            "高风险",
            "包含组合命令、重定向、替换或复杂 Shell 语法，无法静态确认影响",
        );
    }
    let words = command.split_whitespace().collect::<Vec<_>>();
    let program = words.first().copied().unwrap_or_default();
    let read_only = match program {
        "pwd" | "whoami" | "id" | "uname" | "uptime" | "df" | "free" | "ps" | "ls" | "cat"
        | "head" | "tail" | "wc" | "stat" | "readlink" | "which" | "date" | "hostname" => {
            // date/hostname can change system state with operands, so only their queries qualify.
            (program != "date" || words.len() == 1 || (words.len() == 2 && words[1] == "-u"))
                && (program != "hostname"
                    || words.len() == 1
                    || (words.len() == 2 && matches!(words[1], "-f" | "-I" | "-i" | "-s")))
        }
        "systemctl" => words.get(1).is_some_and(|arg| {
            matches!(
                *arg,
                "status" | "show" | "list-units" | "list-unit-files" | "is-active" | "is-enabled"
            )
        }),
        "docker" => words.get(1).is_some_and(|arg| {
            matches!(
                *arg,
                "ps" | "images" | "info" | "version" | "inspect" | "stats" | "top" | "logs"
            )
        }),
        _ => false,
    };
    if read_only {
        risk("low", "低风险", "识别为查询或读取命令，不主动修改服务器")
    } else {
        risk(
            "high",
            "高风险",
            "命令可能安装软件、修改资源或影响服务，需检查具体操作",
        )
    }
}

pub fn needs_approval(mode: &str, risk: &Risk) -> bool {
    mode == "ask" || (mode == "auto" && risk.level != "low")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn conservative_shell_classification_catches_execution_and_mutations() {
        for command in [
            "pwd",
            "ls -la /srv",
            "df -h",
            "systemctl status nginx",
            "docker ps",
        ] {
            assert_eq!(
                assess("shell", &json!({"command":command})).level,
                "low",
                "{command}"
            );
        }
        for command in [
            "rm -rf /srv/a",
            "sudo systemctl restart nginx",
            "ls; reboot",
            "echo $(reboot)",
            "cat /root/.ssh/id_rsa",
            "date 01010000",
            "hostname newname",
            "python3 script.py",
            "ls | sh",
            "printf x > /etc/config",
            "systemctl restart nginx",
            "curl https://example.com",
        ] {
            assert_eq!(
                assess("shell", &json!({"command":command})).level,
                "high",
                "{command}"
            );
        }
    }
    #[test]
    fn permissions_enforce_read_only_auto_and_explicit_full_access() {
        let low = assess("read_file", &json!({"path":"/var/log/app.log"}));
        let write = assess(
            "write_file",
            &json!({"path":"/srv/app/config","content":"x"}),
        );
        assert!(needs_approval("ask", &low));
        assert!(!needs_approval("auto", &low));
        assert!(needs_approval("auto", &write));
        assert!(!needs_approval("full", &write));
        assert_eq!(
            assess("read_file", &json!({"path":"/srv/.env"})).level,
            "high"
        );
    }
}
