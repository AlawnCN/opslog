use std::collections::HashMap;
use std::borrow::Cow;
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration as StdDuration, Instant};

use chrono::{DateTime, Datelike, Duration, FixedOffset, NaiveDateTime, TimeZone};
use futures_util::stream::{self, StreamExt};
use serde_json::{Map, Value};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::domain::{EnvironmentConfig, LogKind, QueryResult, SearchInput, SearchStatus, SshApplicationConfig, SshAuthentication, SshServerConfig};

const MAX_OUTPUT_BYTES: usize = 64 * 1024 * 1024;
const MAX_PARALLEL_SERVERS: usize = 4;
const TIME_PROFILE_CACHE_DURATION: StdDuration = StdDuration::from_secs(10 * 60);
const TRANSACTION_SUMMARY_SCRIPT: &str = include_str!("../../server/ssh-scripts/transaction_summary.sh");
const SAMPLE_SCRIPT: &str = include_str!("../../server/ssh-scripts/sample.sh");
const CONFIGURED_SCRIPT: &str = include_str!("../../server/ssh-scripts/configured_search.sh");
const JSON_CODEC: &str = include_str!("../../server/ssh-scripts/json_codec.pl");
const TRANSACTION_LIST_SCRIPT: &str = include_str!("../../server/ssh-scripts/transaction_list.sh");
const TIME_PROFILE_SCRIPT: &str = include_str!("../../server/ssh-scripts/time_profile.sh");
const TRANSACTION_CONTENT_SCRIPT: &str = include_str!("../../server/ssh-scripts/transaction_content.sh");
const LOG_SEARCH_SCRIPT: &str = include_str!("../../server/ssh-scripts/log_search.sh");

fn normalized_ssh_script(script: &str) -> Cow<'_, str> {
    if !script.as_bytes().contains(&b'\r') { return Cow::Borrowed(script); }
    Cow::Owned(script.replace("\r\n", "\n").replace('\r', "\n"))
}

#[cfg(test)]
mod line_ending_tests {
    use super::{normalized_ssh_script, parse_transaction_line, TRANSACTION_LIST_SCRIPT};
    use std::borrow::Cow;

    #[test]
    fn windows_checkout_script_is_safe_for_remote_posix_shell() {
        let windows_script = TRANSACTION_LIST_SCRIPT.replace('\n', "\r\n");
        let normalized = normalized_ssh_script(&windows_script);
        assert!(normalized.starts_with("set -eu\n"));
        assert!(!normalized.contains('\r'));
        assert!(matches!(normalized_ssh_script(TRANSACTION_LIST_SCRIPT), Cow::Borrowed(_)));
    }

    #[test]
    fn uat_summary_envelopes_preserve_result_trace_and_source() {
        let trace = "0123456789abcdef0123456789abcdef";
        for prefix in ["", "|"] {
            let line = format!("2026-10-09 12:00:00,123 -> {prefix}TX-123|FT1|KE|cte.u_0_71|transflow|dynamicCall|22|09 12:00:00,101|{trace}|{{\"text\":\"a|b\"}}|SCM60001|key [BSP|batch|default] not found||cte.u_0_71|");
            let row = parse_transaction_line(&line, "uat1", "cte", chrono::FixedOffset::east_opt(10800).unwrap()).unwrap();
            assert_eq!(row["ecp.txn.id"], "TX-123");
            assert_eq!(row["ecp.txn.trace"], trace);
            assert_eq!(row["ecp.txn.message.code"], "SCM60001");
            assert_eq!(row["ecp.txn.message.info"], "key [BSP|batch|default] not found");
            assert_eq!(row["ecp.txn.src.node.id"], "cte.u_0_71");
            assert_eq!(row["ecp.txn.duration"], 22);
        }
    }
}

#[derive(Clone, Debug)]
pub struct SshTimeProfile {
    pub time_zone: String,
    pub offset: String,
    pub source: String,
}

static TIME_PROFILE_CACHE: OnceLock<Mutex<HashMap<String, (Instant, SshTimeProfile)>>> =
    OnceLock::new();

fn configured_servers(environment: &EnvironmentConfig) -> Vec<SshServerConfig> {
    if !environment.ssh_servers.is_empty() { return environment.ssh_servers.clone(); }
    environment.ssh_host.as_ref().filter(|host| !host.trim().is_empty()).map(|host| vec![SshServerConfig { name: host.clone(), host: host.clone(), port: None, username: None, authentication: SshAuthentication::SshConfig, password: None, private_key_path: None, host_key_fingerprint: None }]).unwrap_or_default()
}

fn configured_applications(environment: &EnvironmentConfig) -> Vec<SshApplicationConfig> {
    if !environment.ssh_monitored_applications.is_empty() { return environment.ssh_monitored_applications.clone(); }
    let base = environment.ssh_base_directory.as_deref().unwrap_or("/home/coradm").trim_end_matches('/');
    environment.ssh_applications.iter().map(|name| SshApplicationConfig { name: name.clone(), directory: format!("{base}/{name}"), log_sources: Vec::new(), analysis_notes: Vec::new() }).collect()
}

