import { spawn } from "node:child_process";
import type { EnvironmentConfig, QueryResult, SearchInput } from "./domain.js";

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const SAFE_LOG_ID = /^[A-Za-z0-9._-]+$/;
const TRANSACTION_COLUMNS = [
  "ecp.txn.timestamp", "ecp.txn.id", "ecp.txn.no", "ecp.txn.business",
  "ecp.txn.node", "ecp.txn.service", "ecp.txn.server", "ecp.txn.duration",
  "ecp.txn.message.code", "ecp.txn.message.info", "ecp.txn.trace",
  "ecp.txn.tenant", "ecp.txn.src.node.id"
];

const TRANSACTION_LIST_SCRIPT = String.raw`set -eu
decode_arg() { printf '%s' "$1" | perl -pe 's/([0-9a-f]{2})/chr(hex($1))/ge'; }
root=$(decode_arg "$1")
days=$(decode_arg "$2")
seen=''
emit_file() {
  file=$1
  [ -f "$file" ] || return 0
  case " $seen " in *" $file "*) return 0;; esac
  seen="$seen $file"
  cat -- "$file"
}
for file in "$root"/log/txn_*.lst; do emit_file "$file"; done
oldifs=$IFS
IFS=,
for day in $days; do
  for file in "$root"/log/"$day"/txn_*.lst; do emit_file "$file"; done
done
IFS=$oldifs
`;

const TRANSACTION_CONTENT_SCRIPT = String.raw`set -eu
decode_arg() { printf '%s' "$1" | perl -pe 's/([0-9a-f]{2})/chr(hex($1))/ge'; }
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
exit 0
`;

