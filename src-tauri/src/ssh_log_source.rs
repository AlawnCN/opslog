use std::collections::HashMap;
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration as StdDuration, Instant};

use chrono::{DateTime, Datelike, Duration, FixedOffset, NaiveDateTime, TimeZone};
use serde_json::{Map, Value};

use crate::domain::{EnvironmentConfig, LogKind, QueryResult, SearchInput, SearchStatus, SshApplicationConfig, SshAuthentication, SshServerConfig};

const MAX_OUTPUT_BYTES: usize = 64 * 1024 * 1024;
const TIME_PROFILE_CACHE_DURATION: StdDuration = StdDuration::from_secs(10 * 60);
const TRANSACTION_LIST_SCRIPT: &str = r#"set -eu
decode_arg() { if [ "$1" = "-" ]; then return 0; fi; printf '%s' "$1" | perl -pe 's/([0-9a-f]{2})/chr(hex($1))/ge'; }
root=$(decode_arg "$1")
days=$(decode_arg "$2")
prefilter=$(decode_arg "$3")
start_time=$(decode_arg "$4")
end_time=$(decode_arg "$5")
seen=''
emit_file() {
  file=$1
  [ -f "$file" ] || return 0
  case " $seen " in *" $file "*) return 0;; esac
  seen="$seen $file"
  if [ -n "$prefilter" ]; then
    awk -v start="$start_time" -v end="$end_time" 'substr($0, 1, 23) >= start && substr($0, 1, 23) < end' "$file" | grep -iF -- "$prefilter" || true
  else
    awk -v start="$start_time" -v end="$end_time" 'substr($0, 1, 23) >= start && substr($0, 1, 23) < end' "$file"
  fi
}
for file in "$root"/log/txn_*.lst; do emit_file "$file"; done
oldifs=$IFS
IFS=,
for day in $days; do
  for file in "$root"/log/"$day"/txn_*.lst; do emit_file "$file"; done
done
IFS=$oldifs
"#;
const TIME_PROFILE_SCRIPT: &str = r#"set -eu
zone=$(timedatectl show -p Timezone --value 2>/dev/null || true)
[ -n "$zone" ] || zone=$(cat /etc/timezone 2>/dev/null || true)
offset=$(date +%:z)
printf '%s\n%s\n' "$zone" "$offset"
"#;
const TRANSACTION_CONTENT_SCRIPT: &str = r#"set -eu
decode_arg() { if [ "$1" = "-" ]; then return 0; fi; printf '%s' "$1" | perl -pe 's/([0-9a-f]{2})/chr(hex($1))/ge'; }
root=$(decode_arg "$1")
log_id=$(decode_arg "$2")
days=$(decode_arg "$3")
base=$(printf '%s' "$log_id" | sed -E 's/-[0-9]+$//')
found=0
oldifs=$IFS
IFS=,
for day in $days; do
  directory="$root/trc/$day"
  [ -d "$directory" ] || continue
  for file in "$directory/$base.trc" "$directory/$base"-[0-9]*.trc; do
    [ -f "$file" ] || continue
    found=1
    printf '\n===== OPSLOG SOURCE: %s =====\n' "$(basename "$file")"
    cat -- "$file"
    printf '\n'
  done
done
IFS=$oldifs
if [ "$found" -eq 0 ]; then
  aggregate_found=0
  aggregate_seen=''
  emit_aggregate() {
    file=$1
    [ -f "$file" ] || return 0
    case " $aggregate_seen " in *" $file "*) return 0;; esac
    aggregate_seen="$aggregate_seen $file"
    if grep -q -F " §§ $base" "$file"; then
      if [ "$aggregate_found" -eq 0 ]; then
        printf '\n===== OPSLOG SOURCE: transaction aggregate =====\n'
        aggregate_found=1
      fi
      grep -h -F " §§ $base" "$file"
    fi
  }
  for file in "$root"/log/txntrc_*.trc "$root"/log/txntrc_*.trc.*; do emit_aggregate "$file"; done
  IFS=,
  for day in $days; do
    for file in "$root"/log/"$day"/txntrc_*.trc "$root"/log/"$day"/txntrc_*.trc.* "$root"/trc/"$day"/txntrc_*.trc "$root"/trc/"$day"/txntrc_*.trc.*; do emit_aggregate "$file"; done
  done
  IFS=$oldifs
