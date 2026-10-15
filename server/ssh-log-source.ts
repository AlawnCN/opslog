import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sshLogSourceSchema } from "../shared/ssh-log-rules.js";
import type { EnvironmentConfig, QueryResult, SearchInput, SshApplicationConfig, SshServerConfig } from "./domain.js";
import { runPasswordSshScript } from "./ssh-password-transport.js";
import { sshControlMasterOptions } from "./ssh-control-master.js";
import { closePasswordSshConnections } from "./ssh-password-transport.js";
import { closeSshControlMasters } from "./ssh-control-master.js";
import { appendSnapshotOutputs, snapshotHasPage, snapshotSession, sshServerKey } from "./ssh-query-sessions.js";

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
const TRANSACTION_LIST_SCRIPT = readFileSync(new URL("./ssh-scripts/transaction_list.sh", import.meta.url), "utf8");

// Both transports use the same bounded summary fallback; never scan all detail files.
const TRANSACTION_SUMMARY_SCRIPT = readFileSync(new URL("./ssh-scripts/transaction_summary.sh", import.meta.url), "utf8");

const TIME_PROFILE_SCRIPT = readFileSync(new URL("./ssh-scripts/time_profile.sh", import.meta.url), "utf8");
const PROBE_SCRIPT = readFileSync(new URL("./ssh-scripts/probe.sh", import.meta.url), "utf8");

export const probeSshServer = async (environment: EnvironmentConfig, signal?: AbortSignal) => {
  const scope = `probe-${randomUUID()}`;
  const started = Date.now();
  const server = configuredServers(environment)[0];
  if (!server) throw new Error("请配置 SSH 服务器");
  try {
    const raw = await runSshScript({ ...environment, name: scope }, server, PROBE_SCRIPT, [],
      (environment.sshConnectTimeoutSeconds ?? 10) + 10, signal);
    const [marker, username, hostname, timeZone, offset] = raw.trim().split(/\r?\n/);
    if (marker !== "OPSLOG_SSH_PROBE_V1" || !username || !hostname || !offset) throw new Error("SSH 已连接，但探测命令返回格式异常");
    return { username, hostname, timeZone, offset, durationMs: Date.now() - started };
  } finally {
    closePasswordSshConnections(scope);
    closeSshControlMasters(scope);
  }
};

const TRANSACTION_CONTENT_SCRIPT = readFileSync(new URL("./ssh-scripts/transaction_content.sh", import.meta.url), "utf8");

const LOG_SEARCH_SCRIPT = readFileSync(new URL("./ssh-scripts/log_search.sh", import.meta.url), "utf8");
const JSON_CODEC = readFileSync(new URL("./ssh-scripts/json_codec.pl", import.meta.url), "utf8");
const CONFIGURED_SCRIPT = readFileSync(new URL("./ssh-scripts/configured_search.sh", import.meta.url), "utf8").replace("# OPSLOG_JSON_CODEC", () => JSON_CODEC);
const SAMPLE_SCRIPT = readFileSync(new URL("./ssh-scripts/sample.sh", import.meta.url), "utf8").replace("# OPSLOG_JSON_CODEC", () => JSON_CODEC);

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

