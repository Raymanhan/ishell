//! Host monitoring: the status snapshot, network counters, the live process
//! ranking, remote log tailing, and the parsers for their output.

use super::*;

/// Collect every status metric in a single remote command to avoid paying a
/// round trip per metric. Sections are delimited by `@@KEY@@` markers.
pub(super) const STATUS_SCRIPT: &str = r#"A="$(uname -srmo 2>/dev/null || uname -a)"
if [ -r /proc/uptime ]; then
  B="$(cat /proc/uptime 2>/dev/null)"
else
  BOOT="$(sysctl -n kern.boottime 2>/dev/null | sed 's/.*sec = \([0-9][0-9]*\).*/\1/')"
  NOW="$(date +%s 2>/dev/null)"
  if [ -n "$BOOT" ] && [ -n "$NOW" ]; then B="$((NOW - BOOT)).00"; else B=""; fi
fi
C="$(cat /proc/loadavg 2>/dev/null || sysctl -n vm.loadavg 2>/dev/null || uptime 2>/dev/null)"
if [ -r /proc/meminfo ]; then
  D="$(awk '/MemTotal|MemAvailable|SwapTotal|SwapFree/{print $1,$2}' /proc/meminfo 2>/dev/null)"
elif command -v vm_stat >/dev/null 2>&1; then
  D="$(TOTAL=$(sysctl -n hw.memsize 2>/dev/null); PAGE=$(vm_stat 2>/dev/null | awk '/page size of/{print $8}' | tr -d '.'); [ -z "$PAGE" ] && PAGE=$(pagesize 2>/dev/null); vm_stat 2>/dev/null | awk -v total="$TOTAL" -v page="$PAGE" '/Pages free/{free=$3} /Pages inactive/{inactive=$3} /Pages speculative/{spec=$3} END {gsub(/\./,"",free); gsub(/\./,"",inactive); gsub(/\./,"",spec); if (total > 0) printf "MemTotal: %d\n", total / 1024; if (page > 0) printf "MemAvailable: %d\n", (free + inactive + spec) * page / 1024}')"
else
  D="$(TOTAL=$(sysctl -n hw.physmem 2>/dev/null || sysctl -n hw.memsize 2>/dev/null); AVAIL=$(sysctl -n hw.usermem 2>/dev/null); [ -n "$TOTAL" ] && printf 'MemTotal: %s\n' $((TOTAL / 1024)); [ -n "$AVAIL" ] && printf 'MemAvailable: %s\n' $((AVAIL / 1024)))"
fi
E="$(awk 'NR==1{print $2,$3,$4,$5,$6,$7,$8,$9}' /proc/stat 2>/dev/null; sleep 0.2; awk 'NR==1{print $2,$3,$4,$5,$6,$7,$8,$9}' /proc/stat 2>/dev/null)"
F="$(ps -axo pid= 2>/dev/null | awk 'NF{count++} END{print count+0}')"
G="$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null)"
GPU_DATA="$(if command -v nvidia-smi >/dev/null 2>&1; then nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null; fi)"
H="$(printf '%s\n' "$GPU_DATA" | awk -F, '{value=$1; gsub(/[[:space:]]/, "", value); if (value ~ /^[0-9]+([.][0-9]+)?$/ && value > max) max=value} BEGIN{max=-1} END{if (max >= 0) printf "%.2f\n", max}')"
if [ -z "$H" ]; then
  H="$(for BUSY in /sys/class/drm/card*/device/gpu_busy_percent; do [ -r "$BUSY" ] && cat "$BUSY"; done 2>/dev/null | awk 'BEGIN{max=-1} $1 ~ /^[0-9]+([.][0-9]+)?$/ {if ($1 > max) max=$1} END{if (max >= 0) printf "%.2f\n", max}')"