fi
"#;
const LOG_SEARCH_SCRIPT: &str = r#"set -eu
decode_arg() { if [ "$1" = "-" ]; then return 0; fi; printf '%s' "$1" | perl -pe 's/([0-9a-f]{2})/chr(hex($1))/ge'; }
root=$(decode_arg "$1")
days=$(decode_arg "$2")
level=$(decode_arg "$3")
keyword=$(decode_arg "$4")
file_filter=$(decode_arg "$5")
seen=''
emit_file() {
  file=$1
  [ -f "$file" ] || return 0
  case " $seen " in *" $file "*) return 0;; esac
  seen="$seen $file"
  name=$(basename "$file")
  case "$name" in txn_*.lst|txntrc_*.trc*) return 0;; esac
  if [ -n "$file_filter" ]; then case "$name" in *"$file_filter"*) ;; *) return 0;; esac; fi
  if grep -q "§§ logEnd" "$file"; then
    awk -v source="$name" -v wanted_level="$level" -v wanted_keyword="$keyword" '
      BEGIN { RS=" §§ logEnd[[:space:]]*"; ORS="\036" }
      (wanted_level == "" || index($0, "§§ " wanted_level " §§") > 0) && (wanted_keyword == "" || index(tolower($0), tolower(wanted_keyword)) > 0) { printf "%s\037%s", source, $0 }
    ' "$file"
  else
    awk -v source="$name" -v wanted_level="$level" -v wanted_keyword="$keyword" '
      (wanted_level == "" || index($0, wanted_level) > 0) && (wanted_keyword == "" || index(tolower($0), tolower(wanted_keyword)) > 0) { printf "%s\037%s\036", source, $0 }
    ' "$file"
  fi
}
for file in "$root"/log/*.log "$root"/log/*.log.* "$root"/log/*.log_*; do emit_file "$file"; done
oldifs=$IFS
IFS=,
for day in $days; do
  for file in "$root"/log/"$day"/*.log; do emit_file "$file"; done
done
IFS=$oldifs
"#;

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
    environment.ssh_host.as_ref().filter(|host| !host.trim().is_empty()).map(|host| vec![SshServerConfig { name: host.clone(), host: host.clone(), port: None, username: None, authentication: SshAuthentication::SshConfig, password: None, private_key_path: None }]).unwrap_or_default()
}

fn configured_applications(environment: &EnvironmentConfig) -> Vec<SshApplicationConfig> {
    if !environment.ssh_monitored_applications.is_empty() { return environment.ssh_monitored_applications.clone(); }
    let base = environment.ssh_base_directory.as_deref().unwrap_or("/home/coradm").trim_end_matches('/');
    environment.ssh_applications.iter().map(|name| SshApplicationConfig { name: name.clone(), directory: format!("{base}/{name}") }).collect()
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
    let script = script.to_string();
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
    let output = tokio::task::spawn_blocking(move || {
        let mut ssh_args = vec!["-o".to_string(), format!("ConnectTimeout={connect_timeout}")];
        if let Some(port) = server.port { ssh_args.extend(["-p".to_string(), port.to_string()]); }
        if matches!(server.authentication, SshAuthentication::PrivateKey) {
            if let Some(path) = server.private_key_path.as_ref() { ssh_args.extend(["-i".to_string(), path.clone(), "-o".to_string(), "BatchMode=yes".to_string()]); }
        } else if matches!(server.authentication, SshAuthentication::SshConfig) {
            ssh_args.extend(["-o".to_string(), "BatchMode=yes".to_string()]);
        }
        let destination = if matches!(server.authentication, SshAuthentication::SshConfig) || server.username.as_deref().unwrap_or("").is_empty() { host } else { format!("{}@{}", server.username.as_deref().unwrap_or_default(), host) };
        ssh_args.extend([destination, "timeout".to_string(), timeout_seconds.to_string(), "sh".to_string(), "-s".to_string(), "--".to_string()]);
        ssh_args.extend(args);
        let mut command = if matches!(server.authentication, SshAuthentication::Password) { let mut command = Command::new("sshpass"); command.args(["-e", "ssh"]); command.env("SSHPASS", server.password.as_deref().unwrap_or_default()); command } else { Command::new("ssh") };
        let mut child = command.args(ssh_args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| if matches!(server.authentication, SshAuthentication::Password) && error.kind() == std::io::ErrorKind::NotFound { "密码认证需要本机安装 sshpass；建议改用 SSH Config 或私钥认证".to_string() } else { format!("无法启动 SSH：{error}") })?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "无法写入 SSH 命令".to_string())?;
        stdin
            .write_all(script.as_bytes())
            .map_err(|error| format!("无法发送 SSH 查询：{error}"))?;
        drop(stdin);
        child
            .wait_with_output()
            .map_err(|error| format!("SSH 查询失败：{error}"))
    })
    .await
    .map_err(|error| format!("SSH 查询任务失败：{error}"))??;
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

async fn run_across_servers(
    environment: &EnvironmentConfig,
    script: &str,
    args: &[String],
    timeout_seconds: u64,
) -> Result<Vec<(SshServerConfig, String)>, String> {
    let servers = configured_servers(environment);
    if servers.is_empty() { return Err("当前环境未配置 SSH 服务器".to_string()); }
    let mut outputs = Vec::new();
    let mut errors = Vec::new();
    for server in servers {
        match run_script(environment, &server, script, args, timeout_seconds).await {
            Ok(raw) => outputs.push((server, raw)),
            Err(error) => errors.push(format!("{}：{error}", server.name)),
        }
    }
    if outputs.is_empty() { Err(format!("服务器组全部连接失败：{}", errors.join("；"))) } else { Ok(outputs) }
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
    let mut detected = None;
    for server in &servers {
        if let Ok(raw) = run_script(environment, server, TIME_PROFILE_SCRIPT, &[], 10).await { detected = Some(raw); break; }
    }
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
    let (timestamp, body) = line.split_once(" -> |")?;
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
        ("ecp.txn.trace", String::new()),
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

fn transaction_prefilter(input: &SearchInput) -> String {
    [
        input.txn_id.as_deref(),
        input.txn_no.as_deref(),
        input.message_code.as_deref(),
        input.service.as_deref(),
        input.node.as_deref(),
        input.business.as_deref(),
        input.message_info.as_deref(),
    ]
    .into_iter()
    .flatten()
    .map(str::trim)
    .find(|value| !value.is_empty())
    .unwrap_or_default()
    .to_string()
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
    for (key, candidate) in [
        ("ecp.txn.id", input.txn_id.as_deref()),
        ("ecp.txn.no", input.txn_no.as_deref()),
        ("ecp.txn.business", input.business.as_deref()),
        ("ecp.txn.service", input.service.as_deref()),
        ("ecp.txn.message.code", input.message_code.as_deref()),
        ("ecp.txn.message.info", input.message_info.as_deref()),
        ("ecp.txn.node", input.node.as_deref()),
    ] {
        if !contains(row, key, candidate) {
            return false;
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
    let success = row
        .get("ecp.txn.message.code")
        .and_then(Value::as_str)
        .is_some_and(|code| code.ends_with("00000"));
    !matches!(input.status, Some(SearchStatus::Success) if !success)
        && !matches!(input.status, Some(SearchStatus::Fail) if success)
}

fn parse_log_record(
    record: &str,
    host: &str,
    offset: FixedOffset,
    year: i32,
) -> Option<Map<String, Value>> {
    let (source, content) = record.split_once('\u{1f}')?;
    let fields = content.trim().split(" §§ ").collect::<Vec<_>>();
    if fields.len() < 11 {
        let bracket = content.find('[')?;
        let close = content[bracket + 1..].find(']')? + bracket + 1;
        let level =
            content[..bracket].trim_end_matches(|character: char| character.is_ascii_digit());
        let short_timestamp = &content[bracket + 1..close];
        let timestamp = parse_timestamp(&format!("{year}-{short_timestamp}"), offset)?.to_rfc3339();
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
    let args = vec![
        root,
        days,
        input.level.clone().unwrap_or_default(),
        input.keyword.clone().unwrap_or_default(),
        input.file.clone().unwrap_or_default(),
    ];
    let start = DateTime::parse_from_rfc3339(&input.start_time)
        .map_err(|_| "开始时间格式不合法".to_string())?;
    let end = DateTime::parse_from_rfc3339(&input.end_time)
        .map_err(|_| "结束时间格式不合法".to_string())?;
    let limit = if export_all {
        20_000
    } else {
        (input.page * input.page_size).min(10_000)
    };
    let year = start.with_timezone(&offset).year();
    let mut rows = Vec::new();
    for (server, raw) in run_across_servers(environment, LOG_SEARCH_SCRIPT, &args, 120).await? {
        rows.extend(raw.split('\u{1e}').filter_map(|record| parse_log_record(record, if server.name.is_empty() { &server.host } else { &server.name }, offset, year)));
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
    })
}

pub async fn search(
    environment: &EnvironmentConfig,
    input: &SearchInput,
    export_all: bool,
) -> Result<QueryResult, String> {
    if input.kind != LogKind::Transaction {
        return search_application_logs(environment, input, export_all).await;
    }
    let application = selected_application(environment, input.application.as_deref())?;
    let offset = resolved_log_offset(environment).await?;
    let days = days_in_range(&input.start_time, &input.end_time, offset)?;
    let root = application_root(&application)?;
    let prefilter = transaction_prefilter(input);
    let start_time = local_timestamp_boundary(&input.start_time, offset)?;
    let end_time = local_timestamp_boundary(&input.end_time, offset)?;
    let limit = if export_all {
        20_000
    } else {
        (input.page * input.page_size).min(10_000)
    };
    let mut rows = Vec::new();
    for (server, raw) in run_across_servers(environment, TRANSACTION_LIST_SCRIPT, &[root.clone(), days.clone(), prefilter.clone(), start_time.clone(), end_time.clone()], 120).await? {
        rows.extend(raw.lines().filter_map(|line| parse_transaction_line(line, if server.name.is_empty() { &server.host } else { &server.name }, &application.name, offset)));
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
    let offset = resolved_log_offset(environment).await?;
    let days = days_in_range(start, end, offset)?;
    let root = application_root(&application)?;
    let mut combined = String::new();
    for (server, content) in run_across_servers(environment, TRANSACTION_CONTENT_SCRIPT, &[root.clone(), id.to_string(), days.clone()], 300).await? {
        if !content.trim().is_empty() {
            combined.push_str(&format!("\n===== OPSLOG SERVER: {} =====\n{}", if server.name.is_empty() { &server.host } else { &server.name }, content));
        }
    }
    Ok(combined)
}
