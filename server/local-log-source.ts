import { realpath, stat } from "node:fs/promises";
import { contained, discover, fileIdentity, reverseRecords, safeOpen, sampleRecords, type LocalFile } from "./local-file-reader.js";
import path from "node:path";
import { DISPLAY_FIELDS, type EnvironmentConfig, type SearchInput, type QueryResult } from "./domain.js";
import { defaultSshLogSources } from "../shared/ssh-log-defaults.js";
import { globToFileRegex } from "../shared/ssh-file-patterns.js";
import { splitSummaryFields, type SshAnalysisSample } from "../shared/ssh-ai-samples.js";
import type { SshLogSource } from "../shared/ssh-log-rules.js";

interface Snapshot { created: number; key: string; files: LocalFile[] }
const sessions = new Map<string, Snapshot>();
const selectedApplication = (environment: EnvironmentConfig, name?: string) => {
  const applications = environment.sshMonitoredApplications ?? [];
  const application = name ? applications.find(item => item.name === name) : applications.length === 1 ? applications[0] : undefined;
  if (!application) throw new Error("请选择已配置的本地应用");
  return application;
};

const offsetMillis = (offset: string) => { const match = /^([+-])(\d{2}):(\d{2})$/.exec(offset); if (!match) throw new Error("日志 UTC 偏移无效"); return (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) * 60_000; };
const daysInRange = (start: string, end: string, offset: string): Set<string> => {
  if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(end) <= Date.parse(start) || Date.parse(end) - Date.parse(start) > 31 * 86_400_000) throw new Error("查询时间范围须在 31 天内");
  const shift = offsetMillis(offset), days = new Set<string>();
  for (let day = Math.floor((Date.parse(start) + shift) / 86_400_000); day <= Math.floor((Date.parse(end) + shift) / 86_400_000); day++) days.add(new Date(day * 86_400_000).toISOString().slice(8, 10));
  return days;
};
const timeValue = (value: string, source: SshLogSource, input: SearchInput, offset: string): number => {
  const normalized = value.replace(",", ".").replace(" ", "T");
  if (source.timestampStyle === "full") return Date.parse(`${normalized}${offset}`);
  const end = new Date(Date.parse(input.endTime) + offsetMillis(offset)).getUTCFullYear();
  const candidates = [end - 1, end, end + 1].map(year => Date.parse(`${year}-${normalized}${offset}`));
  return candidates.sort((a, b) => Math.abs(a - Date.parse(input.endTime)) - Math.abs(b - Date.parse(input.endTime)))[0]!;
};
const includes = (value: unknown, filter?: string) => !filter?.trim() || String(value ?? "").includes(filter.trim());
const sortRows = (rows: Record<string, unknown>[], input: SearchInput): void => {
  const fields = input.kind === "transaction" ? ["ecp.txn.timestamp", "ecp.txn.id", "ecp.txn.service"] : ["@timestamp"];
  rows.sort((a, b) => {
    for (const field of fields) { const left = String(a[field] ?? ""), right = String(b[field] ?? ""); if (left !== right) return left < right ? 1 : -1; }
    return 0;
  });
};

