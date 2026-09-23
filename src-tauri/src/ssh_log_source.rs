use std::collections::HashMap;
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
const TRANSACTION_LIST_SCRIPT: &str = r#"set -eu
decode_arg() { if [ "$1" = "-" ]; then return 0; fi; printf '%s' "$1" | perl -pe 's/([0-9a-f]{2})/chr(hex($1))/ge'; }
root=$(decode_arg "$1")
if [ ! -d "$root" ]; then
  parent=$(dirname "$root")
  if [ "$(basename "$root")" = "$(basename "$parent")" ] && [ -d "$parent/log" ] && [ -d "$parent/trc" ]; then root=$parent; fi
fi
days=$(decode_arg "$2")
start_time=$(decode_arg "$3")
end_time=$(decode_arg "$4")
limit=$(decode_arg "$5")
txn_id=$(decode_arg "$6")
txn_no=$(decode_arg "$7")
business=$(decode_arg "$8")
service=$(decode_arg "$9")
shift 9
node=$(decode_arg "$1")
message_code=$(decode_arg "$2")
message_info=$(decode_arg "$3")
minimum_duration=$(decode_arg "$4")
status=$(decode_arg "$5")
seen=''
emit_file() {
  file=$1
  [ -f "$file" ] || return 0
  case " $seen " in *" $file "*) return 0;; esac
  seen="$seen $file"
  cat -- "$file"
}
stream_files() {
  for file in "$root"/log/txn_*.lst; do emit_file "$file"; done
  oldifs=$IFS
  IFS=,
  for day in $days; do
    for file in "$root"/log/"$day"/txn_*.lst; do emit_file "$file"; done
  done
  IFS=$oldifs
}
stream_files | perl -e '
use strict;
use warnings;
use Encode qw(decode encode);
my ($start, $end, $limit, $id, $no, $business, $service, $node, $code_filter, $info, $minimum, $status) = @ARGV;
$limit = int($limit);
$minimum = 0 + ($minimum || 0);
sub matches { my ($value, $needle) = @_; return !$needle || index(lc($value), lc($needle)) >= 0; }
my @top;
my $retain = sub {
  my ($stamp, $row) = @_;
  if (@top < $limit) {
    push @top, [$stamp, $row];
    my $index = $#top;
    while ($index > 0) {
      my $parent = int(($index - 1) / 2);
      last if $top[$parent][0] le $top[$index][0];
      @top[$parent, $index] = @top[$index, $parent];
      $index = $parent;
    }
  } elsif ($stamp gt $top[0][0]) {
    $top[0] = [$stamp, $row];
    my $index = 0;
    while (2 * $index + 1 < @top) {
      my $child = 2 * $index + 1;
      $child++ if $child + 1 < @top && $top[$child + 1][0] lt $top[$child][0];
      last if $top[$index][0] le $top[$child][0];
      @top[$index, $child] = @top[$child, $index];
      $index = $child;
    }
  }
};
LINE: while (my $line = <STDIN>) {
  $line =~ s/\r?\n$//;
  my ($stamp, $body) = $line =~ /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[.,]\d{3})\s+->\s+\|(.*)\|$/;
  next unless defined $body;
  $stamp =~ tr/,/./;
  next if $stamp lt $start || $stamp ge $end;
  my @fields;
  my $cursor = 0;
  for (1..9) {
    my $separator = index($body, "|", $cursor);
    next LINE if $separator < 0;
    push @fields, substr($body, $cursor, $separator - $cursor);
    $cursor = $separator + 1;
  }
  my $context_end;
  if (substr($body, $cursor, 1) eq "{") {
    my ($depth, $quoted, $escaped) = (0, 0, 0);
    for (my $index = $cursor; $index < length($body); $index++) {
      my $character = substr($body, $index, 1);
      if ($escaped) { $escaped = 0; next; }
      if ($quoted && $character eq "\\") { $escaped = 1; next; }
      if ($character eq "\"") { $quoted = !$quoted; next; }
      next if $quoted;
      $depth++ if $character eq "{";
      if ($character eq "}" && --$depth == 0) { $context_end = $index + 1; last; }
    }
  } else {
    $context_end = index($body, "|", $cursor);
  }
  next if !defined($context_end) || $context_end < 0 || substr($body, $context_end, 1) ne "|";
  my $tail = substr($body, $context_end + 1);
  my $code_end = index($tail, "|");
  my $source_start = rindex($tail, "|");
  next if $code_end < 0 || $source_start <= $code_end;
  my $code = substr($tail, 0, $code_end);
  my $message = substr($tail, $code_end + 1, $source_start - $code_end - 1);
  $message =~ s/\|$//;
  my $source = substr($tail, $source_start + 1);
  next unless matches($fields[0], $id) && matches($fields[1], $no)
    && matches($fields[4], $business) && matches($fields[5], $service)
    && matches($fields[3], $node) && matches($code, $code_filter) && matches($message, $info);
  next if $minimum && (0 + $fields[6]) < $minimum;
  next if $status ne "ALL" && $status ne "" && $code eq "";
  next if $status eq "SUCCESS" && $code !~ /00000$/;
  next if $status eq "FAIL" && $code =~ /00000$/;
  # The full context and long message remain available in the per-transaction detail view.
  my $preview = encode("UTF-8", substr(decode("UTF-8", $message), 0, 4096));
  my $compact = "$stamp -> |" . join("|", @fields) . "|{}|$code|$preview|$source|\n";
  $retain->($stamp, $compact);
}
print $_->[1] for sort { $b->[0] cmp $a->[0] } @top;
' "$start_time" "$end_time" "$limit" "$txn_id" "$txn_no" "$business" "$service" "$node" "$message_code" "$message_info" "$minimum_duration" "$status"
"#;
const TRANSACTION_DETAIL_SCRIPT: &str = r#"set -eu
decode_arg() { if [ "$1" = "-" ]; then return 0; fi; printf '%s' "$1" | perl -pe 's/([0-9a-f]{2})/chr(hex($1))/ge'; }
root=$(decode_arg "$1")
if [ ! -d "$root" ]; then
  parent=$(dirname "$root")
  if [ "$(basename "$root")" = "$(basename "$parent")" ] && [ -d "$parent/log" ] && [ -d "$parent/trc" ]; then root=$parent; fi