const LOG_SEARCH_SCRIPT = String.raw`set -eu
decode_arg() { printf '%s' "$1" | perl -pe 's/([0-9a-f]{2})/chr(hex($1))/ge'; }
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
      BEGIN { RS=" §§ logEnd[[:space:]]*"; ORS="\036"; emitted=0 }
      emitted < 5000 && (wanted_level == "" || index($0, "§§ " wanted_level " §§") > 0) && (wanted_keyword == "" || index(tolower($0), tolower(wanted_keyword)) > 0) { printf "%s\037%s", source, $0; emitted++ }
    ' "$file"
  else
    awk -v source="$name" -v wanted_level="$level" -v wanted_keyword="$keyword" '
      BEGIN { emitted=0 }
      emitted < 5000 && (wanted_level == "" || index($0, wanted_level) > 0) && (wanted_keyword == "" || index(tolower($0), tolower(wanted_keyword)) > 0) { printf "%s\037%s\036", source, $0; emitted++ }
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

const selectedApplication = (environment: EnvironmentConfig, input?: SearchInput): string => {
  const applications = environment.sshApplications ?? [];
  const requested = input?.application?.trim();
  const application = requested || applications[0];
  if (!application || !applications.includes(application)) throw new Error("请选择当前 SSH 环境中已配置的监控应用");
  return application;
};

const applicationRoot = (environment: EnvironmentConfig, application: string): string => {
  const base = environment.sshBaseDirectory ?? "/home/coradm";
  if (!base.startsWith("/") || !/^[A-Za-z0-9_./-]+$/.test(base) || base.includes("..")) {
    throw new Error("SSH 日志基础目录不合法");
  }
  return `${base.replace(/\/+$/, "")}/${application}`;
};

const runSshScript = (environment: EnvironmentConfig, script: string, args: string[], timeoutSeconds: number): Promise<string> => {
  const host = environment.sshHost?.trim();
  if (!host || !/^[A-Za-z0-9_.@-]+$/.test(host)) return Promise.reject(new Error("SSH 主机配置不合法"));
  const connectTimeout = environment.sshConnectTimeoutSeconds ?? 10;
  return new Promise((resolve, reject) => {
    const encodedArgs = args.map((value) => Buffer.from(value, "utf8").toString("hex"));
    const child = spawn("ssh", ["-o", "BatchMode=yes", "-o", `ConnectTimeout=${connectTimeout}`, host, "sh", "-s", "--", ...encodedArgs], { stdio: ["pipe", "pipe", "pipe"] });
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
    child.once("error", (error) => { clearTimeout(timer); reject(new Error(`无法启动 SSH：${error.message}`)); });
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
    "ecp.txn.service": parts[4],
    "ecp.txn.business": parts[5],
    "ecp.txn.duration": Number(parts[6]) || 0,
    "ecp.txn.message.code": fields.code,
    "ecp.txn.message.info": fields.message,
    "ecp.txn.trace": "",
    "ecp.txn.server": host,
    "ecp.txn.src.node.id": fields.source
  };
};

const includes = (value: unknown, candidate?: string): boolean => !candidate?.trim() || String(value ?? "").toLocaleLowerCase().includes(candidate.trim().toLocaleLowerCase());

const matchesTransaction = (row: Record<string, unknown>, input: SearchInput): boolean => {
  const timestamp = Date.parse(String(row["ecp.txn.timestamp"]));
  if (timestamp < Date.parse(input.startTime) || timestamp >= Date.parse(input.endTime)) return false;
  if (!includes(row["ecp.txn.id"], input.txnId) || !includes(row["ecp.txn.no"], input.txnNo)) return false;
  if (!includes(row["ecp.txn.business"], input.business) || !includes(row["ecp.txn.service"], input.service)) return false;
  if (!includes(row["ecp.txn.message.code"], input.messageCode) || !includes(row["ecp.txn.message.info"], input.messageInfo)) return false;
  if (!includes(row["ecp.txn.node"], input.node)) return false;
  if (input.minDurationMs && Number(row["ecp.txn.duration"]) < input.minDurationMs) return false;
  const success = String(row["ecp.txn.message.code"] ?? "").endsWith("00000");
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
  const offset = environment.sshLogTimeOffset ?? "+03:00";
  const days = daysInRange(input.startTime, input.endTime, offset).join(",");
  const raw = await runSshScript(environment, LOG_SEARCH_SCRIPT, [
    applicationRoot(environment, application), days, input.level?.trim() ?? "",
    input.keyword?.trim() ?? "", input.file?.trim() ?? ""
  ], 120);
  const start = Date.parse(input.startTime);
  const end = Date.parse(input.endTime);
  const limit = exportAll ? 20_000 : Math.min(input.page * input.pageSize, 10_000);
  const columns = input.kind === "ecp"
    ? ["ecp.log.timestamp", "ecp.log.application", "ecp.log.level", "ecp.log.file", "ecp.log.thread", "message", "trace.id", "host.name"]
    : input.kind === "generic"
      ? ["@timestamp", "ecp.log.application", "ecp.log.level", "ecp.log.thread", "message", "trace.id", "host.name"]
      : ["ecp.log.timestamp", "ecp.log.application", "ecp.log.level", "ecp.log.thread", "message", "trace.id", "host.name"];
  const year = new Date(Date.parse(input.startTime) + offsetMinutes(offset) * 60_000).getUTCFullYear();
  const rows = raw.split("\x1e")
    .map((record) => parseLogRecord(record, environment.sshHost ?? "", offset, year))
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
  const offset = environment.sshLogTimeOffset ?? "+03:00";
  const days = daysInRange(input.startTime, input.endTime, offset).join(",");
  const raw = await runSshScript(environment, TRANSACTION_LIST_SCRIPT, [applicationRoot(environment, application), days], 120);
  const limit = exportAll ? 20_000 : Math.min(input.page * input.pageSize, 10_000);
  const parsedRows = raw.split(/\r?\n/)
    .map((line) => parseTransactionLine(line, environment.sshHost ?? "", offset))
    .filter((row): row is Record<string, unknown> => row !== undefined);
  const rows = parsedRows
    .filter((row) => matchesTransaction(row, input))
    .map((row): Record<string, unknown> => ({ ...row, "opslog.source.application": application }))
    .sort((left, right) => Date.parse(String(right["ecp.txn.timestamp"])) - Date.parse(String(left["ecp.txn.timestamp"])))
    .slice(0, limit);
  return { columns: TRANSACTION_COLUMNS, rows };
};

export const readSshTransactionLog = async (environment: EnvironmentConfig, id: string, startTime: string, endTime: string, application?: string): Promise<string> => {
  if (!SAFE_LOG_ID.test(id)) throw new Error("日志 ID 包含不允许的字符");
  const selected = selectedApplication(environment, { application } as SearchInput);
  const offset = environment.sshLogTimeOffset ?? "+03:00";
  const days = daysInRange(startTime, endTime, offset).join(",");
  return runSshScript(environment, TRANSACTION_CONTENT_SCRIPT, [applicationRoot(environment, selected), id, days], 300);
};
