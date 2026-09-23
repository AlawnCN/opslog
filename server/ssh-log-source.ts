import { spawn } from "node:child_process";
import type { EnvironmentConfig, QueryResult, SearchInput, SshApplicationConfig, SshServerConfig } from "./domain.js";

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_PARALLEL_SERVERS = 4;
const TIME_PROFILE_CACHE_MS = 10 * 60 * 1000;
const SAFE_LOG_ID = /^[A-Za-z0-9._-]+$/;
const TRANSACTION_COLUMNS = [
  "ecp.txn.timestamp", "ecp.txn.id", "ecp.txn.no", "ecp.txn.business",
  "ecp.txn.node", "ecp.txn.service", "ecp.txn.server", "ecp.txn.duration",
  "ecp.txn.message.code", "ecp.txn.message.info", "ecp.txn.trace",
  "ecp.txn.tenant", "ecp.txn.src.node.id"
];

// Filter and retain the newest matching rows on the remote host. The list never needs
// the potentially huge context payload embedded in each transaction summary line.
const TRANSACTION_LIST_SCRIPT = String.raw`set -eu
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
`;

// Older installations retain per-transaction trace files without txn_*.lst.
// Return only file identity, timestamp and optional summary metadata; never transfer entire traces for a list query.
const TRANSACTION_DETAIL_SCRIPT = String.raw`set -eu
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
`;

const TIME_PROFILE_SCRIPT = String.raw`set -eu
zone=$(timedatectl show -p Timezone --value 2>/dev/null || true)
[ -n "$zone" ] || zone=$(cat /etc/timezone 2>/dev/null || true)
offset=$(date +%:z)
printf '%s\n%s\n' "$zone" "$offset"
`;

const TRANSACTION_CONTENT_SCRIPT = String.raw`set -eu
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
exit 0
`;

const LOG_SEARCH_SCRIPT = String.raw`set -eu
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
`;

export interface SshTimeProfile {
  timeZone: string;
  offset: string;
  timeZoneSource: "configured" | "ssh" | "default";
}

const timeProfileCache = new Map<string, { expiresAt: number; value: SshTimeProfile }>();

const offsetMinutes = (value: string): number => {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(value);
  if (!match) return 180;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
};

const sourceDate = (value: string, offset: string): Date => {
  const normalized = value.replace(" ", "T").replace(",", ".");
  return new Date(`${normalized}${offset}`);
};