fi
I="$(printf '%s\n' "$GPU_DATA" | awk -F, '{used=$2; total=$3; gsub(/[[:space:]]/, "", used); gsub(/[[:space:]]/, "", total); if (used ~ /^[0-9]+([.][0-9]+)?$/ && total ~ /^[0-9]+([.][0-9]+)?$/) {used_sum+=used; total_sum+=total; seen=1}} END{if (seen && total_sum > 0) printf "%.0f %.0f\n", used_sum, total_sum}')"
if [ -z "$I" ]; then
  I="$(for CARD in /sys/class/drm/card*; do
    NAME="${CARD##*/}"
    case "${NAME#card}" in ""|*[!0-9]*) continue ;; esac
    DEVICE="$CARD/device"
    [ -r "$DEVICE/mem_info_vram_used" ] && [ -r "$DEVICE/mem_info_vram_total" ] || continue
    printf '%s %s\n' "$(cat "$DEVICE/mem_info_vram_used" 2>/dev/null)" "$(cat "$DEVICE/mem_info_vram_total" 2>/dev/null)"
  done 2>/dev/null | awk '$1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ {used+=$1/1048576; total+=$2/1048576; seen=1} END{if (seen && total > 0) printf "%.0f %.0f\n", used, total}')"
fi
printf '@@OS@@\n%s\n@@UP@@\n%s\n@@LOAD@@\n%s\n@@MEM@@\n%s\n@@CPU@@\n%s\n@@PROC@@\n%s\n@@CORES@@\n%s\n@@GPU@@\n%s\n@@VRAM@@\n%s\n' \
  "$A" "$B" "$C" "$D" "$E" "$F" "$G" "$H" "$I""#;

pub(super) const PROCESS_TOP_SCRIPT: &str = r#"if top -b -n 1 >/dev/null 2>&1; then
  export LC_ALL=C LINES=512 COLUMNS=512
  exec top -b -d 1
elif top -l 1 -stats pid,command,cpu,mem >/dev/null 2>&1; then
  export LC_ALL=C
  exec top -l 1000000 -s 1 -n 512 -o cpu -stats pid,command,cpu,mem
else
  printf 'top batch mode is unavailable\n' >&2
  exit 127
fi"#;

pub(super) const DISK_SCRIPT: &str = "df -Pk 2>/dev/null | tail -n +2";

pub(super) const NETWORK_SCRIPT: &str = r#"if [ -d /sys/class/net ]; then
  NET_BYTES="$(
    for iface in /sys/class/net/*; do
      name=${iface##*/}
      [ "$name" = "lo" ] && continue
      [ -r "$iface/statistics/rx_bytes" ] && [ -r "$iface/statistics/tx_bytes" ] || continue
      printf '%s %s\n' "$(cat "$iface/statistics/rx_bytes" 2>/dev/null)" "$(cat "$iface/statistics/tx_bytes" 2>/dev/null)"
    done | awk '{rx += $1; tx += $2; seen = 1} END {if (seen) printf "%s %s\n", rx+0, tx+0}'
  )"
  if [ -n "$NET_BYTES" ]; then
    printf '%s\n' "$NET_BYTES"
    exit 0
  fi
fi
if [ -r /proc/net/dev ]; then
  awk 'NR>2 {iface=$1; sub(/:/, "", iface); if (iface != "lo") {rx += $2; tx += $10}} END {printf "%s %s\n", rx+0, tx+0}' /proc/net/dev 2>/dev/null
else
  netstat -ibn 2>/dev/null | awk 'NR>1 && $1 !~ /^lo/ {rx += $7; tx += $10} END {printf "%s %s\n", rx+0, tx+0}'
fi"#;