fn selected_application(
    environment: &EnvironmentConfig,
    requested: Option<&str>,
) -> Result<SshApplicationConfig, String> {
    let applications = configured_applications(environment);
    let application = requested
        .filter(|value| !value.trim().is_empty())
        .or_else(|| applications.first().map(|application| application.name.as_str()))
        .ok_or_else(|| "请选择当前 SSH 环境中已配置的监控应用".to_string())?
        .to_string();
    applications.into_iter().find(|candidate| candidate.name == application)
        .ok_or_else(|| "监控应用不属于当前 SSH 环境".to_string())
}

fn application_root(application: &SshApplicationConfig) -> Result<String, String> {
    let safe = application.directory.starts_with('/')
        && !application.directory.contains("..")
        && application.directory.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '/' | '_' | '.' | '-')
        });
    if !safe {
        return Err("SSH 日志基础目录不合法".to_string());
    }
    Ok(application.directory.trim_end_matches('/').to_string())
}

fn parse_offset(value: &str) -> Result<FixedOffset, String> {
    let sign = if value.starts_with('-') { -1 } else { 1 };
    let parts = value
        .get(1..)
        .unwrap_or_default()
        .split(':')
        .collect::<Vec<_>>();
    if parts.len() != 2 {
        return Err("SSH 日志时区格式不合法".to_string());
    }
    let seconds = sign
        * (parts[0]
            .parse::<i32>()
            .map_err(|_| "SSH 日志时区格式不合法".to_string())?
            * 3600
            + parts[1]
                .parse::<i32>()
                .map_err(|_| "SSH 日志时区格式不合法".to_string())?
                * 60);
    FixedOffset::east_opt(seconds).ok_or_else(|| "SSH 日志时区超出范围".to_string())
}

fn configured_log_offset(environment: &EnvironmentConfig) -> Result<FixedOffset, String> {
    parse_offset(environment.ssh_log_time_offset.as_deref().unwrap_or("+03:00"))
}

fn days_in_range(start: &str, end: &str, offset: FixedOffset) -> Result<String, String> {
    let mut current = DateTime::parse_from_rfc3339(start)
        .map_err(|_| "开始时间格式不合法".to_string())?
        .with_timezone(&offset)
        .date_naive();
    let finish = DateTime::parse_from_rfc3339(end)
        .map_err(|_| "结束时间格式不合法".to_string())?
        .with_timezone(&offset)
        .date_naive();
    let mut days = Vec::new();
    while current <= finish {
        let day = format!("{:02}", current.day());
        if !days.contains(&day) {
            days.push(day);
        }
        current += Duration::days(1);
    }
    Ok(days.join(","))
}

async fn run_script(
    environment: &EnvironmentConfig,
    server: &SshServerConfig,
    script: &str,
    args: &[String],
    timeout_seconds: u64,
) -> Result<String, String> {
    let host = server.host.as_str();
    if host.is_empty()
        || !host.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '@' | '-')
        })
    {
        return Err("SSH 主机配置不合法".to_string());
    }
    let connect_timeout = environment
        .ssh_connect_timeout_seconds
        .unwrap_or(10)
        .clamp(3, 60);
    let host = host.to_string();
    let server = server.clone();
    let args = args
        .iter()
        .map(|value| {
            if value.is_empty() {
                return "-".to_string();
            }
            value
                .as_bytes()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        })
        .collect::<Vec<_>>();
    if matches!(server.authentication, SshAuthentication::Password) {
        return crate::ssh_password_transport::run(server, normalized_ssh_script(script).into_owned(), args, timeout_seconds, connect_timeout).await;
    }
    let mut ssh_args = vec![
        "-o".to_string(), format!("ConnectTimeout={connect_timeout}"),
        "-o".to_string(), "NumberOfPasswordPrompts=1".to_string(),
    ];
    if let Some(port) = server.port { ssh_args.extend(["-p".to_string(), port.to_string()]); }
    if matches!(server.authentication, SshAuthentication::PrivateKey) {
        if let Some(path) = server.private_key_path.as_ref() { ssh_args.extend(["-i".to_string(), path.clone(), "-o".to_string(), "BatchMode=yes".to_string()]); }
    } else if matches!(server.authentication, SshAuthentication::SshConfig) {
        ssh_args.extend(["-o".to_string(), "BatchMode=yes".to_string()]);
    }
    let destination = if matches!(server.authentication, SshAuthentication::SshConfig) || server.username.as_deref().unwrap_or("").is_empty() { host } else { format!("{}@{}", server.username.as_deref().unwrap_or_default(), host) };
    ssh_args.extend([destination, "timeout".to_string(), timeout_seconds.to_string(), "sh".to_string(), "-s".to_string(), "--".to_string()]);
    ssh_args.extend(args);
    let mut command = Command::new("ssh");
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW applies to the SSH child of the GUI app.
    command.kill_on_drop(true);
    let mut child = command.args(ssh_args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("无法启动 SSH：{error}"))?;
    let deadline = StdDuration::from_secs(timeout_seconds.saturating_add(connect_timeout).saturating_add(10));
    let output = tokio::time::timeout(deadline, async {
        let mut stdin = child.stdin.take().ok_or_else(|| "无法写入 SSH 命令".to_string())?;
        stdin.write_all(normalized_ssh_script(script).as_bytes()).await.map_err(|error| format!("无法发送 SSH 查询：{error}"))?;
        drop(stdin);
        child.wait_with_output().await.map_err(|error| format!("SSH 查询失败：{error}"))
    }).await.map_err(|_| format!("SSH 查询超过 {} 秒，已终止本地进程；请检查网络、认证及远端负载", deadline.as_secs()))??;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if message.is_empty() {
            format!("SSH 命令执行失败：{}", output.status)
        } else {
            message
        });
    }
    if output.stdout.len() > MAX_OUTPUT_BYTES {
        return Err("SSH 返回内容超过 64 MB 安全上限，请缩小查询范围".to_string());
    }
    String::from_utf8(output.stdout).map_err(|_| "SSH 返回的日志不是有效 UTF-8 文本".to_string())
}