const sourceIso = (value: string, offset: string): string | undefined => {
  const date = sourceDate(value, offset);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

const daysInRange = (start: string, end: string, offset: string): string[] => {
  const shift = offsetMinutes(offset) * 60_000;
  const cursor = new Date(Date.parse(start) + shift);
  const finish = new Date(Date.parse(end) + shift);
  cursor.setUTCHours(0, 0, 0, 0);
  const days = new Set<string>();
  while (cursor <= finish) {
    days.add(String(cursor.getUTCDate()).padStart(2, "0"));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return [...days];
};

const configuredServers = (environment: EnvironmentConfig): SshServerConfig[] => environment.sshServers?.length
  ? environment.sshServers
  : environment.sshHost ? [{ name: environment.sshHost, host: environment.sshHost, authentication: "ssh-config" }] : [];

const configuredApplications = (environment: EnvironmentConfig): SshApplicationConfig[] => environment.sshMonitoredApplications?.length
  ? environment.sshMonitoredApplications
  : (environment.sshApplications ?? []).map((name) => ({ name, directory: `${(environment.sshBaseDirectory ?? "/home/coradm").replace(/\/+$/, "")}/${name}` }));

const selectedApplication = (environment: EnvironmentConfig, input?: SearchInput): SshApplicationConfig => {
  const applications = configuredApplications(environment);
  const requested = input?.application?.trim();
  const application = applications.find(({ name }) => name === requested) ?? (!requested ? applications[0] : undefined);
  if (!application) throw new Error("请选择当前 SSH 环境中已配置的监控应用");
  return application;
};

const applicationRoot = (application: SshApplicationConfig): string => {
  if (!application.directory.startsWith("/") || !/^[A-Za-z0-9_./-]+$/.test(application.directory) || application.directory.includes("..")) {
    throw new Error("SSH 应用日志目录不合法");
  }
  return application.directory.replace(/\/+$/, "");
};

const runSshScript = (environment: EnvironmentConfig, server: SshServerConfig, script: string, args: string[], timeoutSeconds: number): Promise<string> => {
  const host = server.host.trim();
  if (!host || !/^[A-Za-z0-9_.@-]+$/.test(host)) return Promise.reject(new Error("SSH 主机配置不合法"));
  const connectTimeout = environment.sshConnectTimeoutSeconds ?? 10;
  return new Promise((resolve, reject) => {
    const encodedArgs = args.map((value) => value ? Buffer.from(value, "utf8").toString("hex") : "-");
    const sshArgs = ["-o", `ConnectTimeout=${connectTimeout}`];
    if (server.port) sshArgs.push("-p", String(server.port));
    if (server.authentication === "private-key" && server.privateKeyPath) sshArgs.push("-i", server.privateKeyPath, "-o", "BatchMode=yes");
    else if (server.authentication === "ssh-config") sshArgs.push("-o", "BatchMode=yes");
    const destination = server.authentication === "ssh-config" || !server.username ? host : `${server.username}@${host}`;
    sshArgs.push(destination, "sh", "-s", "--", ...encodedArgs);
    const command = server.authentication === "password" ? "sshpass" : "ssh";
    const commandArgs = server.authentication === "password" ? ["-e", "ssh", ...sshArgs] : sshArgs;
    const child = spawn(command, commandArgs, { stdio: ["pipe", "pipe", "pipe"], env: server.authentication === "password" ? { ...process.env, SSHPASS: server.password ?? "" } : process.env });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutSeconds * 1000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) child.kill("SIGKILL");
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => { clearTimeout(timer); reject(new Error(server.authentication === "password" && (error as NodeJS.ErrnoException).code === "ENOENT" ? "密码认证需要本机安装 sshpass；建议改用 SSH Config 或私钥认证" : `无法启动 SSH：${error.message}`)); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (size > MAX_OUTPUT_BYTES) { reject(new Error("SSH 返回内容超过 64 MB 安全上限，请缩小查询范围")); return; }
      if (timedOut) { reject(new Error(`SSH 查询超过 ${timeoutSeconds} 秒，请缩小时间范围或增加筛选条件`)); return; }
      if (signal) { reject(new Error(`SSH 查询超时或被终止（${signal}）`)); return; }
      if (code !== 0) { reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `SSH 命令执行失败：${code}`)); return; }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
    child.stdin.end(script);
  });
};

interface SshServerGroupResult {
  outputs: Array<{ server: SshServerConfig; raw: string }>;
  warnings: string[];
}

const runAcrossServers = async (
  environment: EnvironmentConfig,
  script: string,
  args: string[],
  timeoutSeconds: number,
  servers: SshServerConfig[] = configuredServers(environment),
  requireSuccess = true
): Promise<SshServerGroupResult> => {
  if (!servers.length) throw new Error("当前环境未配置 SSH 服务器");
  const outcomes: Array<{ server: SshServerConfig; raw?: string; error?: string }> = new Array(servers.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_SERVERS, servers.length) }, async () => {
    while (next < servers.length) {
      const index = next++;
      const server = servers[index]!;
      try { outcomes[index] = { server, raw: await runSshScript(environment, server, script, args, timeoutSeconds) }; }
      catch (error) { outcomes[index] = { server, error: error instanceof Error ? error.message : String(error) }; }
    }
  }));
  const outputs = outcomes.flatMap(({ server, raw }) => raw === undefined ? [] : [{ server, raw }]);
  const warnings = outcomes.flatMap(({ server, error }) => error === undefined ? [] : [`${server.name || server.host}：${error}`]);
  if (!outputs.length && requireSuccess) throw new Error(`服务器组全部连接失败：${warnings.join("；")}`);
  return { outputs, warnings };
};