export async function searchLocalLogs(environment: EnvironmentConfig, input: SearchInput, exportAll = false, signal?: AbortSignal): Promise<QueryResult> {
  if (environment.sourceType !== "local") throw new Error("仅支持 Local 环境");
  const app = selectedApplication(environment, input.application), offset = environment.sshLogTimeOffset ?? "+03:00";
  const key = JSON.stringify({ environment, input: { ...input, page: 0, sessionId: undefined, requestId: undefined } });
  for (const [id, value] of sessions) if (Date.now() - value.created > 30 * 60_000) sessions.delete(id);
  let snapshot = input.sessionId && !exportAll ? sessions.get(input.sessionId) : undefined;
  if (snapshot && snapshot.key !== key) throw new Error("查询条件已变更，请重新查询首页");
  if (!snapshot) {
    if (input.sessionId && input.page > 1 && !exportAll) throw new Error("查询会话已失效，请重新查询首页");
    snapshot = { key, created: Date.now(), files: await discover(app.directory, signal) };
    if (input.sessionId && !exportAll) { if (sessions.size >= 32) sessions.delete(sessions.keys().next().value!); sessions.set(input.sessionId, snapshot); }
  }
  const days = daysInRange(input.startTime, input.endTime, offset), limit = exportAll ? 20_000 : Math.min(input.page * input.pageSize + 1, 10_001);
  const allSources = app.logSources?.length ? app.logSources : defaultSshLogSources();
  const sources = allSources.filter(source => input.kind === "transaction" ? ["transaction", "transactionEvent"].includes(source.role) : input.kind === "generic" ? source.role !== "detail" : source.role === input.kind);
  const rows: Record<string, unknown>[] = [];
  const warnings: string[] = [];
  for (const source of [...sources].sort((a, b) => Number(!!a.fallbackOnly) - Number(!!b.fallbackOnly))) {
    if (source.fallbackOnly && rows.length) continue;
    const patterns = source.paths.map(value => new RegExp(`^(?:${(source.pathMode === "regex" ? value : globToFileRegex(value, false)).replaceAll("{day}", `(?:${[...days].join("|")})`)})$`));
    const files = snapshot.files.filter(file => patterns.some(pattern => pattern.test(file.relative))).slice(0, source.fileSelection === "latest" ? 1 : undefined);
    const extractors = Object.entries(source.fields).map(([field, mapping]) => [field, mapping.regex ? new RegExp(mapping.regex) : mapping.index!] as const);
    const success = new RegExp(source.successPattern), eventRows = new Map<string, Record<string, unknown>>();
    for (const file of files) {
      let count = 0, older = 0, scanned = 0, boundaryTime: number | undefined, beyondBoundary = 0;
      for await (const raw of reverseRecords(app.directory, file, source.recordEnd, signal)) {
        signal?.throwIfAborted();
        if (++scanned % 256 === 0) await new Promise<void>(resolve => setImmediate(resolve));
        const fields = splitSummaryFields(raw, source.delimiter), values: Record<string, string> = {};
        for (const [field, extractor] of extractors) values[field] = (typeof extractor === "number" ? fields[extractor] : extractor.exec(raw)?.[1])?.trim() ?? "";
        const time = timeValue(values.timestamp ?? "", source, input, offset);
        if (!Number.isFinite(time)) continue;
        if (boundaryTime !== undefined) { if (time < boundaryTime) { if (++beyondBoundary >= 64) break; } else beyondBoundary = 0; }
        if (time < Date.parse(input.startTime)) { if (source.ordered && ++older >= 64) break; continue; }
        older = 0;
        if (time > Date.parse(input.endTime)) continue;
        const transaction = input.kind === "transaction", id = source.stripAsyncSuffix ? values.logId?.replace(/-\d+$/, "") : values.logId;
        if (transaction && !id) continue;
        const row: Record<string, unknown> = transaction ? {
          "ecp.txn.timestamp": new Date(time).toISOString(), "ecp.txn.id": id, "ecp.txn.no": values.txnNo,
          "ecp.txn.business": values.business, "ecp.txn.service": values.service, "ecp.txn.node": values.node,
          "ecp.txn.src.node.id": values.sourceNode, "ecp.txn.tenant": values.tenant, "ecp.txn.trace": values.traceId,
          "ecp.txn.duration": Number(values.duration) || 0, "ecp.txn.message.code": values.messageCode,
          "ecp.txn.message.info": values.messageInfo, "ecp.txn.server": "Local"
        } : {
          "ecp.log.timestamp": new Date(time).toISOString(), "@timestamp": new Date(time).toISOString(),
          "ecp.log.application": values.node || app.name, "ecp.log.level": values.level, "ecp.log.thread": values.thread,
          "ecp.log.file": file.relative, "message": values.message || raw, "trace.id": values.traceId, "host.name": "Local"
        };
        row["opslog.source.application"] = app.name;
        if (transaction && source.role === "transactionEvent") {
          const previous = eventRows.get(id!);
          if (previous) { for (const [field, value] of Object.entries(row)) if (!previous[field] && value) previous[field] = value; previous["ecp.txn.duration"] = Math.max(Number(previous["ecp.txn.duration"]), Number(row["ecp.txn.duration"])); continue; }
          eventRows.set(id!, row);
          if (eventRows.size > 100_000) throw new Error("交易事件超过 100000，请缩小时间范围");
        } else {
          if (!matches(row, input, success)) continue;
          rows.push(row); count++;
          if (source.ordered && count >= limit && boundaryTime === undefined) boundaryTime = time;
        }
        // Bound retained matches for unordered sources without truncating scans.
        if (rows.length > limit * 2) { sortRows(rows, input); rows.length = limit; }
      }
    }
    for (const row of eventRows.values()) if (matches(row, input, success)) rows.push(row);
  }
  sortRows(rows, input);
  return { columns: DISPLAY_FIELDS[input.kind], rows: rows.slice(0, limit), warnings };
}