struct SshServerGroupResult {
    outputs: Vec<(SshServerConfig, String)>,
    warnings: Vec<String>,
}

async fn run_across_servers(
    environment: &EnvironmentConfig,
    script: &str,
    args: &[String],
    timeout_seconds: u64,
) -> Result<SshServerGroupResult, String> {
    let servers = configured_servers(environment);
    if servers.is_empty() { return Err("当前环境未配置 SSH 服务器".to_string()); }
    let mut settled = stream::iter(servers.into_iter().enumerate().map(|(index, server)| async move {
        let result = run_script(environment, &server, script, args, timeout_seconds).await;
        (index, server, result)
    }))
    .buffer_unordered(MAX_PARALLEL_SERVERS)
    .collect::<Vec<_>>()
    .await;
    settled.sort_by_key(|(index, _, _)| *index);
    let mut outputs = Vec::new();
    let mut warnings = Vec::new();
    for (_, server, result) in settled {
        match result {
            Ok(raw) => outputs.push((server, raw)),
            Err(error) => warnings.push(format!("{}：{error}", if server.name.is_empty() { &server.host } else { &server.name })),
        }
    }
    if outputs.is_empty() { return Err(format!("服务器组执行失败：{}", warnings.join("；"))); }
    Ok(SshServerGroupResult { outputs, warnings })
}

pub async fn resolve_time_profile(environment: &EnvironmentConfig) -> SshTimeProfile {
    let servers = configured_servers(environment);
    let cache_key = format!(
        "{:?}\0{}\0{}\0{}",
        servers.iter().map(|server| (&server.host, server.port, &server.username, &server.authentication)).collect::<Vec<_>>(),
        environment.time_zone.as_deref().unwrap_or_default(),
        environment.ssh_log_time_offset.as_deref().unwrap_or_default(),
        environment.ssh_auto_detect_time_zone.unwrap_or(true)
    );
    let cache = TIME_PROFILE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(entries) = cache.lock() {
        if let Some((cached_at, profile)) = entries.get(&cache_key) {
            if cached_at.elapsed() < TIME_PROFILE_CACHE_DURATION {
                return profile.clone();
            }
        }
    }
    if !environment.ssh_auto_detect_time_zone.unwrap_or(true) {
        return SshTimeProfile { time_zone: environment.time_zone.clone().unwrap_or_else(|| "Africa/Nairobi".to_string()), offset: environment.ssh_log_time_offset.clone().unwrap_or_else(|| "+03:00".to_string()), source: "configured".to_string() };
    }
    let detected = run_across_servers(environment, TIME_PROFILE_SCRIPT, &[], 10).await.ok()
        .and_then(|group| group.outputs.into_iter().map(|(_, raw)| raw)
            .find(|raw| parse_offset(raw.lines().nth(1).unwrap_or_default().trim()).is_ok()));
    if let Some(raw) = detected {
        let mut lines = raw.lines();
        let detected_zone = lines.next().unwrap_or_default().trim();
        let detected_offset = lines.next().unwrap_or_default().trim();
        if parse_offset(detected_offset).is_ok() {
            let profile = SshTimeProfile {
                time_zone: if detected_zone.is_empty() {
                    environment.time_zone.clone().unwrap_or_else(|| "Africa/Nairobi".to_string())
                } else {
                    detected_zone.to_string()
                },
                offset: detected_offset.to_string(),
                source: "ssh".to_string(),
            };
            if let Ok(mut entries) = cache.lock() {
                entries.insert(cache_key, (Instant::now(), profile.clone()));
            }
            return profile;
        }
    }
    let profile = SshTimeProfile {
        time_zone: environment.time_zone.clone().unwrap_or_else(|| "Africa/Nairobi".to_string()),
        offset: environment.ssh_log_time_offset.clone().unwrap_or_else(|| "+03:00".to_string()),
        source: if environment.time_zone.is_some() || environment.ssh_log_time_offset.is_some() {
            "configured".to_string()
        } else {
            "default".to_string()
        },
    };
    if let Ok(mut entries) = cache.lock() {
        entries.insert(cache_key, (Instant::now(), profile.clone()));
    }
    profile
}

