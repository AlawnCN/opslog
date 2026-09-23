import { Router, type Response } from "express";
import { z } from "zod";
import { toCsv } from "./csv.js";
import { DISPLAY_FIELDS, type EnvironmentConfig, type LogKind, type QueryResult, type SearchInput } from "./domain.js";
import { findEnvironment, loadEnvironments, saveEnvironmentConfig, toPublicEnvironment } from "./environment-store.js";
import { runEsql } from "./kibana-client.js";
import { buildSearchQuery, buildSearchQueryWithOmittedFields, buildTraceQuery, buildTrcQuery, logKeywordFields, pageRows } from "./query-builders.js";
import { analyzeLogSchema, analyzeLogWithAi, isAiStreamingEnabled } from "./ai-analysis.js";
import { activateAiProfile, deleteAiProfile, loadAiConfiguration, saveAiProfile, saveAiProfileSchema } from "./ai-configuration.js";
import { discoverAiModels, discoverAiModelsSchema } from "./ai-models.js";
import { readSshTransactionLog, resolveSshTimeProfile, searchSshLogs } from "./ssh-log-source.js";

const optionalText = z.string().trim().max(500).optional();
const dateTime = z.string().datetime({ offset: true });

const unknownColumns = (error: unknown): string[] => error instanceof Error
  ? [...error.message.matchAll(/unknown column \[([^\]]+)\]/gi)].map((match) => match[1]!.trim())
  : [];

const constrainedFields = (input: SearchInput): Set<string> => {
  const fields = new Set([input.kind === "generic" || input.kind === "transaction" ? "@timestamp" : "ecp.log.timestamp"]);
  const add = (field: string, value: unknown): void => { if (String(value ?? "").trim()) fields.add(field); };
  if (input.kind === "transaction") {
    add("ecp.txn.id", input.txnId);
    add("ecp.txn.trace", input.traceId);
    add("ecp.txn.no", input.txnNo);
    add("ecp.txn.business", input.business);
    add("ecp.txn.service", input.service);
    add("ecp.txn.message.code", input.messageCode);
    add("ecp.txn.message.info", input.messageInfo);
    add("ecp.txn.node", input.node);
    if (input.status && input.status !== "ALL") fields.add("ecp.txn.message.code");
    if (input.minDurationMs && input.minDurationMs > 0) fields.add("ecp.txn.duration");
    return fields;
  }
  add("ecp.log.application", input.application);
  add("ecp.log.level", input.level);
  if (input.kind === "ecp") add("ecp.log.file", input.file);
  return fields;
};

const availableColumns = (input: SearchInput, omitted: ReadonlySet<string>): string[] =>
  DISPLAY_FIELDS[input.kind].filter((field) => !omitted.has(field));

const searchElkLogs = async (environment: EnvironmentConfig, input: SearchInput, exportAll = false): Promise<QueryResult> => {
  const omitted = new Set<string>();
  const required = constrainedFields(input);
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const columns = availableColumns(input, omitted);
    if (!columns.length || (input.kind !== "transaction" && input.keyword?.trim() && logKeywordFields(input.kind).every((field) => omitted.has(field)))) return { columns, rows: [] };
    try {
      const query = omitted.size
        ? buildSearchQueryWithOmittedFields(input, environment, exportAll, omitted)
        : buildSearchQuery(input, environment, exportAll);
      return await runEsql(environment, query, exportAll ? 300_000 : 120_000);
    } catch (error) {
      const missing = unknownColumns(error);
      if (!missing.length) throw error;
      let learned = false;
      for (const field of missing) {
        if (!omitted.has(field)) learned = true;
        omitted.add(field);
      }
      const columns = availableColumns(input, omitted);
      if (!learned || missing.some((field) => required.has(field))) return { columns, rows: [] };
    }
  }
  return { columns: availableColumns(input, omitted), rows: [] };
};
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
  endTime: dateTime,
  application: optionalText
});