pub fn fetch_status(
    _pool: &SshPool,
    app: &AppHandle,
    id: &str,
    include_disk: bool,
) -> Result<ServerStatus, String> {
    let raw = run_remote_shell(app, id, STATUS_SCRIPT)?;
    let sections = split_sections(&raw);
    let section = |key: &str| sections.get(key).map(String::as_str).unwrap_or("");

    let (load1, load5, load15) = parse_load(section("LOAD"));
    let cpu_cores = parse_cpu_cores(section("CORES"));
    let cpu_percent = parse_cpu_percent(section("CPU"))
        .unwrap_or_else(|| cpu_percent_from_load(load1, cpu_cores));
    let gpu_percent = parse_gpu_percent(section("GPU"));
    let (gpu_memory_used_mb, gpu_memory_total_mb) = parse_gpu_memory(section("VRAM"));
    let (memory_total_mb, memory_available_mb, swap_total_mb, swap_free_mb) =
        parse_memory(section("MEM"));
    let disk_mounts = if include_disk {
        let raw_disk = run_remote_shell(app, id, DISK_SCRIPT)?;
        parse_disk_mounts(&raw_disk)
    } else {
        Vec::new()
    };
    let root_disk = disk_mounts
        .iter()
        .find(|mount| mount.mount_point == "/")
        .or_else(|| disk_mounts.first());
    let processes = section("PROC").trim().parse::<u64>().ok();
    Ok(ServerStatus {
        id: id.to_string(),
        os: section("OS").trim().to_string(),
        uptime_seconds: parse_uptime(section("UP")),
        load1,
        load5,
        load15,
        cpu_cores,
        cpu_percent,
        gpu_percent,
        gpu_memory_used_mb,
        gpu_memory_total_mb,
        memory_total_mb,
        memory_available_mb,
        swap_total_mb,
        swap_free_mb,
        disk_used_percent: root_disk.map(|mount| mount.used_percent),
        disk_used_gb: root_disk.map(|mount| mount.used_gb),
        disk_total_gb: root_disk.map(|mount| mount.total_gb),
        disk_mounts,
        processes,
        sampled_at: now(),
    })
}

