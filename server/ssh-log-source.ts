import { spawn } from "node:child_process";
import type { EnvironmentConfig, QueryResult, SearchInput, SshApplicationConfig, SshServerConfig } from "./domain.js";

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const TIME_PROFILE_CACHE_MS = 10 * 60 * 1000;
const SAFE_LOG_ID = /^[A-Za-z0-9._-]+$/;
const TRANSACTION_COLUMNS = [
  "ecp.txn.timestamp", "ecp.txn.id", "ecp.txn.no", "ecp.txn.business",
  "ecp.txn.node", "ecp.txn.service", "ecp.txn.server", "ecp.txn.duration",
  "ecp.txn.message.code", "ecp.txn.message.info", "ecp.txn.trace",
  "ecp.txn.tenant", "ecp.txn.src.node.id"
];

const TRANSACTION_LIST_SCRIPT = String.raw`set -eu
decode_arg() { if [ "$1" = "-" ]; then return 0; fi; printf '%s' "$1" | perl -pe 's/([0-9a-f]{2})/chr(hex($1))/ge'; }
root=$(decode_arg "$1")
if [ ! -d "$root" ]; then
  parent=$(dirname "$root")
  if [ "$(basename "$root")" = "$(basename "$parent")" ] && [ -d "$parent/log" ] && [ -d "$parent/trc" ]; then root=$parent; fi
fi
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
seen=''
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
    if [ -f "$directory/$base.trc" ]; then file="$directory/$base.trc"; fi
    year=$(date -r "$file" +%Y)
    timestamp=$(awk -F ' §§ ' -v year="$year" '
      NF >= 2 && $2 ~ /^20[0-9][0-9]-/ { print $2; exit }
      match($0, /\[[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9][,.][0-9][0-9][0-9]\]/) {
        value=substr($0, RSTART+1, RLENGTH-2); gsub(/,/, ".", value); print year "-" value; exit
      }
    ' "$file")
    [ -n "$timestamp" ] || continue
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
    [ -n "$summary_service" ] || summary_service=$(printf '%s' "$base" | sed -E 's/[.][su]_0_.*$//')
    printf '@OPSLOG_DETAIL\t%s\t%s\t%s\t%s\t%s\n' "$timestamp" "$base" "$summary_business" "$summary_service" "$duration"
  done
done
IFS=$oldifs
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
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutSeconds * 1000);
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
      if (signal) { reject(new Error(`SSH 查询超时或被终止（${signal}）`)); return; }
      if (code !== 0) { reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `SSH 命令执行失败：${code}`)); return; }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
    child.stdin.end(script);
  });
};

const runAcrossServers = async (environment: EnvironmentConfig, script: string, args: string[], timeoutSeconds: number): Promise<Array<{ server: SshServerConfig; raw: string }>> => {
  const servers = configuredServers(environment);
  if (!servers.length) throw new Error("当前环境未配置 SSH 服务器");
  const settled = await Promise.allSettled(servers.map(async (server) => ({ server, raw: await runSshScript(environment, server, script, args, timeoutSeconds) })));
  const outputs = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  if (outputs.length) return outputs;
  throw new Error(`服务器组全部连接失败：${settled.map((result, index) => result.status === "rejected" ? `${servers[index]!.name}：${result.reason instanceof Error ? result.reason.message : String(result.reason)}` : "").filter(Boolean).join("；")}`);
};

export const resolveSshTimeProfile = async (environment: EnvironmentConfig): Promise<SshTimeProfile> => {
  const servers = configuredServers(environment);
  const cacheKey = [JSON.stringify(servers.map(({ host, port, username, authentication }) => ({ host, port, username, authentication }))), environment.timeZone ?? "", environment.sshLogTimeOffset ?? "", String(environment.sshAutoDetectTimeZone !== false)].join("\u0000");
  const cached = timeProfileCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (environment.sshAutoDetectTimeZone === false) return { timeZone: environment.timeZone || "Africa/Nairobi", offset: environment.sshLogTimeOffset ?? "+03:00", timeZoneSource: "configured" };
  try {
    let output = "";
    let lastError: unknown;
    for (const server of servers) {
      try { output = await runSshScript(environment, server, TIME_PROFILE_SCRIPT, [], 10); break; } catch (error) { lastError = error; }
    }
    if (!output) throw lastError ?? new Error("未配置 SSH 服务器");
    const [detectedZone, detectedOffset] = output.trim().split(/\r?\n/);
    const timeZone = detectedZone?.trim() || environment.timeZone || "Africa/Nairobi";
    const offset = /^[+-](?:0\d|1\d|2[0-3]):[0-5]\d$/.test(detectedOffset?.trim() ?? "")
      ? detectedOffset!.trim()
      : environment.sshLogTimeOffset ?? "+03:00";
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

const transactionPrefilter = (input: SearchInput): string => [
  input.txnId, input.txnNo, input.messageCode, input.service,
  input.node, input.business, input.messageInfo
].find((value) => value?.trim())?.trim() ?? "";

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
    if (!includes(row["ecp.txn.message.code"], input.messageCode) || !includes(row["ecp.txn.message.info"], input.messageInfo)) return false;
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

const parseLogRecord = (record: string, host: string, offset: string, year: number): Record<string, unknown> | undefined => {
  const separator = record.indexOf("\x1f");
  if (separator < 0) return undefined;
  const source = record.slice(0, separator);
  const content = record.slice(separator + 1).trim();
  const fields = content.split(" §§ ");
  if (fields.length < 11) {
    const raw = /^([A-Z]+)\d*\[(\d{2}-\d{2} \d{2}:\d{2}:\d{2}[.,]\d{3})\](.*)$/s.exec(content);
    if (!raw) return undefined;
    const timestamp = sourceIso(`${year}-${raw[2]}`, offset);
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
  const outputs = await runAcrossServers(environment, LOG_SEARCH_SCRIPT, [applicationRoot(application), days, input.level?.trim() ?? "", input.keyword?.trim() ?? "", input.file?.trim() ?? ""], 120);
  const start = Date.parse(input.startTime);
  const end = Date.parse(input.endTime);
  const limit = exportAll ? 20_000 : Math.min(input.page * input.pageSize, 10_000);
  const columns = input.kind === "ecp"
    ? ["ecp.log.timestamp", "ecp.log.application", "ecp.log.level", "ecp.log.file", "ecp.log.thread", "message", "trace.id", "host.name"]
    : input.kind === "generic"
      ? ["@timestamp", "ecp.log.application", "ecp.log.level", "ecp.log.thread", "message", "trace.id", "host.name"]
      : ["ecp.log.timestamp", "ecp.log.application", "ecp.log.level", "ecp.log.thread", "message", "trace.id", "host.name"];
  const year = new Date(Date.parse(input.startTime) + offsetMinutes(offset) * 60_000).getUTCFullYear();
  const rows = outputs.flatMap(({ server, raw }) => raw.split("\x1e").map((record) => parseLogRecord(record, server.name || server.host, offset, year)))
    .filter((row): row is Record<string, unknown> => row !== undefined)
    .filter((row) => {
      const timestamp = Date.parse(String(row["ecp.log.timestamp"]));
      return timestamp >= start && timestamp < end;
    })
    .sort((left, right) => Date.parse(String(right["ecp.log.timestamp"])) - Date.parse(String(left["ecp.log.timestamp"])))
    .slice(0, limit);
  return { columns, rows };
};

export const searchSshLogs = async (environment: EnvironmentConfig, input: SearchInput, exportAll = false): Promise<QueryResult> => {
  if (input.kind !== "transaction") return searchSshApplicationLogs(environment, input, exportAll);
  const application = selectedApplication(environment, input);
  const { offset } = await resolveSshTimeProfile(environment);
  const days = daysInRange(input.startTime, input.endTime, offset).join(",");
  const outputs = await runAcrossServers(environment, TRANSACTION_LIST_SCRIPT, [applicationRoot(application), days, transactionPrefilter(input), localTimestampBoundary(input.startTime, offset), localTimestampBoundary(input.endTime, offset)], 120);
  const limit = exportAll ? 20_000 : Math.min(input.page * input.pageSize, 10_000);
  const parsedByServer = outputs.map(({ server, raw }) => ({
    server,
    rows: raw.split(/\r?\n/).map((line) => parseTransactionLine(line, server.name || server.host, offset))
      .filter((row): row is Record<string, unknown> => row !== undefined)
  }));
  const fallback = await Promise.all(parsedByServer.filter(({ rows }) => rows.length === 0).map(async ({ server }) => ({
    server,
    raw: await runSshScript(environment, server, TRANSACTION_DETAIL_SCRIPT, [
      applicationRoot(application), days, input.txnId?.trim() ?? "", input.txnNo?.trim() ?? "",
      input.business?.trim() ?? "", input.service?.trim() ?? "", input.node?.trim() ?? "",
      input.messageCode?.trim() ?? "", input.messageInfo?.trim() ?? ""
    ], 120)
  })));
  const parsedRows = parsedByServer.flatMap(({ rows }) => rows);
  const detailRows = fallback.flatMap(({ server, raw }) => raw.split(/\r?\n/).map((line) => parseTransactionDetail(line, server.name || server.host, offset)))
    .filter((row): row is Record<string, unknown> => row !== undefined);
  const rows = [...parsedRows, ...detailRows]
    .filter((row) => matchesTransaction(row, input))
    .map((row): Record<string, unknown> => ({ ...row, "opslog.source.application": application.name }))
    .sort((left, right) => Date.parse(String(right["ecp.txn.timestamp"])) - Date.parse(String(left["ecp.txn.timestamp"])))
    .slice(0, limit);
  return { columns: TRANSACTION_COLUMNS, rows };
};

export const readSshTransactionLog = async (environment: EnvironmentConfig, id: string, startTime: string, endTime: string, application?: string): Promise<string> => {
  if (!SAFE_LOG_ID.test(id)) throw new Error("日志 ID 包含不允许的字符");
  const selected = selectedApplication(environment, { application } as SearchInput);
  const { offset } = await resolveSshTimeProfile(environment);
  const days = daysInRange(startTime, endTime, offset).join(",");
  const outputs = await runAcrossServers(environment, TRANSACTION_CONTENT_SCRIPT, [applicationRoot(selected), id, days], 300);
  return outputs.filter(({ raw }) => raw.trim()).map(({ server, raw }) => `\n===== OPSLOG SERVER: ${server.name || server.host} =====\n${raw}`).join("\n");
};