const runSshScript = (environment: EnvironmentConfig, server: SshServerConfig, script: string, args: string[], timeoutSeconds: number, signal?: AbortSignal): Promise<string> => {
  signal?.throwIfAborted();
  const host = server.host.trim();
  if (!host || !/^[A-Za-z0-9_.@-]+$/.test(host)) return Promise.reject(new Error("SSH 主机配置不合法"));
  const connectTimeout = environment.sshConnectTimeoutSeconds ?? 10;
  if (server.authentication === "password") {
    const encodedArgs = args.map((value) => value ? Buffer.from(value, "utf8").toString("hex") : "-");
    return runPasswordSshScript(server, script, encodedArgs, connectTimeout, timeoutSeconds, signal, environment.name);
  }
  return new Promise((resolve, reject) => {
    const encodedArgs = args.map((value) => value ? Buffer.from(value, "utf8").toString("hex") : "-");
    const sshArgs = ["-o", `ConnectTimeout=${connectTimeout}`];
    if (server.port) sshArgs.push("-p", String(server.port));
    if (server.authentication === "private-key" && server.privateKeyPath) sshArgs.push("-i", server.privateKeyPath, "-o", "BatchMode=yes");
    else if (server.authentication === "ssh-config") sshArgs.push("-o", "BatchMode=yes");
    const destination = server.authentication === "ssh-config" || !server.username ? host : `${server.username}@${host}`;
    sshArgs.push(...sshControlMasterOptions(environment.name, [server, connectTimeout], destination));
    sshArgs.push(destination, "timeout", String(timeoutSeconds), "sh", "-s", "--", ...encodedArgs);
    const child = spawn("ssh", sshArgs, { stdio: ["pipe", "pipe", "pipe"] });
    const abort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
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
    child.once("error", (error) => { clearTimeout(timer); reject(new Error(`无法启动 SSH：${error.message}`)); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (size > MAX_OUTPUT_BYTES) { reject(new Error("SSH 返回内容超过 64 MB 安全上限，请缩小查询范围")); return; }
      if (timedOut) { reject(new Error(`SSH 查询超过 ${timeoutSeconds} 秒，请缩小时间范围或增加筛选条件`)); return; }
      if (signal) { reject(new Error(`SSH 查询超时或被终止（${signal}）`)); return; }
      if (code !== 0) { reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `SSH 命令执行失败：${code}`)); return; }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
    child.once("close", () => signal?.removeEventListener("abort", abort));
    child.stdin.end(script.replace(/\r\n?/g, "\n"));
  });
};

interface SshServerGroupResult {
  outputs: Array<{ server: SshServerConfig; raw: string }>;
  warnings: string[];
}

const scanWarnings = (group: SshServerGroupResult): string[] => group.outputs.flatMap(({ server, raw }) =>
  raw.split(/\r?\n/).filter((line) => line.startsWith("@OPSLOG_SCAN_LIMIT\t"))
    .map((line) => `${server.name || server.host}：${line.slice("@OPSLOG_SCAN_LIMIT\t".length)}`));

const runAcrossServers = async (
  environment: EnvironmentConfig,
  script: string,
  args: string[],
  timeoutSeconds: number,
  servers: SshServerConfig[] = configuredServers(environment),
  requireSuccess = true,
  signal?: AbortSignal
): Promise<SshServerGroupResult> => {
  if (!servers.length) throw new Error("当前环境未配置 SSH 服务器");
  const outcomes: Array<{ server: SshServerConfig; raw?: string; error?: string }> = new Array(servers.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_SERVERS, servers.length) }, async () => {
    while (next < servers.length) {
      signal?.throwIfAborted();
      const index = next++;
      const server = servers[index]!;
      const serverArgs = [...args];
      if (script.includes("# OPSLOG_CURSOR_PROTOCOL") && serverArgs.length === 8) {
        serverArgs[7] = JSON.stringify({ ...JSON.parse(serverArgs[7]!), _scanServer: sshServerKey(server) });
      }
      try { outcomes[index] = { server, raw: await runSshScript(environment, server, script, serverArgs, timeoutSeconds, signal) }; }
      catch (error) { outcomes[index] = { server, error: error instanceof Error ? error.message : String(error) }; }
    }
  }));
  signal?.throwIfAborted();
  const outputs = outcomes.flatMap(({ server, raw }) => raw === undefined ? [] : [{ server, raw }]);
  const warnings = outcomes.flatMap(({ server, error }) => error === undefined ? [] : [`${server.name || server.host}：${error}`]);
  if (!outputs.length && requireSuccess) throw new Error(`服务器组执行失败：${warnings.join("；")}`);
  return { outputs, warnings };
};