export const resolveSshTimeProfile = async (environment: EnvironmentConfig): Promise<SshTimeProfile> => {
  const servers = configuredServers(environment);
  const cacheKey = [JSON.stringify(servers.map(({ host, port, username, authentication }) => ({ host, port, username, authentication }))), environment.timeZone ?? "", environment.sshLogTimeOffset ?? "", String(environment.sshAutoDetectTimeZone !== false)].join("\u0000");
  const cached = timeProfileCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (environment.sshAutoDetectTimeZone === false) return { timeZone: environment.timeZone || "Africa/Nairobi", offset: environment.sshLogTimeOffset ?? "+03:00", timeZoneSource: "configured" };
  try {
    const group = await runAcrossServers(environment, TIME_PROFILE_SCRIPT, [], 10);
    const detected = group.outputs.map(({ raw }) => raw.trim().split(/\r?\n/))
      .find(([, offset]) => /^[+-](?:0\d|1\d|2[0-3]):[0-5]\d$/.test(offset?.trim() ?? ""));
    if (!detected) throw new Error("服务器未返回有效时区偏移");
    const [detectedZone, detectedOffset] = detected;
    const timeZone = detectedZone?.trim() || environment.timeZone || "Africa/Nairobi";
    const offset = detectedOffset!.trim();
    const value: SshTimeProfile = { timeZone, offset, timeZoneSource: "ssh" };
    timeProfileCache.set(cacheKey, { expiresAt: Date.now() + TIME_PROFILE_CACHE_MS, value });
    return value;
  } catch {
    const value: SshTimeProfile = {
      timeZone: environment.timeZone || "Africa/Nairobi",
      offset: environment.sshLogTimeOffset ?? "+03:00",
      timeZoneSource: environment.timeZone || environment.sshLogTimeOffset ? "configured" : "default"
    };
    timeProfileCache.set(cacheKey, { expiresAt: Date.now() + TIME_PROFILE_CACHE_MS, value });
    return value;
  }
};

const localTimestampBoundary = (value: string, offset: string): string => {
  const shifted = new Date(new Date(value).getTime() + offsetMinutes(offset) * 60_000);
  return shifted.toISOString().slice(0, 23).replace("T", " ");
};

const transactionFields = (body: string): { prefix: string[]; code: string; message: string; source: string } | undefined => {
  const prefix: string[] = [];
  let cursor = 0;
  for (let index = 0; index < 9; index += 1) {
    const separator = body.indexOf("|", cursor);
    if (separator < 0) return undefined;
    prefix.push(body.slice(cursor, separator));
    cursor = separator + 1;
  }
  if (body[cursor] === "{") {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (; cursor < body.length; cursor += 1) {
      const character = body[cursor];
      if (escaped) { escaped = false; continue; }
      if (character === "\\" && quoted) { escaped = true; continue; }
      if (character === '"') { quoted = !quoted; continue; }
      if (quoted) continue;
      if (character === "{") depth += 1;
      if (character === "}" && --depth === 0) { cursor += 1; break; }
    }
  } else {
    const separator = body.indexOf("|", cursor);
    if (separator < 0) return undefined;
    cursor = separator;
  }
  if (body[cursor] !== "|") return undefined;
  const remainder = body.slice(cursor + 1);
  const codeEnd = remainder.indexOf("|");
  const sourceStart = remainder.lastIndexOf("|");
  if (codeEnd < 0 || sourceStart <= codeEnd) return undefined;
  const beforeSource = remainder.slice(codeEnd + 1, sourceStart);
  return { prefix, code: remainder.slice(0, codeEnd), message: beforeSource.endsWith("|") ? beforeSource.slice(0, -1) : beforeSource, source: remainder.slice(sourceStart + 1) };
};