async fn resolved_log_offset(environment: &EnvironmentConfig) -> Result<FixedOffset, String> {
    let profile = resolve_time_profile(environment).await;
    parse_offset(&profile.offset).or_else(|_| configured_log_offset(environment))
}

fn parse_timestamp(value: &str, offset: FixedOffset) -> Option<DateTime<FixedOffset>> {
    let normalized = value.replace(',', ".");
    let naive = NaiveDateTime::parse_from_str(&normalized, "%Y-%m-%d %H:%M:%S%.3f").ok()?;
    offset.from_local_datetime(&naive).single()
}

fn transaction_fields(body: &str) -> Option<(Vec<&str>, &str, &str, &str)> {
    let mut parts = body.splitn(10, '|');
    let prefix = (0..9).map(|_| parts.next()).collect::<Option<Vec<_>>>()?;
    let remainder = parts.next()?;
    let context_end = if remainder.starts_with('{') {
        let mut depth = 0_i32;
        let mut quoted = false;
        let mut escaped = false;
        let mut end = None;
        for (index, character) in remainder.char_indices() {
            if escaped {
                escaped = false;
                continue;
            }
            if character == '\\' && quoted {
                escaped = true;
                continue;
            }
            if character == '"' {
                quoted = !quoted;
                continue;
            }
            if quoted {
                continue;
            }
            if character == '{' {
                depth += 1;
            }
            if character == '}' {
                depth -= 1;
                if depth == 0 {
                    end = Some(index + character.len_utf8());
                    break;
                }
            }
        }
        end?
    } else {
        remainder.find('|')?
    };
    let tail = remainder.get(context_end..)?.strip_prefix('|')?;
    let (code, message_and_source) = tail.split_once('|')?;
    let (message_with_separator, source) = message_and_source.rsplit_once('|')?;
    let message = message_with_separator
        .strip_suffix('|')
        .unwrap_or(message_with_separator);
    Some((prefix, code, message, source))
}

fn parse_transaction_line(
    line: &str,
    host: &str,
    application: &str,
    offset: FixedOffset,
) -> Option<Map<String, Value>> {
    let (timestamp, body) = line.split_once(" -> ")?;
    let body = body.strip_prefix('|').unwrap_or(body);
    let body = body.strip_suffix('|')?;
    let (parts, code, message, source_node) = transaction_fields(body)?;
    let timestamp = parse_timestamp(timestamp, offset)?.to_rfc3339();
    let mut row = Map::new();
    for (key, value) in [
        ("ecp.txn.timestamp", timestamp),
        ("ecp.txn.id", parts[0].to_string()),
        ("ecp.txn.no", parts[1].to_string()),
        ("ecp.txn.tenant", parts[2].to_string()),
        ("ecp.txn.node", parts[3].to_string()),
        ("ecp.txn.business", parts[4].to_string()),
        ("ecp.txn.service", parts[5].to_string()),
        ("ecp.txn.message.code", code.to_string()),
        ("ecp.txn.message.info", message.to_string()),
        ("ecp.txn.trace", parts[8].to_string()),
        ("ecp.txn.server", host.to_string()),
        ("ecp.txn.src.node.id", source_node.to_string()),
        ("opslog.source.application", application.to_string()),
    ] {
        row.insert(key.to_string(), Value::String(value));
    }
    row.insert(
        "ecp.txn.duration".to_string(),
        Value::from(parts[6].parse::<u64>().unwrap_or(0)),
    );
    Some(row)
}

fn parse_transaction_detail(
    line: &str,
    host: &str,
    application: &str,
    offset: FixedOffset,
) -> Option<Map<String, Value>> {
    let fields = line.split('\t').collect::<Vec<_>>();
    if fields.len() != 6 || fields[0] != "@OPSLOG_DETAIL" || fields[2].is_empty() {
        return None;
    }
    let timestamp = parse_timestamp(fields[1], offset)?.to_rfc3339();
    let mut row = Map::new();
    for (key, value) in [
        ("ecp.txn.timestamp", timestamp),
        ("ecp.txn.id", fields[2].to_string()),
        ("ecp.txn.no", String::new()),
        ("ecp.txn.tenant", String::new()),
        ("ecp.txn.node", String::new()),
        ("ecp.txn.business", fields[3].to_string()),
        ("ecp.txn.service", fields[4].to_string()),
        ("ecp.txn.message.code", String::new()),
        ("ecp.txn.message.info", String::new()),
        ("ecp.txn.trace", String::new()),
        ("ecp.txn.server", host.to_string()),
        ("ecp.txn.src.node.id", String::new()),
        ("opslog.source.application", application.to_string()),
    ] {
        row.insert(key.to_string(), Value::String(value));
    }
    row.insert("ecp.txn.duration".to_string(), Value::from(fields[5].parse::<u64>().unwrap_or(0)));
    row.insert("opslog.ssh.detailSearch".to_string(), Value::Bool(true));
    Some(row)
}