export const connectSshEnvironment = async (environment: EnvironmentConfig): Promise<void> => {
  const group = await runAcrossServers(environment, TIME_PROFILE_SCRIPT, [], 10, undefined, true);
  if (group.warnings.length) throw new Error(`部分服务器连接失败：${group.warnings.join("；")}`);
};

export const resolveSshTimeProfile = async (environment: EnvironmentConfig, signal?: AbortSignal): Promise<SshTimeProfile> => {
  signal?.throwIfAborted();
  const servers = configuredServers(environment);
  const cacheKey = [JSON.stringify(servers.map(({ host, port, username, authentication }) => ({ host, port, username, authentication }))), environment.timeZone ?? "", environment.sshLogTimeOffset ?? "", String(environment.sshAutoDetectTimeZone !== false)].join("\u0000");
  const cached = timeProfileCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (environment.sshAutoDetectTimeZone === false) return { timeZone: environment.timeZone || "Africa/Nairobi", offset: environment.sshLogTimeOffset ?? "+03:00", timeZoneSource: "configured" };
  try {
    const group = await runAcrossServers(environment, TIME_PROFILE_SCRIPT, [], 10, undefined, true, signal);
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
    signal?.throwIfAborted();
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
  const match = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[.,]\d{3})\s+->\s+\|?(.*)\|$/.exec(line);
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
    "ecp.txn.trace": parts[8],
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

const searchSshApplicationLogs = async (environment: EnvironmentConfig, input: SearchInput, exportAll: boolean, signal?: AbortSignal): Promise<QueryResult> => {
  const application = selectedApplication(environment, input);
  const { offset } = await resolveSshTimeProfile(environment, signal);
  const days = daysInRange(input.startTime, input.endTime, offset).join(",");
  const start = Date.parse(input.startTime);
  const end = Date.parse(input.endTime);
  const limit = exportAll ? 20_000 : Math.min(input.page * input.pageSize + 1, 10_001);
  const group = await runAcrossServers(environment, LOG_SEARCH_SCRIPT, [
    applicationRoot(application), days,
    localTimestampBoundary(input.startTime, offset), localTimestampBoundary(input.endTime, offset), String(limit),
    input.level?.trim() ?? "", input.keyword?.trim() ?? "", input.file?.trim() ?? "", exportAll ? "FULL" : "PREVIEW"
  ], 120, undefined, true, signal);
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
  return { columns, rows, warnings: [...group.warnings, ...scanWarnings(group)] };
};

interface ConfiguredRow { values: Record<string, string>; file: string; raw: string }
const configuredRows = (raw: string): ConfiguredRow[] => raw.split(/\r?\n/).filter((line) => line.startsWith("@OPSLOG_ROW\t"))
  .map((line) => JSON.parse(line.slice("@OPSLOG_ROW\t".length)) as ConfiguredRow);

const configuredOutput = async (environment: EnvironmentConfig, input: SearchInput, kind: string, limit: number, signal?: AbortSignal): Promise<SshServerGroupResult> => {
  const application = selectedApplication(environment, input);
  const rules = (application.logSources ?? []).map((rule) => sshLogSourceSchema.parse(rule));
  const { offset } = await resolveSshTimeProfile(environment, signal);
  const session = limit < 20_000 ? snapshotSession(environment, input) : undefined;
  if (session && (input.page <= session.page || snapshotHasPage(session, input))) {
    session.page = Math.max(session.page, input.page);
    return { outputs: [...session.outputs.values()], warnings: [] };
  }
  const expectedPage = session?.page ?? 0;
  const filters = session ? { ...input, _snapshotPaging: true, _scanCursors: session.cursors } : input;
  const group = await runAcrossServers(environment, CONFIGURED_SCRIPT, [applicationRoot(application), daysInRange(input.startTime, input.endTime, offset).join(","),
    localTimestampBoundary(input.startTime, offset), localTimestampBoundary(input.endTime, offset), String(session ? input.pageSize + 1 : limit), kind, JSON.stringify(rules), JSON.stringify(filters)], 120, undefined, true, signal);
  if (!session) return group;
  if (group.warnings.length) throw new Error(`查询快照未完成：${group.warnings.join("；")}`);
  appendSnapshotOutputs(session, group.outputs, input.page, expectedPage);
  return { outputs: [...session.outputs.values()], warnings: [] };
};

const searchConfiguredLogs = async (environment: EnvironmentConfig, input: SearchInput, exportAll: boolean, signal?: AbortSignal): Promise<QueryResult> => {
  const application = selectedApplication(environment, input);
  const { offset } = await resolveSshTimeProfile(environment, signal);
  const limit = exportAll ? 20_000 : Math.min(input.page * input.pageSize + 1, 10_001);
  const group = await configuredOutput(environment, input, input.kind, limit, signal);
  const rows = group.outputs.flatMap(({ server, raw }) => configuredRows(raw).map(({ values: value, file, raw: content }) => {
    const timestamp = sourceIso(value.timestamp ?? "", offset);
    const row: Record<string, unknown> = { "opslog.source.application": application.name };
    if (input.kind === "transaction") {
      for (const [field, key] of Object.entries({ timestamp: "timestamp", id: "logId", no: "txnNo", business: "business", service: "service", node: "node", tenant: "tenant", trace: "traceId", "message.code": "messageCode", "message.info": "messageInfo" })) row[`ecp.txn.${field}`] = field === "timestamp" ? timestamp : value[key] ?? "";
      row["ecp.txn.duration"] = Number(value.duration) || 0;
      row["ecp.txn.server"] = server.name || server.host;
      row["ecp.txn.src.node.id"] = value.sourceNode ?? "";
    } else {
      Object.assign(row, { "@timestamp": timestamp, "ecp.log.timestamp": timestamp, "ecp.log.application": application.name, "ecp.log.file": file,
        "ecp.log.level": value.level ?? "", "ecp.log.thread": value.thread ?? "", message: value.message ?? content, "trace.id": value.traceId ?? "", "host.name": server.name || server.host });
    }
    return row;
  })).sort((a, b) => String(b[input.kind === "transaction" ? "ecp.txn.timestamp" : "ecp.log.timestamp"]).localeCompare(String(a[input.kind === "transaction" ? "ecp.txn.timestamp" : "ecp.log.timestamp"]))).slice(0, limit);
  const columns = input.kind === "transaction" ? TRANSACTION_COLUMNS : input.kind === "generic"
    ? ["@timestamp", "ecp.log.application", "ecp.log.level", "ecp.log.thread", "message", "trace.id", "host.name"]
    : ["ecp.log.timestamp", "ecp.log.application", "ecp.log.level", ...(input.kind === "ecp" ? ["ecp.log.file"] : []), "ecp.log.thread", "message", "trace.id", "host.name"];
  return { columns, rows, warnings: [...group.warnings, ...scanWarnings(group)] };
};

export const sampleSshLogs = async (environment: EnvironmentConfig, signal?: AbortSignal) => {
  const applications = environment.sshMonitoredApplications ?? [];
  if (!applications.length || applications.length > 20) throw new Error("请先配置应用目录映射（最多20项）");
  const servers = configuredServers(environment);
  const result = [];
  for (const application of applications) {
    const group = await runAcrossServers(environment, SAMPLE_SCRIPT, [applicationRoot(application)], 25, servers.slice(0, 4), true, signal);
    if (servers.length > 4) group.warnings.push("限量采样仅包含前4台服务器，请确认服务器组日志模板一致");
    result.push({ name: application.name, samples: group.outputs.map(({ server, raw }) => ({ server: server.name || server.host, files: raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as { path: string; size: number; content: string }) })), warnings: group.warnings });
  }
  return result;
};

