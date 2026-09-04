import { Router, type Response } from "express";
import { z } from "zod";
import { toCsv } from "./csv.js";
import { DISPLAY_FIELDS, type LogKind, type SearchInput } from "./domain.js";
import { findEnvironment, loadEnvironments, toPublicEnvironment } from "./environment-store.js";
import { runEsql } from "./kibana-client.js";
import { buildSearchQuery, buildTraceQuery, buildTrcQuery, pageRows } from "./query-builders.js";

const optionalText = z.string().trim().max(500).optional();
const dateTime = z.string().datetime({ offset: true });
const searchSchema = z.object({
  environment: z.string().trim().min(1).max(100),
  kind: z.enum(["transaction", "application", "ecp", "generic"]),
  startTime: dateTime,
  endTime: dateTime,
  page: z.coerce.number().int().min(1).max(200).default(1),
  pageSize: z.union([z.literal(50), z.literal(100), z.literal(500)]).default(50),
  index: optionalText,
  txnId: optionalText,
  traceId: optionalText,
  txnNo: optionalText,
  business: optionalText,
  service: optionalText,
  messageCode: optionalText,
  messageInfo: optionalText,
  status: z.enum(["ALL", "SUCCESS", "FAIL"]).optional(),
  minDurationMs: z.coerce.number().nonnegative().max(86_400_000).optional(),
  node: optionalText,
  keyword: optionalText,
  level: optionalText,
  file: optionalText,
  application: optionalText
}).superRefine((input, context) => {
  const start = Date.parse(input.startTime);
  const end = Date.parse(input.endTime);
  if (end <= start) {
    context.addIssue({ code: "custom", message: "结束时间必须晚于开始时间", path: ["endTime"] });
  }
  if (end - start > 31 * 24 * 60 * 60 * 1000) {
    context.addIssue({ code: "custom", message: "单次查询时间范围不能超过 31 天", path: ["endTime"] });
  }
});

const downloadSchema = z.object({
  environment: z.string().trim().min(1).max(100),
  id: z.string().trim().min(1).max(500),
  startTime: dateTime,
  endTime: dateTime
});

const asyncRoute = (
  handler: (request: Parameters<Router["get"]>[1] extends (...args: infer A) => unknown ? A[0] : never, response: Response) => Promise<void>
) => (request: Parameters<typeof handler>[0], response: Response, next: (error?: unknown) => void) => {
  handler(request, response).catch(next);
};

const filename = (prefix: string): string =>
  `${prefix}-${new Date().toISOString().replaceAll(":", "").replaceAll(".", "-")}`;

export const transactionLogFilename = (id: string): string => {
  const safeId = id
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .trim()
    .replace(/^[. ]+|[. ]+$/g, "")
    .slice(0, 180);
  return `${safeId || "transaction-log"}.trc`;
};

const trcText = (rows: Record<string, unknown>[]): string => rows.map((row) => {
  const timestamp = row["ecp.log.timestamp"] ?? "";
  const application = row["ecp.log.application"] ?? "";
  const level = row["ecp.log.level"] ?? "";
  const message = row.message ?? "";
  return `${timestamp} [${application}] [${level}] -> ${message}`;
}).join("\n");

export const apiRouter = Router();

apiRouter.get("/health", (_request, response) => {
  response.json({ status: "ok", version: "2.0.0" });
});

apiRouter.get("/environments", asyncRoute(async (_request, response) => {
  const environments = await loadEnvironments();
  response.json(environments.map(toPublicEnvironment));
}));

apiRouter.post("/search", asyncRoute(async (request, response) => {
  const input = searchSchema.parse(request.body) as SearchInput;
  const environment = await findEnvironment(input.environment);
  const query = buildSearchQuery(input, environment);
  const result = await runEsql(environment, query);
  const rows = pageRows(result.rows, input.page, input.pageSize);
  response.json({
    columns: DISPLAY_FIELDS[input.kind],
    rows,
    page: input.page,
    pageSize: input.pageSize,
    hasMore: result.rows.length >= input.page * input.pageSize,
    truncated: input.page * input.pageSize >= 10_000,
    queryTime: new Date().toISOString()
  });
}));

apiRouter.post("/export", asyncRoute(async (request, response) => {
  const input = searchSchema.parse({ ...request.body, page: 1 }) as SearchInput;
  const environment = await findEnvironment(input.environment);
  const result = await runEsql(environment, buildSearchQuery(input, environment, true), 300_000);
  const columns = DISPLAY_FIELDS[input.kind];
  response
    .status(200)
    .setHeader("Content-Type", "text/csv; charset=utf-8")
    .setHeader("Content-Disposition", `attachment; filename="${filename(input.kind)}.csv"`)
    .setHeader("X-OpsLog-Truncated", String(result.rows.length >= 20_000))
    .send(toCsv(columns, result.rows));
}));

apiRouter.post("/transaction-log", asyncRoute(async (request, response) => {
  const input = downloadSchema.parse(request.body);
  const environment = await findEnvironment(input.environment);
  const result = await runEsql(
    environment,
    buildTrcQuery(environment, input.id, input.startTime, input.endTime),
    300_000
  );
  response
    .status(200)
    .setHeader("Content-Type", "text/plain; charset=utf-8")
    .setHeader("Content-Disposition", `attachment; filename="${transactionLogFilename(input.id)}"`)
    .send(trcText(result.rows));
}));

apiRouter.post("/transaction-log/content", asyncRoute(async (request, response) => {
  const input = downloadSchema.parse(request.body);
  const environment = await findEnvironment(input.environment);
  const result = await runEsql(
    environment,
    buildTrcQuery(environment, input.id, input.startTime, input.endTime),
    300_000
  );
  response.json({ id: input.id, content: trcText(result.rows) });
}));

apiRouter.post("/trace", asyncRoute(async (request, response) => {
  const input = downloadSchema.parse(request.body);
  const environment = await findEnvironment(input.environment);
  const result = await runEsql(
    environment,
    buildTraceQuery(environment, input.id, input.startTime, input.endTime),
    300_000
  );
  response.json({ traceId: input.id, rows: result.rows });
}));

export const errorHandler = (error: unknown, _request: unknown, response: Response, _next: unknown): void => {
  if (error instanceof z.ZodError) {
    response.status(400).json({ error: "查询条件不合法", details: z.flattenError(error).fieldErrors });
    return;
  }
  const message = error instanceof Error ? error.message : "未知服务端错误";
  const isConfigurationError = message.startsWith("未知环境") || message.includes("索引");
  response.status(isConfigurationError ? 400 : 502).json({ error: message });
};