fn contains(row: &Map<String, Value>, key: &str, candidate: Option<&str>) -> bool {
    let Some(candidate) = candidate.filter(|value| !value.trim().is_empty()) else {
        return true;
    };
    row.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_lowercase()
        .contains(&candidate.trim().to_lowercase())
}

fn local_timestamp_boundary(value: &str, offset: FixedOffset) -> Result<String, String> {
    Ok(DateTime::parse_from_rfc3339(value)
        .map_err(|_| "时间格式不合法".to_string())?
        .with_timezone(&offset)
        .format("%Y-%m-%d %H:%M:%S%.3f")
        .to_string())
}

fn matches_transaction(row: &Map<String, Value>, input: &SearchInput) -> bool {
    let Some(timestamp) = row
        .get("ecp.txn.timestamp")
        .and_then(Value::as_str)
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
    else {
        return false;
    };
    let Ok(start) = DateTime::parse_from_rfc3339(&input.start_time) else {
        return false;
    };
    let Ok(end) = DateTime::parse_from_rfc3339(&input.end_time) else {
        return false;
    };
    if timestamp < start || timestamp >= end {
        return false;
    }
    if row.get("opslog.ssh.detailSearch") != Some(&Value::Bool(true)) {
        for (key, candidate) in [
            ("ecp.txn.id", input.txn_id.as_deref()),
            ("ecp.txn.no", input.txn_no.as_deref()),
            ("ecp.txn.business", input.business.as_deref()),
            ("ecp.txn.service", input.service.as_deref()),
            ("ecp.txn.message.code", input.message_code.as_deref()),
            ("ecp.txn.node", input.node.as_deref()),
        ] {
            if !contains(row, key, candidate) {
                return false;
            }
        }
    }
    if input.min_duration_ms.is_some_and(|minimum| {
        row.get("ecp.txn.duration")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            < minimum
    }) {
        return false;
    }
    let code = row
        .get("ecp.txn.message.code")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if code.is_empty() && matches!(input.status, Some(SearchStatus::Success | SearchStatus::Fail)) {
        return false;
    }
    let success = code.ends_with("00000");
    !matches!(input.status, Some(SearchStatus::Success) if !success)
        && !matches!(input.status, Some(SearchStatus::Fail) if success)
}

fn parse_log_record(
    record: &str,
    host: &str,
    offset: FixedOffset,
    year: i32,
    end_year: i32,
    start: &DateTime<FixedOffset>,
    end: &DateTime<FixedOffset>,
) -> Option<Map<String, Value>> {
    let (source, content) = record.split_once('\u{1f}')?;
    let fields = content.trim().split(" §§ ").collect::<Vec<_>>();
    if fields.len() < 11 {
        let bracket = content.find('[')?;
        let close = content[bracket + 1..].find(']')? + bracket + 1;
        let level =
            content[..bracket].trim_end_matches(|character: char| character.is_ascii_digit());
        let short_timestamp = &content[bracket + 1..close];
        let mut timestamp = parse_timestamp(&format!("{year}-{short_timestamp}"), offset)?;
        if end_year != year && (&timestamp < start || &timestamp >= end) {
            timestamp = parse_timestamp(&format!("{end_year}-{short_timestamp}"), offset)?;
        }
        let timestamp = timestamp.to_rfc3339();
        let mut row = Map::new();
        for (key, value) in [
            ("ecp.log.timestamp", timestamp.clone()),
            ("@timestamp", timestamp),
            ("ecp.log.application", source.to_string()),
            ("ecp.log.level", level.to_string()),
            ("ecp.log.file", source.to_string()),
            ("ecp.log.thread", String::new()),
            ("message", content[close + 1..].trim().to_string()),
            ("trace.id", String::new()),
            ("host.name", host.to_string()),
        ] {
            row.insert(key.to_string(), Value::String(value));
        }
        return Some(row);
    }
    let timestamp = parse_timestamp(fields[1].trim(), offset)?.to_rfc3339();
    let mut row = Map::new();
    for (key, value) in [
        ("ecp.log.timestamp", timestamp.clone()),
        ("@timestamp", timestamp),
        ("ecp.log.application", fields[4].trim().to_string()),
        ("ecp.log.level", fields[3].trim().to_string()),
        ("ecp.log.file", source.to_string()),
        ("ecp.log.thread", fields[2].trim().to_string()),
        ("message", fields[10..].join(" §§ ").trim().to_string()),
        ("trace.id", String::new()),
        ("host.name", host.to_string()),
    ] {
        row.insert(key.to_string(), Value::String(value));
    }
    Some(row)
}