fi
days=$(decode_arg "$2")
txn_id=$(decode_arg "$3")
txn_no=$(decode_arg "$4")
business=$(decode_arg "$5")
service=$(decode_arg "$6")
node=$(decode_arg "$7")
message_code=$(decode_arg "$8")
message_info=$(decode_arg "$9")
shift 9
start_time=$(decode_arg "$1")
end_time=$(decode_arg "$2")
limit=$(decode_arg "$3")
minimum_duration=$(decode_arg "$4")
seen=''
collect_details() {
oldifs=$IFS
IFS=,
for day in $days; do
  directory="$root/trc/$day"
  [ -d "$directory" ] || continue
  for file in "$directory"/*.trc; do
    [ -f "$file" ] || continue
    base=$(basename "$file" .trc | sed -E 's/-[0-9]+$//')
    case "$base" in *.s_0_*|*.u_0_*) ;; *) continue;; esac
    suffix=$(printf '%s' "$base" | sed 's/.*_0_//')
    case "$suffix" in *[!0-9]*|'') continue;; ??????????*) ;; *) continue;; esac
    case " $seen " in *" $base "*) continue;; esac
    seen="$seen $base"
    if [ -n "$txn_id" ] && ! printf '%s' "$base" | grep -iqF -- "$txn_id"; then continue; fi
    if [ -f "$directory/$base.trc" ]; then file="$directory/$base.trc"; fi
    year=$(date -r "$file" +%Y)
    timestamp=$(head -c 65536 "$file" | awk -F ' §§ ' -v year="$year" '
      NF >= 2 && $2 ~ /^20[0-9][0-9]-/ { print $2; exit }
      match($0, /\[[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9][,.][0-9][0-9][0-9]\]/) {
        value=substr($0, RSTART+1, RLENGTH-2); gsub(/,/, ".", value); print year "-" value; exit
      }
    ')
    [ -n "$timestamp" ] || continue
    if ! awk -v value="$timestamp" -v start="$start_time" -v end="$end_time" 'BEGIN { gsub(/,/, ".", value); exit !(value >= start && value < end) }'; then continue; fi
    matched=1
    for needle in "$txn_no" "$business" "$service" "$node" "$message_code" "$message_info"; do
      [ -n "$needle" ] || continue
      hit=0
      for candidate in "$directory/$base.trc" "$directory/$base"-[0-9]*.trc; do
        if [ -f "$candidate" ] && grep -iqF -- "$needle" "$candidate"; then hit=1; break; fi
      done
      if [ "$hit" -eq 0 ]; then matched=0; break; fi
    done
    [ "$matched" -eq 1 ] || continue
    summary_service=''
    summary_business=''
    duration=''
    for summary in "$directory"/transaction_*.trc; do
      [ -f "$summary" ] || continue
      metadata=$(awk -F '|' -v id="$base" '
        index($1, " -> " id) == 0 || NF < 5 { next }
        $3 == "null" || $3 == "TxJnlInterceptor" || $3 == "IdempotentInterceptor" || $3 == "AntiRepeatFilterComponent" { next }
        $5+0 >= longest { longest=$5+0; business=$2; service=$3 }
        END { if (service != "") printf "%s\t%s\t%.0f", business, service, longest }
      ' "$summary")
      if [ -n "$metadata" ]; then
        summary_business=$(printf '%s' "$metadata" | cut -f1)
        summary_service=$(printf '%s' "$metadata" | cut -f2)
        duration=$(printf '%s' "$metadata" | cut -f3)
        break
      fi
    done
    if [ -n "$minimum_duration" ] && ! awk -v value="$duration" -v minimum="$minimum_duration" 'BEGIN { exit !((value + 0) >= (minimum + 0)) }'; then continue; fi
    [ -n "$summary_service" ] || summary_service=$(printf '%s' "$base" | sed -E 's/[.][su]_0_.*$//')
    printf '@OPSLOG_DETAIL\t%s\t%s\t%s\t%s\t%s\n' "$timestamp" "$base" "$summary_business" "$summary_service" "$duration"
  done
done
IFS=$oldifs
}
collect_details | awk -F '\t' -v start="$start_time" -v end="$end_time" '{ value=$2; gsub(/,/, ".", value); if (value >= start && value < end) print }' | LC_ALL=C sort -t "$(printf '\t')" -k2,2r | awk -v limit="$limit" 'NR <= limit'
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
if [ ! -d "$root" ]; then
  parent=$(dirname "$root")
  if [ "$(basename "$root")" = "$(basename "$parent")" ] && [ -d "$parent/log" ] && [ -d "$parent/trc" ]; then root=$parent; fi
fi
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
if [ ! -d "$root" ]; then
  parent=$(dirname "$root")
  if [ "$(basename "$root")" = "$(basename "$parent")" ] && [ -d "$parent/log" ] && [ -d "$parent/trc" ]; then root=$parent; fi
fi
days=$(decode_arg "$2")
start_time=$(decode_arg "$3")
end_time=$(decode_arg "$4")
limit=$(decode_arg "$5")
level=$(decode_arg "$6")
keyword=$(decode_arg "$7")
file_filter=$(decode_arg "$8")
output_mode=$(decode_arg "$9")
seen=''
emit_path() {
  file=$1
  [ -f "$file" ] || return 0
  case " $seen " in *" $file "*) return 0;; esac
  seen="$seen $file"
  name=$(basename "$file")
  case "$name" in txn_*.lst|txntrc_*.trc*) return 0;; esac
  if [ -n "$file_filter" ]; then case "$name" in *"$file_filter"*) ;; *) return 0;; esac; fi
  printf '%s\n' "$file"
}
stream_paths() {
  for file in "$root"/log/*.log "$root"/log/*.log.* "$root"/log/*.log_*; do emit_path "$file"; done
  oldifs=$IFS
  IFS=,
  for day in $days; do
    for file in "$root"/log/"$day"/*.log "$root"/log/"$day"/*.log.* "$root"/log/"$day"/*.log_*; do emit_path "$file"; done
  done
  IFS=$oldifs
}
stream_paths | perl -e '
use strict;
use warnings;
use Encode qw(decode encode);
use File::Basename qw(basename);
use Time::Local qw(timegm);
my ($start, $end, $limit, $level, $keyword, $output_mode) = @ARGV;
$limit = int($limit);
my $first_year = substr($start, 0, 4);
my $last_year = substr($end, 0, 4);
sub day_epoch {
  my ($year, $month, $day) = @_;
  return eval { timegm(0, 0, 0, $day, $month - 1, $year) };
}
my $start_day = day_epoch(substr($start, 0, 4), substr($start, 5, 2), substr($start, 8, 2));
my $end_day = day_epoch(substr($end, 0, 4), substr($end, 5, 2), substr($end, 8, 2));
my $max_record_bytes = int(48 * 1024 * 1024 / $limit);
$max_record_bytes = 65536 if $max_record_bytes > 65536;
my @top;
my $retain = sub {
  my ($stamp, $row) = @_;
  if (@top < $limit) {
    push @top, [$stamp, $row];
    my $index = $#top;
    while ($index > 0) {
      my $parent = int(($index - 1) / 2);
      last if $top[$parent][0] le $top[$index][0];
      @top[$parent, $index] = @top[$index, $parent];
      $index = $parent;
    }
  } elsif ($stamp gt $top[0][0]) {
    $top[0] = [$stamp, $row];
    my $index = 0;
    while (2 * $index + 1 < @top) {
      my $child = 2 * $index + 1;
      $child++ if $child + 1 < @top && $top[$child + 1][0] lt $top[$child][0];
      last if $top[$index][0] le $top[$child][0];
      @top[$index, $child] = @top[$child, $index];
      $index = $child;
    }
  }
};
while (my $path = <STDIN>) {
  chomp $path;
  my $source = basename($path);
  if ($source =~ /(20\d{2})-(\d{2})-(\d{2})/) {
    my $file_day = day_epoch($1, $2, $3);
    next if defined($file_day) && defined($start_day) && defined($end_day)
      && ($file_day < $start_day - 86400 || $file_day > $end_day + 86400);
  }
  open my $file, "<:raw", $path or next;
  my $sample = "";
  read($file, $sample, 1048576);
  my $structured = index($sample, " §§ logEnd") >= 0;
  seek($file, 0, 0);
  local $/ = $structured ? " §§ logEnd" : "\n";
  while (my $record = <$file>) {
    $record =~ s/ §§ logEnd$// if $structured;
    my $stamp;
    if ($structured) {
      my @fields = split(/ §§ /, $record, 3);
      $stamp = $fields[1] if @fields >= 3;
      next if $level ne "" && index($record, "§§ $level §§") < 0;
    } else {
      my ($raw_level, $local_time) = $record =~ /^([A-Z]+)\d*\[(\d{2}-\d{2} \d{2}:\d{2}:\d{2}[.,]\d{3})\]/;
      next unless defined $local_time;
      next if $level ne "" && index($raw_level, $level) < 0;
      $stamp = "$first_year-$local_time";
      $stamp =~ tr/,/./;
      if ($stamp lt $start && $last_year ne $first_year) { $stamp = "$last_year-$local_time"; }
    }
    next unless defined $stamp && $stamp =~ /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[.,]\d{3}/;
    $stamp = substr($stamp, 0, 23);
    $stamp =~ tr/,/./;
    next if $stamp lt $start || $stamp ge $end;
    next if $keyword ne "" && index(lc($record), lc($keyword)) < 0;
    if ($output_mode eq "PREVIEW" && length($record) > $max_record_bytes) {
      $record = encode("UTF-8", substr(decode("UTF-8", substr($record, 0, $max_record_bytes - 32)), 0)) . "\n[日志内容已截断]";
    }
    $retain->($stamp, "$source\x1f$record\x1e");
  }
  close $file;
}
print $_->[1] for sort { $b->[0] cmp $a->[0] } @top;
' "$start_time" "$end_time" "$limit" "$level" "$keyword" "$output_mode"
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
    let mut command = if matches!(server.authentication, SshAuthentication::Password) { let mut command = Command::new("sshpass"); command.args(["-e", "ssh"]); command.env("SSHPASS", server.password.as_deref().unwrap_or_default()); command } else { Command::new("ssh") };
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW applies to the SSH/sshpass child of the GUI app.
    command.kill_on_drop(true);
    let mut child = command.args(ssh_args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| if matches!(server.authentication, SshAuthentication::Password) && error.kind() == std::io::ErrorKind::NotFound { "密码认证需要本机安装 sshpass；建议改用 SSH Config 或私钥认证".to_string() } else { format!("无法启动 SSH：{error}") })?;
    let deadline = StdDuration::from_secs(timeout_seconds.saturating_add(connect_timeout).saturating_add(10));
    let output = tokio::time::timeout(deadline, async {
        let mut stdin = child.stdin.take().ok_or_else(|| "无法写入 SSH 命令".to_string())?;
        stdin.write_all(script.as_bytes()).await.map_err(|error| format!("无法发送 SSH 查询：{error}"))?;
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
    if outputs.is_empty() { return Err(format!("服务器组全部连接失败：{}", warnings.join("；"))); }
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
    for (server, raw) in group.outputs {
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
        warnings: group.warnings,
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
            let result = run_script(environment, &server, TRANSACTION_DETAIL_SCRIPT, args, 120).await;
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
            Ok(detail) => rows.extend(detail.lines().filter_map(|line| parse_transaction_detail(line, host, &application.name, offset))),
            Err(error) => warnings.push(format!("{}：明细兜底查询失败：{error}", host)),
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