const parseTransactionLine = (line: string, host: string, offset: string): Record<string, unknown> | undefined => {
  const match = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[.,]\d{3})\s+->\s+\|(.*)\|$/.exec(line);
  if (!match) return undefined;
  const fields = transactionFields(match[2]!);
  if (!fields) return undefined;
  const timestamp = sourceIso(match[1]!, offset);
  if (!timestamp) return undefined;
  const parts = fields.prefix;
  return {
    "ecp.txn.timestamp": timestamp,
    "ecp.txn.id": parts[0],
    "ecp.txn.no": parts[1],
    "ecp.txn.tenant": parts[2],
    "ecp.txn.node": parts[3],
    "ecp.txn.business": parts[4],
    "ecp.txn.service": parts[5],
    "ecp.txn.duration": Number(parts[6]) || 0,
    "ecp.txn.message.code": fields.code,
    "ecp.txn.message.info": fields.message,
    "ecp.txn.trace": "",
    "ecp.txn.server": host,
    "ecp.txn.src.node.id": fields.source
  };
};

const parseTransactionDetail = (line: string, host: string, offset: string): Record<string, unknown> | undefined => {
  const [marker, rawTimestamp, id, business, service, rawDuration] = line.split("\t");
  if (marker !== "@OPSLOG_DETAIL" || !rawTimestamp || !id) return undefined;
  const timestamp = sourceIso(rawTimestamp, offset);
  if (!timestamp) return undefined;
  return {
    "ecp.txn.timestamp": timestamp,
    "ecp.txn.id": id,
    "ecp.txn.no": "",
    "ecp.txn.tenant": "",
    "ecp.txn.node": "",
    "ecp.txn.business": business ?? "",
    "ecp.txn.service": service ?? "",
    "ecp.txn.duration": rawDuration ? Number(rawDuration) || 0 : 0,
    "ecp.txn.message.code": "",
    "ecp.txn.message.info": "",
    "ecp.txn.trace": "",
    "ecp.txn.server": host,
    "ecp.txn.src.node.id": "",
    "opslog.ssh.detailSearch": true
  };
};

const includes = (value: unknown, candidate?: string): boolean => !candidate?.trim() || String(value ?? "").toLocaleLowerCase().includes(candidate.trim().toLocaleLowerCase());

const matchesTransaction = (row: Record<string, unknown>, input: SearchInput): boolean => {
  const timestamp = Date.parse(String(row["ecp.txn.timestamp"]));
  if (timestamp < Date.parse(input.startTime) || timestamp >= Date.parse(input.endTime)) return false;
  if (row["opslog.ssh.detailSearch"] !== true) {
    if (!includes(row["ecp.txn.id"], input.txnId) || !includes(row["ecp.txn.no"], input.txnNo)) return false;
    if (!includes(row["ecp.txn.business"], input.business) || !includes(row["ecp.txn.service"], input.service)) return false;
    // Message text can be shortened for transport; the full value was matched on the host.
    if (!includes(row["ecp.txn.message.code"], input.messageCode)) return false;
    if (!includes(row["ecp.txn.node"], input.node)) return false;
  }
  if (input.minDurationMs && Number(row["ecp.txn.duration"]) < input.minDurationMs) return false;
  const code = String(row["ecp.txn.message.code"] ?? "");
  if (input.status && input.status !== "ALL" && !code) return false;
  const success = code.endsWith("00000");
  if (input.status === "SUCCESS" && !success) return false;
  if (input.status === "FAIL" && success) return false;
  return true;
};