async fn search_application_logs(
    environment: &EnvironmentConfig,
    input: &SearchInput,
    export_all: bool,
) -> Result<QueryResult, String> {
    let application = selected_application(environment, input.application.as_deref())?;
    let offset = resolved_log_offset(environment).await?;
    let days = days_in_range(&input.start_time, &input.end_time, offset)?;
    let root = application_root(&application)?;
    let start = DateTime::parse_from_rfc3339(&input.start_time)
        .map_err(|_| "开始时间格式不合法".to_string())?;
    let end = DateTime::parse_from_rfc3339(&input.end_time)
        .map_err(|_| "结束时间格式不合法".to_string())?;
    let limit = if export_all {
        20_000
    } else {
        input.page.saturating_mul(input.page_size).saturating_add(1).min(10_001)
    };
    let args = vec![
        root,
        days,
        local_timestamp_boundary(&input.start_time, offset)?,
        local_timestamp_boundary(&input.end_time, offset)?,
        limit.to_string(),
        input.level.clone().unwrap_or_default(),
        input.keyword.clone().unwrap_or_default(),
        input.file.clone().unwrap_or_default(),
        if export_all { "FULL" } else { "PREVIEW" }.to_string(),
    ];
    let year = start.with_timezone(&offset).year();
    let end_year = end.with_timezone(&offset).year();
    let mut rows = Vec::new();
    let group = run_across_servers(environment, LOG_SEARCH_SCRIPT, &args, 120).await?;
    let mut warnings = group.warnings;
    for (server, raw) in group.outputs {
        warnings.extend(raw.lines().filter_map(|line| line.strip_prefix("@OPSLOG_SCAN_LIMIT\t")).map(str::to_owned));
        rows.extend(raw.split('\u{1e}').filter_map(|record| parse_log_record(record, if server.name.is_empty() { &server.host } else { &server.name }, offset, year, end_year, &start, &end)));
    }
    let mut rows = rows.into_iter()
        .filter(|row| {
            row.get("ecp.log.timestamp")
                .and_then(Value::as_str)
                .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
                .is_some_and(|timestamp| timestamp >= start && timestamp < end)
        })
        .collect::<Vec<_>>();
    rows.sort_by(|left, right| {
        right
            .get("ecp.log.timestamp")
            .and_then(Value::as_str)
            .cmp(&left.get("ecp.log.timestamp").and_then(Value::as_str))
    });
    rows.truncate(limit);
    Ok(QueryResult {
        columns: crate::domain::display_fields(input.kind)
            .iter()
            .map(ToString::to_string)
            .collect(),
        rows,
        warnings,
    })
}

pub async fn sample_logs(environment: &EnvironmentConfig) -> Result<Value, String> {
    let applications = configured_applications(environment);
    if applications.is_empty() || applications.len() > 20 { return Err("请先配置应用目录映射（最多20项）".to_string()); }
    let mut sampled_environment = environment.clone();
    let servers = configured_servers(environment);
    sampled_environment.ssh_servers = servers.iter().take(4).cloned().collect();
    let mut result = Vec::new();
    for application in applications {
        let script = SAMPLE_SCRIPT.replace("# OPSLOG_JSON_CODEC", JSON_CODEC);
        let mut group = run_across_servers(&sampled_environment, &script, &[application_root(&application)?], 25).await?;
        if servers.len() > 4 { group.warnings.push("限量采样仅包含前4台服务器，请确认服务器组日志模板一致".into()); }
        let mut samples = Vec::new();
        for (server, raw) in group.outputs {
            let files = raw.lines().map(serde_json::from_str::<Value>).collect::<Result<Vec<_>, _>>().map_err(|_| "日志采样格式无效")?;
            samples.push(serde_json::json!({"server": if server.name.is_empty() {server.host} else {server.name}, "files": files}));
        }
        result.push(serde_json::json!({"name": application.name, "samples": samples, "warnings": group.warnings}));
    }
    Ok(Value::Array(result))
}

async fn configured_output(environment: &EnvironmentConfig, application: &SshApplicationConfig, start: &str, end: &str, kind: &str, limit: usize, filters: Value) -> Result<(SshServerGroupResult, FixedOffset), String> {
    application.validate_log_sources()?;
    let offset = resolved_log_offset(environment).await?;
    let args = vec![application_root(application)?, days_in_range(start, end, offset)?, local_timestamp_boundary(start, offset)?, local_timestamp_boundary(end, offset)?, limit.to_string(), kind.to_string(), serde_json::to_string(&application.log_sources).map_err(|_| "日志规则无效")?, filters.to_string()];
    let script = CONFIGURED_SCRIPT.replace("# OPSLOG_JSON_CODEC", JSON_CODEC);
    Ok((run_across_servers(environment, &script, &args, 120).await?, offset))
}

fn configured_records(raw: &str) -> Result<Vec<Value>, String> {
    raw.lines().filter_map(|line| line.strip_prefix("@OPSLOG_ROW\t")).map(|line| serde_json::from_str(line).map_err(|_| "声明式日志解析返回无效记录".to_string())).collect()
}

