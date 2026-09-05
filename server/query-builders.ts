import { DISPLAY_FIELDS, type EnvironmentConfig, type LogKind, type SearchInput } from "./domain.js";

const INDEX_PATTERN = /^[a-zA-Z0-9._,*-]+$/;
const MAX_PAGE_DEPTH = 10_000;

const literal = (value: string): string =>
  value.trim().replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", " ");

const index = (value: string): string => {
  if (!INDEX_PATTERN.test(value)) {
    throw new Error("索引名称包含不允许的字符");
  }
  return value;
};

const timeRange = (field: string, input: SearchInput): string =>
  `${field} >= "${literal(input.startTime)}" AND ${field} < "${literal(input.endTime)}"`;

const addLike = (conditions: string[], field: string, value?: string): void => {
  if (value?.trim()) conditions.push(`${field} LIKE "*${literal(value)}*"`);
};

const addExactOrLike = (
  conditions: string[],
  field: string,
  value: string | undefined,
  looksComplete: (candidate: string) => boolean
): void => {
  if (!value?.trim()) return;
  const normalized = literal(value);
  conditions.push(looksComplete(value.trim()) ? `${field} == "${normalized}"` : `${field} LIKE "*${normalized}*"`);
};

const fullTransactionId = (value: string): boolean => value.length >= 24 && /\.[puds]_\d+_/i.test(value);
const fullTraceId = (value: string): boolean => /^[a-f\d]{16,64}$/i.test(value);

const resolveIndex = (input: SearchInput, environment: EnvironmentConfig): string => {
  if (input.kind === "transaction") return index(environment.txnlstIndex);
  if (input.kind === "application" || input.kind === "ecp") return index(environment.applogIndex);
  if (!input.index) throw new Error("通用日志必须选择索引");

  const allowed = new Set([
    environment.txnlstIndex,
    environment.txntrcIndex,
    environment.applogIndex,
    environment.apmIndex ?? "traces-apm*"
  ]);
  if (!allowed.has(input.index)) throw new Error("该索引未在当前环境中配置");
  return index(input.index);
};

const buildTransactionConditions = (input: SearchInput): string[] => {
  // UAT writes the ingestion time reliably, but leaves ecp.txn.timestamp empty on
  // some transaction documents. The Java client has always used @timestamp here.
  const conditions = [timeRange("@timestamp", input)];
  addExactOrLike(conditions, "ecp.txn.id", input.txnId, fullTransactionId);
  addExactOrLike(conditions, "ecp.txn.trace", input.traceId, fullTraceId);
  addLike(conditions, "ecp.txn.no", input.txnNo);
  addLike(conditions, "ecp.txn.business", input.business);
  addLike(conditions, "ecp.txn.service", input.service);
  addLike(conditions, "ecp.txn.message.code", input.messageCode);
  addLike(conditions, "ecp.txn.message.info", input.messageInfo);
  addLike(conditions, "ecp.txn.node", input.node);

  if (input.status === "SUCCESS") conditions.push('RIGHT(ecp.txn.message.code, 5) == "00000"');
  if (input.status === "FAIL") conditions.push('RIGHT(ecp.txn.message.code, 5) != "00000"');
  if (input.minDurationMs && input.minDurationMs > 0) {
    conditions.push(`TO_INTEGER(ecp.txn.duration) >= ${Math.floor(input.minDurationMs)}`);
  }
  return conditions;
};

const buildLogConditions = (input: SearchInput): string[] => {
  const timestamp = input.kind === "generic" ? "@timestamp" : "ecp.log.timestamp";
  const conditions = [timeRange(timestamp, input)];
  addLike(conditions, "ecp.log.application", input.application);
  addLike(conditions, "ecp.log.level", input.level);
  if (input.kind === "ecp") addLike(conditions, "ecp.log.file", input.file);

  if (input.keyword?.trim()) {
    const fields = input.kind === "generic"
      ? ["message", "ecp.log.application", "ecp.log.thread", "trace.id"]
      : ["message", "ecp.log.thread", "trace.id", "host.name"];
    const keywordConditions = fields.map((field) => `${field} LIKE "*${literal(input.keyword!)}*"`);
    conditions.push(`(${keywordConditions.join(" OR ")})`);
  }
  return conditions;
};

export const buildSearchQuery = (
  input: SearchInput,
  environment: EnvironmentConfig,
  exportAll = false
): string => {
  const source = resolveIndex(input, environment);
  const conditions = input.kind === "transaction"
    ? buildTransactionConditions(input)
    : buildLogConditions(input);
  const timestamp = input.kind === "generic" ? "@timestamp" : "ecp.log.timestamp";
  const limit = exportAll
    ? 20_000
    : Math.min(input.page * input.pageSize, MAX_PAGE_DEPTH);
  const keep = DISPLAY_FIELDS[input.kind].join(", ");

  if (input.kind === "transaction") {
    // Keep the familiar business-time column populated when legacy UAT records
    // contain only the canonical ingest timestamp.
    return `FROM ${source} | WHERE ${conditions.join(" AND ")} | SORT @timestamp DESC | LIMIT ${limit} | EVAL ecp.txn.timestamp = COALESCE(ecp.txn.timestamp, @timestamp) | KEEP ${keep}`;
  }

  return `FROM ${source} | WHERE ${conditions.join(" AND ")} | SORT ${timestamp} DESC | LIMIT ${limit} | KEEP ${keep}`;
};

export const buildTrcQuery = (
  environment: EnvironmentConfig,
  logId: string,
  startTime: string,
  endTime: string
): string => {
  const source = index(environment.txntrcIndex);
  return `FROM ${source} | WHERE @timestamp >= "${literal(startTime)}" AND @timestamp < "${literal(endTime)}" AND ecp.log.id == "${literal(logId)}" | SORT ecp.log.timestamp ASC | LIMIT 20000 | KEEP ecp.log.timestamp, ecp.log.application, ecp.log.level, message`;
};

export const buildTraceQuery = (
  environment: EnvironmentConfig,
  traceId: string,
  startTime: string,
  endTime: string
): string => {
  const source = index(environment.apmIndex ?? "traces-apm*");
  return `FROM ${source} | WHERE trace.id == "${literal(traceId)}" AND @timestamp >= "${literal(startTime)}" AND @timestamp < "${literal(endTime)}" | SORT @timestamp ASC | LIMIT 20000 | KEEP @timestamp, trace.id, span.*, transaction.*, processor.event, service.*`;
};

export const pageRows = <T>(rows: T[], page: number, pageSize: number): T[] => {
  const start = Math.max(0, page - 1) * pageSize;
  return rows.slice(start, start + pageSize);
};