const parseLogRecord = (record: string, host: string, offset: string, year: number, endYear: number, start: number, end: number): Record<string, unknown> | undefined => {
  const separator = record.indexOf("\x1f");
  if (separator < 0) return undefined;
  const source = record.slice(0, separator);
  const content = record.slice(separator + 1).trim();
  const fields = content.split(" §§ ");
  if (fields.length < 11) {
    const raw = /^([A-Z]+)\d*\[(\d{2}-\d{2} \d{2}:\d{2}:\d{2}[.,]\d{3})\](.*)$/s.exec(content);
    if (!raw) return undefined;
    let timestamp = sourceIso(`${year}-${raw[2]}`, offset);
    if (timestamp && endYear !== year && (Date.parse(timestamp) < start || Date.parse(timestamp) >= end)) {
      timestamp = sourceIso(`${endYear}-${raw[2]}`, offset);
    }
    if (!timestamp) return undefined;
    return { "ecp.log.timestamp": timestamp, "@timestamp": timestamp, "ecp.log.application": source, "ecp.log.level": raw[1], "ecp.log.file": source, "ecp.log.thread": "", message: raw[3]?.trim() ?? content, "trace.id": "", "host.name": host };
  }
  const timestamp = fields[1]?.trim();
  if (!timestamp) return undefined;
  const timestampIso = sourceIso(timestamp, offset);
  if (!timestampIso) return undefined;
  return {
    "ecp.log.timestamp": timestampIso,
    "ecp.log.application": fields[4]?.trim() ?? "",
    "ecp.log.level": fields[3]?.trim() ?? "",
    "ecp.log.file": source,
    "ecp.log.thread": fields[2]?.trim() ?? "",
    message: fields.slice(10).join(" §§ ").trim(),
    "trace.id": "",
    "host.name": host,
    "@timestamp": timestampIso
  };
};

const searchSshApplicationLogs = async (environment: EnvironmentConfig, input: SearchInput, exportAll: boolean): Promise<QueryResult> => {
  const application = selectedApplication(environment, input);
  const { offset } = await resolveSshTimeProfile(environment);
  const days = daysInRange(input.startTime, input.endTime, offset).join(",");
  const start = Date.parse(input.startTime);
  const end = Date.parse(input.endTime);
  const limit = exportAll ? 20_000 : Math.min(input.page * input.pageSize + 1, 10_001);
  const group = await runAcrossServers(environment, LOG_SEARCH_SCRIPT, [
    applicationRoot(application), days,
    localTimestampBoundary(input.startTime, offset), localTimestampBoundary(input.endTime, offset), String(limit),
    input.level?.trim() ?? "", input.keyword?.trim() ?? "", input.file?.trim() ?? "", exportAll ? "FULL" : "PREVIEW"
  ], 120);
  const columns = input.kind === "ecp"
    ? ["ecp.log.timestamp", "ecp.log.application", "ecp.log.level", "ecp.log.file", "ecp.log.thread", "message", "trace.id", "host.name"]
    : input.kind === "generic"
      ? ["@timestamp", "ecp.log.application", "ecp.log.level", "ecp.log.thread", "message", "trace.id", "host.name"]
      : ["ecp.log.timestamp", "ecp.log.application", "ecp.log.level", "ecp.log.thread", "message", "trace.id", "host.name"];
  const year = new Date(Date.parse(input.startTime) + offsetMinutes(offset) * 60_000).getUTCFullYear();
  const endYear = new Date(Date.parse(input.endTime) + offsetMinutes(offset) * 60_000).getUTCFullYear();
  const rows = group.outputs.flatMap(({ server, raw }) => raw.split("\x1e").map((record) => parseLogRecord(record, server.name || server.host, offset, year, endYear, start, end)))
    .filter((row): row is Record<string, unknown> => row !== undefined)
    .filter((row) => {
      const timestamp = Date.parse(String(row["ecp.log.timestamp"]));
      return timestamp >= start && timestamp < end;
    })
    .sort((left, right) => Date.parse(String(right["ecp.log.timestamp"])) - Date.parse(String(left["ecp.log.timestamp"])))
    .slice(0, limit);
  return { columns, rows, warnings: group.warnings };
};