pub fn stream_process_usage(
    app: &AppHandle,
    id: &str,
    is_canceled: impl Fn() -> bool,
    mut on_sample: impl FnMut(Vec<ProcessUsage>, Vec<ProcessUsage>),
) -> Result<(), String> {
    let remote_command = format!("sh -lc {}", openssh::shell_quote(PROCESS_TOP_SCRIPT));
    let mut parser = TopStreamParser::default();

    #[cfg(not(russh_backend))]
    {
        let (mut child, helper_path) = spawn_remote(app, id, &remote_command, false, true, true)?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "无法读取进程监控输出".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "无法读取进程监控错误输出".to_string())?;

        let (line_sender, line_receiver) = std::sync::mpsc::channel::<Vec<u8>>();
        let stdout_reader = std::thread::spawn(move || -> io::Result<()> {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = Vec::new();
                let size = reader.read_until(b'\n', &mut line)?;
                if size == 0 || line_sender.send(line).is_err() {
                    return Ok(());
                }
            }
        });
        let stderr_reader = std::thread::spawn(move || -> io::Result<Vec<u8>> {
            let mut stderr = stderr;
            let mut output = Vec::new();
            stderr.read_to_end(&mut output)?;
            Ok(output)
        });

        let mut canceled = false;
        loop {
            if is_canceled() {
                canceled = true;
                let _ = child.kill();
                break;
            }
            match line_receiver.recv_timeout(Duration::from_millis(250)) {
                Ok(line) => {
                    for (top_cpu, top_memory) in parser.push(&line) {
                        on_sample(top_cpu, top_memory);
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if child
                        .try_wait()
                        .map_err(|err| format!("检查进程监控状态失败：{err}"))?
                        .is_some()
                    {
                        break;
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }

        let status = child
            .wait()
            .map_err(|err| format!("等待进程监控结束失败：{err}"));
        cleanup_askpass_helper(helper_path.as_ref());
        let stdout_result = stdout_reader
            .join()
            .map_err(|_| "进程监控输出线程异常退出".to_string())?;
        let stderr = stderr_reader
            .join()
            .map_err(|_| "进程监控错误输出线程异常退出".to_string())?
            .map_err(|err| format!("读取进程监控错误输出失败：{err}"))?;
        if canceled {
            return Ok(());
        }
        stdout_result.map_err(|err| format!("读取进程监控输出失败：{err}"))?;
        if let Some((top_cpu, top_memory)) = parser.finish() {
            on_sample(top_cpu, top_memory);
        }
        let status = status?;
        if !status.success() {
            return Err(format_process_error("进程监控失败", &stderr));
        }
        Ok(())
    }

    #[cfg(russh_backend)]
    {
        let server = get_server(app, id)?;
        let secret = read_secret(app, id).ok().filter(|value| !value.is_empty());
        let result = crate::russh_transport::stream_command(
            &server,
            secret.as_deref(),
            &remote_command,
            &is_canceled,
            &mut |chunk| {
                for (top_cpu, top_memory) in parser.push(chunk) {
                    on_sample(top_cpu, top_memory);
                }
            },
        )
        .map_err(|err| format!("SSH 进程监控失败：{err}"));
        if !is_canceled() {
            if let Some((top_cpu, top_memory)) = parser.finish() {
                on_sample(top_cpu, top_memory);
            }
        }
        result
    }
}

/// Follow a remote regular file without loading it into memory. This is kept
/// separate from terminal sessions so a viewer window can be closed without
/// affecting the interactive shell that opened it.
pub fn stream_tail_file(
    app: &AppHandle,
    id: &str,
    path: &str,
    initial_lines: u32,
    is_canceled: impl Fn() -> bool,
    mut on_ready: impl FnMut(),
    mut on_data: impl FnMut(&[u8]),
) -> Result<(), String> {
    let remote_command = tail_remote_command(path, initial_lines);

    #[cfg(not(russh_backend))]
    {
        let (mut child, helper_path) = spawn_remote(app, id, &remote_command, false, true, true)?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "无法读取滚动查看输出".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "无法读取滚动查看错误输出".to_string())?;

        let (chunk_sender, chunk_receiver) = std::sync::mpsc::channel::<Vec<u8>>();
        let stdout_reader = std::thread::spawn(move || -> io::Result<()> {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut chunk = vec![0_u8; 16 * 1024];
                let size = reader.read(&mut chunk)?;
                if size == 0 {
                    return Ok(());
                }
                chunk.truncate(size);
                if chunk_sender.send(chunk).is_err() {
                    return Ok(());
                }
            }
        });
        let stderr_reader = std::thread::spawn(move || -> io::Result<Vec<u8>> {
            let mut stderr = stderr;
            let mut output = Vec::new();
            stderr.read_to_end(&mut output)?;
            Ok(output)
        });

        on_ready();
        let mut canceled = false;
        loop {
            if is_canceled() {
                canceled = true;
                let _ = child.kill();
                break;
            }
            match chunk_receiver.recv_timeout(Duration::from_millis(250)) {
                Ok(chunk) => on_data(&chunk),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if child
                        .try_wait()
                        .map_err(|err| format!("检查滚动查看状态失败：{err}"))?
                        .is_some()
                    {
                        break;
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }

        let status = child
            .wait()
            .map_err(|err| format!("等待滚动查看命令结束失败：{err}"));
        cleanup_askpass_helper(helper_path.as_ref());
        let stdout_result = stdout_reader
            .join()
            .map_err(|_| "滚动查看输出线程异常退出".to_string())?;
        let stderr = stderr_reader
            .join()
            .map_err(|_| "滚动查看错误线程异常退出".to_string())?
            .map_err(|err| format!("读取滚动查看错误输出失败：{err}"))?;
        if canceled {
            return Ok(());
        }
        stdout_result.map_err(|err| format!("读取滚动查看输出失败：{err}"))?;
        let status = status?;
        if !status.success() {
            return Err(format_process_error("滚动查看失败", &stderr));
        }
        Ok(())
    }

    #[cfg(russh_backend)]
    {
        let server = get_server(app, id)?;
        let secret = read_secret(app, id).ok().filter(|value| !value.is_empty());
        on_ready();
        crate::russh_transport::stream_command(
            &server,
            secret.as_deref(),
            &remote_command,
            &is_canceled,
            &mut on_data,
        )
        .map_err(|err| format!("SSH 滚动查看失败：{err}"))
    }
}

pub(super) fn tail_remote_command(path: &str, initial_lines: u32) -> String {
    let lines = initial_lines.clamp(10, 10_000);
    format!("tail -n {lines} -F -- {}", openssh::shell_quote(path))
}

pub fn fetch_network_sample(
    _pool: &SshPool,
    app: &AppHandle,
    id: &str,
) -> Result<NetworkSample, String> {
    let raw = run_remote_shell(app, id, NETWORK_SCRIPT)?;
    let mut parts = raw.split_whitespace();
    let rx_bytes = parts
        .next()
        .and_then(|part| part.parse::<u64>().ok())
        .unwrap_or(0);
    let tx_bytes = parts
        .next()
        .and_then(|part| part.parse::<u64>().ok())
        .unwrap_or(0);

    Ok(NetworkSample {
        rx_bytes,
        tx_bytes,
        sampled_at: now_fractional(),
    })
}

/// Split the combined status output into a map keyed by the `@@KEY@@` markers.
pub(super) fn split_sections(raw: &str) -> std::collections::HashMap<String, String> {
    let mut sections = std::collections::HashMap::new();
    let mut current: Option<String> = None;
    let mut buffer = String::new();

    for line in raw.lines() {
        if let Some(key) = line
            .strip_prefix("@@")
            .and_then(|rest| rest.strip_suffix("@@"))
        {
            if let Some(previous) = current.take() {
                sections.insert(previous, buffer.trim().to_string());
                buffer.clear();
            }
            current = Some(key.to_string());
        } else if current.is_some() {
            buffer.push_str(line);
            buffer.push('\n');
        }
    }
    if let Some(previous) = current.take() {
        sections.insert(previous, buffer.trim().to_string());
    }

    sections
}

pub(super) fn parse_load(raw: &str) -> (f64, f64, f64) {
    let values: Vec<f64> = raw
        .split(|ch: char| ch.is_whitespace() || ch == '{' || ch == '}')
        .filter_map(|part| part.trim_end_matches(',').parse::<f64>().ok())
        .collect();

    (
        values.first().copied().unwrap_or(0.0),
        values.get(1).copied().unwrap_or(0.0),
        values.get(2).copied().unwrap_or(0.0),
    )
}

pub(super) fn parse_uptime(raw: &str) -> Option<u64> {
    raw.split_whitespace()
        .next()
        .and_then(|part| part.parse::<f64>().ok())
        .map(|seconds| seconds as u64)
}

pub(super) fn parse_cpu_cores(raw: &str) -> Option<u64> {
    raw.split_whitespace()
        .find_map(|part| part.parse::<u64>().ok())
        .filter(|cores| *cores > 0)
}

pub(super) fn parse_cpu_percent(raw: &str) -> Option<f64> {
    let samples: Vec<Vec<u64>> = raw
        .lines()
        .map(|line| {
            line.split_whitespace()
                .filter_map(|part| part.parse::<u64>().ok())
                .collect::<Vec<_>>()
        })
        .filter(|values| values.len() >= 4)
        .collect();

    let first = samples.first()?;
    let second = samples.get(1)?;
    let total_a: u64 = first.iter().sum();
    let total_b: u64 = second.iter().sum();
    let idle_a = first.get(3).copied().unwrap_or(0) + first.get(4).copied().unwrap_or(0);
    let idle_b = second.get(3).copied().unwrap_or(0) + second.get(4).copied().unwrap_or(0);
    let total_delta = total_b.checked_sub(total_a)?;
    if total_delta == 0 {
        return None;
    }
    let idle_delta = idle_b.saturating_sub(idle_a);
    let busy_delta = total_delta.saturating_sub(idle_delta);

    Some(((busy_delta as f64 / total_delta as f64) * 100.0).clamp(0.0, 100.0))
}

pub(super) fn cpu_percent_from_load(load1: f64, cpu_cores: Option<u64>) -> f64 {
    let cores = cpu_cores.unwrap_or(4).max(1) as f64;
    ((load1 / cores) * 100.0).clamp(0.0, 100.0)
}

pub(super) fn parse_gpu_percent(raw: &str) -> Option<f64> {
    raw.split_whitespace()
        .find_map(|part| part.parse::<f64>().ok())
        .map(|value| value.clamp(0.0, 100.0))
}

pub(super) fn parse_gpu_memory(raw: &str) -> (Option<u64>, Option<u64>) {
    let mut values = raw
        .split_whitespace()
        .filter_map(|part| part.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value >= 0.0);
    let Some(used_mb) = values.next() else {
        return (None, None);
    };
    let Some(total_mb) = values.next().filter(|value| *value > 0.0) else {
        return (None, None);
    };
    let total_mb = total_mb.round().min(u64::MAX as f64) as u64;
    let used_mb = used_mb.min(total_mb as f64).round().min(u64::MAX as f64) as u64;
    (Some(used_mb), Some(total_mb))
}

pub(super) type ProcessRankings = (Vec<ProcessUsage>, Vec<ProcessUsage>);

#[derive(Clone, Copy)]
pub(super) struct TopColumns {
    count: usize,
    pid: usize,
    cpu: usize,
    memory: usize,
    command: usize,
}

#[derive(Default)]
pub(super) struct TopStreamParser {
    pending: Vec<u8>,
    columns: Option<TopColumns>,
    current: Vec<ProcessUsage>,
    completed_frames: usize,
}

impl TopStreamParser {
    fn push(&mut self, chunk: &[u8]) -> Vec<ProcessRankings> {
        self.pending.extend_from_slice(chunk);
        let mut rankings = Vec::new();
        while let Some(newline) = self.pending.iter().position(|byte| *byte == b'\n') {
            let line = self.pending.drain(..=newline).collect::<Vec<_>>();
            if let Some(sample) = self.push_line(&String::from_utf8_lossy(&line)) {
                rankings.push(sample);
            }
        }
        rankings
    }

    fn finish(&mut self) -> Option<ProcessRankings> {
        if !self.pending.is_empty() {
            let pending = std::mem::take(&mut self.pending);
            if let Some(sample) = self.push_line(&String::from_utf8_lossy(&pending)) {
                return Some(sample);
            }
        }
        self.finish_frame()
    }

    fn push_line(&mut self, line: &str) -> Option<ProcessRankings> {
        if let Some(columns) = parse_top_columns(line) {
            let completed = self.finish_frame();
            self.columns = Some(columns);
            return completed;
        }

        let columns = self.columns?;
        let parts = line.split_whitespace().collect::<Vec<_>>();
        if parts.len() < columns.count {
            return None;
        }
        let resolve_index = |index: usize| {
            if columns.command < index {
                parts.len().checked_sub(columns.count - index)
            } else {
                Some(index)
            }
        };
        let pid_index = resolve_index(columns.pid)?;
        let cpu_index = resolve_index(columns.cpu)?;
        let memory_index = resolve_index(columns.memory)?;
        let pid = parts.get(pid_index)?.parse::<u64>().ok()?;
        let cpu_percent = parse_top_cpu(parts.get(cpu_index)?)?;
        let memory_bytes = parse_top_memory(parts.get(memory_index)?)?;
        let command_end = [pid_index, cpu_index, memory_index]
            .into_iter()
            .filter(|index| *index > columns.command)
            .min()
            .unwrap_or(parts.len());
        let name = parts.get(columns.command..command_end)?.join(" ");
        if name.is_empty() || is_monitor_process(&name) {
            return None;
        }
        self.current.push(ProcessUsage {
            pid,
            name,
            cpu_percent,
            memory_bytes,
        });
        None
    }

    fn finish_frame(&mut self) -> Option<ProcessRankings> {
        if self.current.is_empty() {
            return None;
        }
        self.completed_frames += 1;
        let processes = std::mem::take(&mut self.current);
        if self.completed_frames == 1 {
            return None;
        }

        let mut top_cpu = processes.clone();
        top_cpu.sort_by(|left, right| {
            right
                .cpu_percent
                .total_cmp(&left.cpu_percent)
                .then_with(|| left.pid.cmp(&right.pid))
        });
        top_cpu.truncate(5);

        let mut top_memory = processes;
        top_memory.sort_by(|left, right| {
            right
                .memory_bytes
                .cmp(&left.memory_bytes)
                .then_with(|| left.pid.cmp(&right.pid))
        });
        top_memory.truncate(5);
        Some((top_cpu, top_memory))
    }
}

pub(super) fn parse_top_columns(line: &str) -> Option<TopColumns> {
    let columns = line.split_whitespace().collect::<Vec<_>>();
    let pid = columns
        .iter()
        .position(|column| column.eq_ignore_ascii_case("PID"))?;
    let cpu = columns
        .iter()
        .position(|column| column.trim_matches('%').eq_ignore_ascii_case("CPU"))?;
    let memory = columns
        .iter()
        .position(|column| column.eq_ignore_ascii_case("RES") || column.eq_ignore_ascii_case("RSS"))
        .or_else(|| {
            columns
                .iter()
                .position(|column| column.eq_ignore_ascii_case("MEM"))
        })?;
    let command = columns.iter().position(|column| {
        column.eq_ignore_ascii_case("COMMAND")
            || column.eq_ignore_ascii_case("COMMAND+")
            || column.eq_ignore_ascii_case("CMD")
    })?;
    Some(TopColumns {
        count: columns.len(),
        pid,
        cpu,
        memory,
        command,
    })
}

pub(super) fn parse_top_cpu(raw: &str) -> Option<f64> {
    raw.trim_end_matches('%')
        .parse::<f64>()
        .ok()
        .map(|value| value.max(0.0))
}

pub(super) fn parse_top_memory(raw: &str) -> Option<u64> {
    let cleaned = raw.trim().trim_end_matches(['+', '-', '<', '>']);
    if cleaned.is_empty() {
        return None;
    }
    let (number, multiplier) = match cleaned.as_bytes().last()?.to_ascii_lowercase() {
        b'k' => (&cleaned[..cleaned.len() - 1], 1024_f64),
        b'm' => (&cleaned[..cleaned.len() - 1], 1024_f64.powi(2)),
        b'g' => (&cleaned[..cleaned.len() - 1], 1024_f64.powi(3)),
        b't' => (&cleaned[..cleaned.len() - 1], 1024_f64.powi(4)),
        _ => (cleaned, 1024_f64),
    };
    let bytes = number.parse::<f64>().ok()? * multiplier;
    if !bytes.is_finite() || bytes < 0.0 {
        return None;
    }
    Some(bytes.min(u64::MAX as f64).round() as u64)
}

pub(super) fn is_monitor_process(name: &str) -> bool {
    let executable = name.rsplit('/').next().unwrap_or(name);
    matches!(
        executable,
        "top" | "ps" | "awk" | "sort" | "head" | "sh" | "bash" | "dash"
    )
}

pub(super) fn parse_memory(raw: &str) -> (Option<u64>, Option<u64>, Option<u64>, Option<u64>) {
    let mut total = None;
    let mut available = None;
    let mut swap_total = None;
    let mut swap_free = None;

    for line in raw.lines() {
        let mut parts = line.split_whitespace();
        let key = parts.next().unwrap_or_default().trim_end_matches(':');
        let value = parts.next().and_then(|part| part.parse::<u64>().ok());

        match key {
            "MemTotal" => total = value.map(|kb| kb / 1024),
            "MemAvailable" => available = value.map(|kb| kb / 1024),
            "SwapTotal" => swap_total = value.map(|kb| kb / 1024),
            "SwapFree" => swap_free = value.map(|kb| kb / 1024),
            _ => {}
        }
    }

    (total, available, swap_total, swap_free)
}

pub(super) fn parse_disk_mounts(raw: &str) -> Vec<DiskMount> {
    raw.lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 6 {
                return None;
            }

            let total_kb = parts.get(1)?.parse::<f64>().ok()?;
            let used_kb = parts.get(2)?.parse::<f64>().ok()?;
            let used_percent = parts.get(4)?.trim_end_matches('%').parse::<f64>().ok()?;

            Some(DiskMount {
                filesystem: parts.first()?.to_string(),
                mount_point: parts[5..].join(" "),
                used_percent,
                used_gb: used_kb / 1024.0 / 1024.0,
                total_gb: total_kb / 1024.0 / 1024.0,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_command_bounds_lines_and_quotes_remote_path() {
        assert_eq!(
            tail_remote_command("/var/log/app's output.log", 200),
            "tail -n 200 -F -- '/var/log/app'\"'\"'s output.log'"
        );
        assert_eq!(
            tail_remote_command("/tmp/a.log", 1),
            "tail -n 10 -F -- '/tmp/a.log'"
        );
        assert_eq!(
            tail_remote_command("/tmp/a.log", 50_000),
            "tail -n 10000 -F -- '/tmp/a.log'"
        );
    }

    #[test]
    fn parses_optional_gpu_utilization() {
        assert_eq!(parse_gpu_percent("37.25\n"), Some(37.25));
        assert_eq!(parse_gpu_percent("135\n"), Some(100.0));
        assert_eq!(parse_gpu_percent(""), None);
    }

    #[test]
    fn parses_optional_gpu_memory_capacity() {
        assert_eq!(parse_gpu_memory("2048 24576\n"), (Some(2048), Some(24576)));
        assert_eq!(
            parse_gpu_memory("30000 24576\n"),
            (Some(24576), Some(24576))
        );
        assert_eq!(parse_gpu_memory(""), (None, None));
        assert_eq!(parse_gpu_memory("0 0\n"), (None, None));
    }

    #[test]
    fn parses_realtime_top_frames_and_discards_the_cumulative_first_frame() {
        let mut parser = TopStreamParser::default();
        let first_frame = b"top - 12:00:00 up 1 day\n  PID USER PR NI VIRT RES SHR S %CPU %MEM TIME+ COMMAND\n  21 app 20 0 1g 82944 1m S 99.0 1.0 0:10 node worker\n  7 db 20 0 1g 34816 1m S 88.0 1.0 0:10 postgres\n";
        assert!(parser.push(first_frame).is_empty());

        let second_frame = b"top - 12:00:01 up 1 day\n  PID USER PR NI VIRT RES SHR S %CPU %MEM TIME+ COMMAND\n  90 root 20 0 1g 4096 1m R 70.0 1.0 0:01 top\n  3 app 20 0 1g 20480 1m S 8.0 1.0 0:10 python3\n  21 app 20 0 1g 82944 1m S 44.5 1.0 0:10 node worker\n  4 web 20 0 1g 10240 1m S 7.0 1.0 0:10 nginx\n  5 cache 20 0 1g 8192 1m S 6.0 1.0 0:10 redis-server\n  6 app 20 0 1g 7168 1m S 5.0 1.0 0:10 helper\n  7 db 20 0 1g 131072 1m S 22.0 1.0 0:10 postgres\n";
        assert!(parser.push(&second_frame[..73]).is_empty());
        assert!(parser.push(&second_frame[73..]).is_empty());
        let (top_cpu, top_memory) = parser.finish().expect("second frame should be emitted");

        assert_eq!(top_cpu.len(), 5);
        assert_eq!(top_cpu[0].pid, 21);
        assert_eq!(top_cpu[0].name, "node worker");
        assert_eq!(top_cpu[0].cpu_percent, 44.5);
        assert_eq!(top_cpu[4].name, "redis-server");
        assert_eq!(top_memory[0].pid, 7);
        assert_eq!(top_memory[1].memory_bytes, 84_934_656);
    }

    #[test]
    fn parses_top_memory_units() {
        assert_eq!(parse_top_memory("1024"), Some(1024 * 1024));
        assert_eq!(parse_top_memory("1.5m"), Some(1_572_864));
        assert_eq!(parse_top_memory("2G+"), Some(2 * 1024 * 1024 * 1024));
        assert_eq!(parse_top_memory("512M-"), Some(512 * 1024 * 1024));
    }

    #[test]
    fn parses_macos_top_rows_with_spaced_process_names() {
        let mut parser = TopStreamParser::default();
        let first = b"PID COMMAND %CPU MEM\n203 WindowServer 80.0 800M\n";
        let second = b"PID COMMAND %CPU MEM\n88125 Codex (Renderer) 49.2 503M+\n203 WindowServer 96.9 8522M+\n";
        assert!(parser.push(first).is_empty());
        assert!(parser.push(second).is_empty());
        let (top_cpu, top_memory) = parser.finish().expect("second frame should be emitted");

        assert_eq!(top_cpu[0].name, "WindowServer");
        assert_eq!(top_cpu[1].name, "Codex (Renderer)");
        assert_eq!(top_cpu[1].cpu_percent, 49.2);
        assert_eq!(top_memory[0].memory_bytes, 8_522 * 1024 * 1024);
    }
}