const environmentImportSchema = z.object({
  contents: z.string().min(2).max(256 * 1024)
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

apiRouter.get("/runtime", (_request, response) => {
  response.json({ mode: "standalone", canImportConfig: true });
});

apiRouter.get("/environments", asyncRoute(async (_request, response) => {
  const environments = await loadEnvironments();
  response.json(await Promise.all(environments.map(async (environment) => {
    if (environment.sourceType !== "ssh") return toPublicEnvironment(environment);
    const profile = await resolveSshTimeProfile(environment);
    return toPublicEnvironment(environment, {
      timeZone: profile.timeZone,
      timeZoneOffset: profile.offset,
      timeZoneSource: profile.timeZoneSource
    });
  })));
}));

apiRouter.get("/environments/configuration", asyncRoute(async (_request, response) => {
  response.json(await loadEnvironments());
}));

apiRouter.get("/ai/configuration", asyncRoute(async (_request, response) => {
  response.json(await loadAiConfiguration());
}));

apiRouter.post("/ai/configuration", asyncRoute(async (request, response) => {
  response.json(await saveAiProfile(saveAiProfileSchema.parse(request.body)));
}));

apiRouter.post("/ai/configuration/active", asyncRoute(async (request, response) => {
  const { id } = z.object({ id: z.string().min(1).max(100) }).parse(request.body);
  response.json(await activateAiProfile(id));
}));

apiRouter.delete("/ai/configuration/:id", asyncRoute(async (request, response) => {
  const { id } = z.object({ id: z.string().min(1).max(100) }).parse(request.params);
  response.json(await deleteAiProfile(id));
}));

apiRouter.post("/ai/models", asyncRoute(async (request, response) => {
  response.json(await discoverAiModels(discoverAiModelsSchema.parse(request.body)));
}));

apiRouter.post("/ai/analyze", (request, response, next) => {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  request.once("aborted", abort);
  response.once("close", abort);
  void (async () => {
    const input = analyzeLogSchema.parse(request.body);
    if (!await isAiStreamingEnabled()) {
      const result = await analyzeLogWithAi(input, undefined, controller.signal);
      if (!response.destroyed) response.json(result);
      return;
    }
    response.status(200);
    response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders();
    const send = (event: unknown): void => {
      if (!response.destroyed && !response.writableEnded) response.write(`${JSON.stringify(event)}\n`);
    };
    try {
      const result = await analyzeLogWithAi(input, (content) => send({ type: "chunk", content }), controller.signal);
      send({ type: "done", result });
    } catch (error) {
      if (!controller.signal.aborted) send({ type: "error", error: error instanceof Error ? error.message : "AI 分析失败" });
    } finally {
      if (!response.destroyed && !response.writableEnded) response.end();
    }
  })().catch((error) => {
    if (!controller.signal.aborted) next(error);
  }).finally(() => {
    request.off("aborted", abort);
    response.off("close", abort);
  });
});

apiRouter.post("/environments/import", asyncRoute(async (request, response) => {
  const { contents } = environmentImportSchema.parse(request.body);
  const path = await saveEnvironmentConfig(contents);
  response.json({ path });
}));

apiRouter.post("/search", asyncRoute(async (request, response) => {
  const input = searchSchema.parse(request.body) as SearchInput;
  const environment = await findEnvironment(input.environment);
  const result = environment.sourceType === "ssh"
    ? await searchSshLogs(environment, input)
    : await searchElkLogs(environment, input);
  const rows = pageRows(result.rows, input.page, input.pageSize);
  response.json({
    columns: result.columns.length ? result.columns : DISPLAY_FIELDS[input.kind],
    rows,
    warnings: result.warnings ?? [],
    page: input.page,
    pageSize: input.pageSize,
    hasMore: input.page * input.pageSize < 10_000 && (environment.sourceType === "ssh"
      ? result.rows.length > input.page * input.pageSize
      : result.rows.length >= input.page * input.pageSize),
    truncated: input.page * input.pageSize >= 10_000,
    queryTime: new Date().toISOString()
  });
}));

apiRouter.post("/export", asyncRoute(async (request, response) => {
  const input = searchSchema.parse({ ...request.body, page: 1 }) as SearchInput;
  const environment = await findEnvironment(input.environment);
  const result = environment.sourceType === "ssh"
    ? await searchSshLogs(environment, input, true)
    : await searchElkLogs(environment, input, true);
  if (result.warnings?.length) throw new Error(`部分服务器查询失败，已取消导出以避免生成不完整文件：${result.warnings.join("；")}`);
  const columns = result.columns.length ? result.columns : DISPLAY_FIELDS[input.kind];
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
  if (environment.sourceType === "ssh") {
    const content = await readSshTransactionLog(environment, input.id, input.startTime, input.endTime, input.application);
    response.status(200).setHeader("Content-Type", "text/plain; charset=utf-8").setHeader("Content-Disposition", `attachment; filename="${transactionLogFilename(input.id)}"`).send(content);
    return;
  }
  const result = await runEsql(environment, buildTrcQuery(environment, input.id, input.startTime, input.endTime), 300_000);
  response
    .status(200)
    .setHeader("Content-Type", "text/plain; charset=utf-8")
    .setHeader("Content-Disposition", `attachment; filename="${transactionLogFilename(input.id)}"`)
    .send(trcText(result.rows));
}));

apiRouter.post("/transaction-log/content", asyncRoute(async (request, response) => {
  const input = downloadSchema.parse(request.body);
  const environment = await findEnvironment(input.environment);
  if (environment.sourceType === "ssh") {
    const content = await readSshTransactionLog(environment, input.id, input.startTime, input.endTime, input.application);
    response.json({ id: input.id, content });
    return;
  }
  const result = await runEsql(environment, buildTrcQuery(environment, input.id, input.startTime, input.endTime), 300_000);
  response.json({ id: input.id, content: trcText(result.rows) });
}));

apiRouter.post("/trace", asyncRoute(async (request, response) => {
  const input = downloadSchema.parse(request.body);
  const environment = await findEnvironment(input.environment);
  if (environment.sourceType === "ssh") throw new Error("SSH 直连环境不提供 APM Trace 调用链");
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
  const isConfigurationError = message.startsWith("未知环境") || message.startsWith("环境配置") || message.includes("索引");
  response.status(isConfigurationError ? 400 : 502).json({ error: message });
};