export const searchSshLogs = async (environment: EnvironmentConfig, input: SearchInput, exportAll = false): Promise<QueryResult> => {
  if (input.kind !== "transaction") return searchSshApplicationLogs(environment, input, exportAll);
  const application = selectedApplication(environment, input);
  const { offset } = await resolveSshTimeProfile(environment);
  const days = daysInRange(input.startTime, input.endTime, offset).join(",");
  const limit = exportAll ? 20_000 : Math.min(input.page * input.pageSize + 1, 10_001);
  const group = await runAcrossServers(environment, TRANSACTION_LIST_SCRIPT, [
    applicationRoot(application), days, localTimestampBoundary(input.startTime, offset), localTimestampBoundary(input.endTime, offset), String(limit),
    input.txnId?.trim() ?? "", input.txnNo?.trim() ?? "", input.business?.trim() ?? "", input.service?.trim() ?? "",
    input.node?.trim() ?? "", input.messageCode?.trim() ?? "", input.messageInfo?.trim() ?? "",
    String(input.minDurationMs ?? ""), input.status ?? "ALL"
  ], 120);
  const parsedByServer = group.outputs.map(({ server, raw }) => ({
    server,
    rows: raw.split(/\r?\n/).map((line) => parseTransactionLine(line, server.name || server.host, offset))
      .filter((row): row is Record<string, unknown> => row !== undefined)
  }));
  const fallbackCandidates = parsedByServer.filter(({ rows }) => rows.length === 0);
  const fallbackGroup = fallbackCandidates.length ? await runAcrossServers(environment, TRANSACTION_DETAIL_SCRIPT, [
      applicationRoot(application), days, input.txnId?.trim() ?? "", input.txnNo?.trim() ?? "",
      input.business?.trim() ?? "", input.service?.trim() ?? "", input.node?.trim() ?? "",
      input.messageCode?.trim() ?? "", input.messageInfo?.trim() ?? "",
      localTimestampBoundary(input.startTime, offset), localTimestampBoundary(input.endTime, offset), String(limit), String(input.minDurationMs ?? "")
    ], 120, fallbackCandidates.map(({ server }) => server), false) : { outputs: [], warnings: [] };
  const warnings = [...group.warnings, ...fallbackGroup.warnings.map((warning) => `明细兜底查询失败：${warning}`)];
  const parsedRows = parsedByServer.flatMap(({ rows }) => rows);
  const detailRows = fallbackGroup.outputs.flatMap(({ server, raw }) => raw.split(/\r?\n/).map((line) => parseTransactionDetail(line, server.name || server.host, offset)))
    .filter((row): row is Record<string, unknown> => row !== undefined);
  const rows = [...parsedRows, ...detailRows]
    .filter((row) => matchesTransaction(row, input))
    .map((row): Record<string, unknown> => ({ ...row, "opslog.source.application": application.name }))
    .sort((left, right) => Date.parse(String(right["ecp.txn.timestamp"])) - Date.parse(String(left["ecp.txn.timestamp"])))
    .slice(0, limit);
  return { columns: TRANSACTION_COLUMNS, rows, warnings };
};

export const readSshTransactionLog = async (environment: EnvironmentConfig, id: string, startTime: string, endTime: string, application?: string): Promise<string> => {
  if (!SAFE_LOG_ID.test(id)) throw new Error("日志 ID 包含不允许的字符");
  const selected = selectedApplication(environment, { application } as SearchInput);
  const { offset } = await resolveSshTimeProfile(environment);
  const days = daysInRange(startTime, endTime, offset).join(",");
  const group = await runAcrossServers(environment, TRANSACTION_CONTENT_SCRIPT, [applicationRoot(selected), id, days], 300);
  const content = group.outputs.filter(({ raw }) => raw.trim()).map(({ server, raw }) => `\n===== OPSLOG SERVER: ${server.name || server.host} =====\n${raw}`).join("\n");
  return group.warnings.length ? `${content}\n===== OPSLOG WARNING: 部分服务器查询失败：${group.warnings.join("；")} =====\n` : content;
};