export const searchSshLogs = async (environment: EnvironmentConfig, input: SearchInput, exportAll = false, signal?: AbortSignal): Promise<QueryResult> => {
  if (selectedApplication(environment, input).logSources?.some((source) => input.kind === "generic" || (input.kind === "transaction" ? source.role.startsWith("transaction") : source.role === input.kind))) return searchConfiguredLogs(environment, input, exportAll, signal);
  if (input.kind !== "transaction") return searchSshApplicationLogs(environment, input, exportAll, signal);
  const application = selectedApplication(environment, input);
  const { offset } = await resolveSshTimeProfile(environment, signal);
  const days = daysInRange(input.startTime, input.endTime, offset).join(",");
  const limit = exportAll ? 20_000 : Math.min(input.page * input.pageSize + 1, 10_001);
  const group = await runAcrossServers(environment, TRANSACTION_LIST_SCRIPT, [
    applicationRoot(application), days, localTimestampBoundary(input.startTime, offset), localTimestampBoundary(input.endTime, offset), String(limit),
    input.txnId?.trim() ?? "", input.txnNo?.trim() ?? "", input.business?.trim() ?? "", input.service?.trim() ?? "",
    input.node?.trim() ?? "", input.messageCode?.trim() ?? "", input.messageInfo?.trim() ?? "",
    String(input.minDurationMs ?? ""), input.status ?? "ALL"
  ], 120, undefined, true, signal);
  const parsedByServer = group.outputs.map(({ server, raw }) => ({
    server,
    rows: raw.split(/\r?\n/).map((line) => parseTransactionLine(line, server.name || server.host, offset))
      .filter((row): row is Record<string, unknown> => row !== undefined)
  }));
  const fallbackCandidates = parsedByServer.filter(({ rows }) => rows.length === 0);
  const fallbackGroup = fallbackCandidates.length ? await runAcrossServers(environment, TRANSACTION_SUMMARY_SCRIPT, [
      applicationRoot(application), days, input.txnId?.trim() ?? "", input.txnNo?.trim() ?? "",
      input.business?.trim() ?? "", input.service?.trim() ?? "", input.node?.trim() ?? "",
      input.messageCode?.trim() ?? "", input.messageInfo?.trim() ?? "",
      localTimestampBoundary(input.startTime, offset), localTimestampBoundary(input.endTime, offset), String(limit), String(input.minDurationMs ?? "")
    ], 120, fallbackCandidates.map(({ server }) => server), false, signal) : { outputs: [], warnings: [] };
  const warnings = [...group.warnings, ...scanWarnings(group), ...scanWarnings(fallbackGroup),
    ...fallbackGroup.warnings.map((warning) => `交易汇总查询失败：${warning}`)];
  const parsedRows = parsedByServer.flatMap(({ rows }) => rows);
  const detailRows = fallbackGroup.outputs.flatMap(({ server, raw }) => {
    const parsed = Number(raw.split(/\r?\n/, 1)[0]?.split("\t")[1]);
    if (!raw.startsWith("@OPSLOG_SUMMARY_PARSED\t") || !(parsed > 0)) {
      warnings.push(`${server.name || server.host}：交易汇总查询失败：未找到可解析的交易汇总日志；为避免全量扫描，已停止明细兜底查询`);
      return [];
    }
    return raw.split(/\r?\n/).map((line) => parseTransactionDetail(line, server.name || server.host, offset));
  })
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
  // A transaction resource is the exact ID-named file, never matching fragments
  // from configurable event/database sources (even when those share its MsgId).
  const { offset } = await resolveSshTimeProfile(environment);
  const days = daysInRange(startTime, endTime, offset).join(",");
  const group = await runAcrossServers(environment, TRANSACTION_CONTENT_SCRIPT, [applicationRoot(selected), id, days], 300);
  const content = group.outputs.filter(({ raw }) => raw.trim()).map(({ server, raw }) => `\n===== OPSLOG SERVER: ${server.name || server.host} =====\n${raw}`).join("\n");
  return group.warnings.length ? `${content}\n===== OPSLOG WARNING: 部分服务器查询失败：${group.warnings.join("；")} =====\n` : content;
};