async fn search_configured(environment: &EnvironmentConfig, application: &SshApplicationConfig, input: &SearchInput, export_all: bool) -> Result<QueryResult, String> {
    let limit = if export_all {20_000} else {input.page.saturating_mul(input.page_size).saturating_add(1).min(10_001)};
    let filters = serde_json::to_value(input).map_err(|_| "查询参数无效")?;
    let kind = match input.kind {LogKind::Transaction=>"transaction",LogKind::Application=>"application",LogKind::Ecp=>"ecp",LogKind::Generic=>"generic"};
    let (group, offset) = configured_output(environment, application, &input.start_time, &input.end_time, kind, limit, filters).await?;
    let mut rows = Vec::new(); let mut warnings = group.warnings;
    for (server, raw) in group.outputs {
        let host = if server.name.is_empty() {&server.host} else {&server.name};
        warnings.extend(raw.lines().filter_map(|line| line.strip_prefix("@OPSLOG_SCAN_LIMIT\t")).map(|message|format!("{host}：{message}")));
        for record in configured_records(&raw)? {
            let value = &record["values"];
            let Some(timestamp) = value["timestamp"].as_str().and_then(|stamp| parse_timestamp(stamp, offset)).map(|stamp|stamp.to_rfc3339()) else {continue};
            let mut row = Map::new();
            row.insert("opslog.source.application".to_string(), Value::String(application.name.clone()));
            if input.kind == LogKind::Transaction {
                for (field,key) in [("id","logId"),("no","txnNo"),("business","business"),("service","service"),("node","node"),("tenant","tenant"),("trace","traceId"),("message.code","messageCode"),("message.info","messageInfo")] {
                    row.insert(format!("ecp.txn.{field}"), Value::String(value[key].as_str().unwrap_or_default().to_string()));
                }
                row.insert("ecp.txn.timestamp".to_string(),Value::String(timestamp));
                row.insert("ecp.txn.duration".to_string(),Value::from(value["duration"].as_str().and_then(|v|v.parse::<f64>().ok()).unwrap_or(0.0)));
                row.insert("ecp.txn.server".to_string(),Value::String(host.clone()));
                row.insert("ecp.txn.src.node.id".to_string(),Value::String(value["sourceNode"].as_str().unwrap_or_default().to_string()));
            } else {
                for (field,text) in [("@timestamp",timestamp.clone()),("ecp.log.timestamp",timestamp),("ecp.log.application",application.name.clone()),("ecp.log.file",record["file"].as_str().unwrap_or_default().to_string()),("ecp.log.level",value["level"].as_str().unwrap_or_default().to_string()),("ecp.log.thread",value["thread"].as_str().unwrap_or_default().to_string()),("message",value["message"].as_str().unwrap_or_default().to_string()),("trace.id",value["traceId"].as_str().unwrap_or_default().to_string()),("host.name",host.clone())] {row.insert(field.to_string(),Value::String(text));}
            }
            rows.push(row);
        }
    }
    let timestamp = if input.kind==LogKind::Transaction {"ecp.txn.timestamp"} else {"ecp.log.timestamp"};
    rows.sort_by(|a,b|b.get(timestamp).and_then(Value::as_str).cmp(&a.get(timestamp).and_then(Value::as_str)));
    rows.truncate(limit);
    Ok(QueryResult {columns:crate::domain::display_fields(input.kind).iter().map(ToString::to_string).collect(),rows,warnings})
}