function matches(row: Record<string, unknown>, input: SearchInput, success: RegExp): boolean {
  if (input.kind !== "transaction") return includes(row["ecp.log.level"], input.level) && includes(row["ecp.log.file"], input.file) && includes(row.message, input.keyword);
  const filters = { "ecp.txn.id": input.txnId, "ecp.txn.no": input.txnNo, "ecp.txn.trace": input.traceId, "ecp.txn.business": input.business, "ecp.txn.service": input.service, "ecp.txn.node": input.node, "ecp.txn.message.code": input.messageCode, "ecp.txn.message.info": input.messageInfo };
  if (Object.entries(filters).some(([field, filter]) => !includes(row[field], filter))) return false;
  const code = String(row["ecp.txn.message.code"] ?? "");
  if (input.status === "SUCCESS" && (!code || !success.test(code))) return false;
  if (input.status === "FAIL" && (!code || success.test(code))) return false;
  return Number(row["ecp.txn.duration"]) >= (input.minDurationMs ?? 0);
}

export async function readLocalTransactionLog(environment: EnvironmentConfig, id: string, start: string, end: string, application?: string): Promise<string> {
  if (environment.sourceType !== "local") throw new Error("仅支持 Local 环境");
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === "..") throw new Error("日志 ID 不合法");
  const app = selectedApplication(environment, application), root = await realpath(app.directory);
  const contents: string[] = [];
  for (const day of daysInRange(start, end, environment.sshLogTimeOffset ?? "+03:00")) {
    const absolute = path.join(root, "trc", day, `${id}.trc`);
    let info; try { info = await stat(absolute); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (!info.isFile() || !contained(root, await realpath(absolute))) throw new Error("明细日志路径超出应用目录");
    if (info.size > 32 * 1024 * 1024) throw new Error("明细日志超过 32 MB，请缩小文件后重试");
    const handle = await safeOpen(root, { absolute, relative: `trc/${day}/${id}.trc`, size: info.size, modified: info.mtimeMs, identity: fileIdentity(info) });
    try {
      const buffer = Buffer.alloc(info.size);
      let position = 0;
      while (position < buffer.length) { const read = await handle.read(buffer, position, buffer.length - position, position); if (!read.bytesRead) throw new Error("明细日志已截断，请重试"); position += read.bytesRead; }
      contents.push(`===== OPSLOG SOURCE: trc/${day}/${id}.trc =====\n${buffer.toString("utf8")}`);
    } finally { await handle.close(); }
  }
  if (!contents.length) throw new Error(`未找到明细日志：${id}（文件可能已清理）`);
  return contents.join("\n");
}

export async function sampleLocalLogs(environment: EnvironmentConfig, signal?: AbortSignal): Promise<SshAnalysisSample[]> {
  if (environment.sourceType !== "local") throw new Error("仅支持 Local 环境");
  const collected: SshAnalysisSample[] = [];
  for (const app of environment.sshMonitoredApplications ?? []) {
    const files = await discover(app.directory, signal), summary = files.find(file => file.relative.endsWith(".lst"));
    const candidates = [summary, ...files.filter(file => /\.(?:log|trc)$/.test(file.relative))].filter((file): file is LocalFile => !!file).slice(0, 6);
    const samples = [];
    for (const file of candidates) {
      const records = await sampleRecords(app.directory, file, signal);
      const content = records.join("\n").replace(/((?:password|passwd|authorization|secret|token)["']?\s*[=:]\s*["']?)[^"'\s,|}]+/gi, "$1[REDACTED]");
      if (content.length > 120_000) throw new Error(`采样记录超过输入预算：${app.name} / ${file.relative}`);
      samples.push({ path: file.relative, size: file.size, modifiedAt: file.modified / 1000, summarySelected: file === summary, content });
    }
    collected.push({ name: app.name, samples: [{ server: "Local", files: samples }], warnings: summary ? [] : ["未找到 .lst 汇总文件"] });
  }
  return collected;
}