pub async fn search(
    environment: &EnvironmentConfig,
    input: &SearchInput,
    export_all: bool,
) -> Result<QueryResult, String> {
    let configured = selected_application(environment, input.application.as_deref())?;
    if configured.log_sources.iter().any(|source| {
        let role = source["role"].as_str().unwrap_or("");
        match input.kind { LogKind::Transaction => role.starts_with("transaction"), LogKind::Application => role == "application", LogKind::Ecp => role == "ecp", LogKind::Generic => true }
    }) { return search_configured(environment, &configured, input, export_all).await; }
    if input.kind != LogKind::Transaction {
        return search_application_logs(environment, input, export_all).await;
    }
    let application = selected_application(environment, input.application.as_deref())?;
    let offset = resolved_log_offset(environment).await?;
    let days = days_in_range(&input.start_time, &input.end_time, offset)?;
    let root = application_root(&application)?;
    let start_time = local_timestamp_boundary(&input.start_time, offset)?;
    let end_time = local_timestamp_boundary(&input.end_time, offset)?;
    let limit = if export_all {
        20_000
    } else {
        input.page.saturating_mul(input.page_size).saturating_add(1).min(10_001)
    };
    let mut rows = Vec::new();
    let list_args = vec![
        root.clone(), days.clone(), start_time.clone(), end_time.clone(), limit.to_string(),
        input.txn_id.as_deref().unwrap_or_default().trim().to_string(),
        input.txn_no.as_deref().unwrap_or_default().trim().to_string(),
        input.business.as_deref().unwrap_or_default().trim().to_string(),
        input.service.as_deref().unwrap_or_default().trim().to_string(),
        input.node.as_deref().unwrap_or_default().trim().to_string(),
        input.message_code.as_deref().unwrap_or_default().trim().to_string(),
        input.message_info.as_deref().unwrap_or_default().trim().to_string(),
        input.min_duration_ms.map(|value| value.to_string()).unwrap_or_default(),
        match input.status { Some(SearchStatus::Success) => "SUCCESS", Some(SearchStatus::Fail) => "FAIL", _ => "ALL" }.to_string(),
    ];
    let group = run_across_servers(environment, TRANSACTION_LIST_SCRIPT, &list_args, 120).await?;
    let mut warnings = group.warnings;
    let mut fallback_servers = Vec::new();
    for (server, raw) in group.outputs {
        let host = if server.name.is_empty() { &server.host } else { &server.name };
        warnings.extend(raw.lines().filter_map(|line| line.strip_prefix("@OPSLOG_SCAN_LIMIT\t"))
            .map(|message| format!("{}：{message}", host)));
        let list_rows = raw.lines().filter_map(|line| parse_transaction_line(line, host, &application.name, offset)).collect::<Vec<_>>();
        if list_rows.is_empty() {
            fallback_servers.push(server);
        } else {
            rows.extend(list_rows);
        }
    }
    let filters = [
        input.txn_id.as_deref(), input.txn_no.as_deref(), input.business.as_deref(),
        input.service.as_deref(), input.node.as_deref(), input.message_code.as_deref(),
        input.message_info.as_deref(),
    ];
    let mut fallback_args = vec![root.clone(), days.clone()];
    fallback_args.extend(filters.map(|value| value.unwrap_or_default().trim().to_string()));
    fallback_args.extend([
        start_time, end_time, limit.to_string(),
        input.min_duration_ms.map(|value| value.to_string()).unwrap_or_default(),
    ]);
    let mut fallback_results = stream::iter(fallback_servers.into_iter().enumerate().map(|(index, server)| {
        let args = &fallback_args;
        async move {
            let summary = run_script(environment, &server, TRANSACTION_SUMMARY_SCRIPT, args, 120).await;
            let result = match summary {
                Ok(raw) if raw.lines().next().and_then(|line| line.strip_prefix("@OPSLOG_SUMMARY_PARSED\t"))
                    .and_then(|count| count.parse::<usize>().ok()).is_some_and(|count| count > 0) => Ok(raw),
                Ok(_) => Err("未找到可解析的交易汇总日志；为避免全量扫描，已停止明细兜底查询".to_string()),
                Err(error) => Err(error),
            };
            (index, server, result)
        }
    }))
    .buffer_unordered(MAX_PARALLEL_SERVERS)
    .collect::<Vec<_>>()
    .await;
    fallback_results.sort_by_key(|(index, _, _)| *index);
    for (_, server, result) in fallback_results {
        let host = if server.name.is_empty() { &server.host } else { &server.name };
        match result {
            Ok(detail) => {
                warnings.extend(detail.lines().filter_map(|line| line.strip_prefix("@OPSLOG_SCAN_LIMIT\t"))
                    .map(|message| format!("{}：{message}", host)));
                rows.extend(detail.lines().filter_map(|line| parse_transaction_detail(line, host, &application.name, offset)));
            }
            Err(error) => warnings.push(format!("{}：交易汇总查询失败：{error}", host)),
        }
    }
    let mut rows = rows.into_iter()
        .filter(|row| matches_transaction(row, input))
        .collect::<Vec<_>>();
    rows.sort_by(|left, right| {
        right
            .get("ecp.txn.timestamp")
            .and_then(Value::as_str)
            .cmp(&left.get("ecp.txn.timestamp").and_then(Value::as_str))
    });
    rows.truncate(limit);
    Ok(QueryResult {
        columns: crate::domain::display_fields(LogKind::Transaction)
            .iter()
            .map(ToString::to_string)
            .collect(),
        rows,
        warnings,
    })
}

pub async fn read_transaction(
    environment: &EnvironmentConfig,
    id: &str,
    start: &str,
    end: &str,
    requested_application: Option<&str>,
) -> Result<String, String> {
    if id.is_empty()
        || !id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
    {
        return Err("日志 ID 包含不允许的字符".to_string());
    }
    let application = selected_application(environment, requested_application)?;
    // Only the exact ID-named TRC is a transaction detail resource.
    let offset = resolved_log_offset(environment).await?;
    let days = days_in_range(start, end, offset)?;
    let root = application_root(&application)?;
    let mut combined = String::new();
    let group = run_across_servers(environment, TRANSACTION_CONTENT_SCRIPT, &[root.clone(), id.to_string(), days.clone()], 300).await?;
    for (server, content) in group.outputs {
        if !content.trim().is_empty() {
            combined.push_str(&format!("\n===== OPSLOG SERVER: {} =====\n{}", if server.name.is_empty() { &server.host } else { &server.name }, content));
        }
    }
    if !group.warnings.is_empty() {
        combined.push_str(&format!("\n===== OPSLOG WARNING: 部分服务器查询失败：{} =====\n", group.warnings.join("；")));
    }
    Ok(combined)
}
