export type TraceCategory = "transaction" | "db" | "http" | "redis" | "rpc" | "application";

export interface TraceNode {
  key: string;
  id: string;
  parentId: string;
  name: string;
  service: string;
  category: TraceCategory;
  startMs: number;
  durationMs: number;
  endMs: number;
  detail?: string;
  children: TraceNode[];
  row: Record<string, unknown>;
}

export interface VisibleTraceNode { node: TraceNode; depth: number; }

export interface TraceModel {
  roots: TraceNode[];
  nodes: TraceNode[];
  startMs: number;
  durationMs: number;
  maximumDurationMs: number;
  services: number;
}

const value = (row: Record<string, unknown>, ...names: string[]): string => {
  for (const name of names) {
    const candidate = row[name];
    if (candidate != null && String(candidate).trim()) return String(candidate);
  }
  return "";
};

const durationMs = (row: Record<string, unknown>): number => {
  const raw = row["event.duration"] ?? row["span.duration.us"] ?? row["transaction.duration.us"] ?? 0;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return row["event.duration"] != null ? numeric / 1_000_000 : numeric / 1000;
};

const sqlDetail = (row: Record<string, unknown>): string => value(row, "span.db.statement", "db.statement", "span.context.db.statement", "span.context.db.stmt");

const requestDetail = (row: Record<string, unknown>): string => {
  const method = value(row, "http.request.method", "span.context.http.request.method");
  const url = value(row, "url.full", "url.original", "http.url", "span.context.http.url.original");
  return [method, url].filter(Boolean).join(" ");
};

const categoryOf = (row: Record<string, unknown>): TraceCategory => {
  const type = value(row, "span.type", "span.subtype", "processor.event", "transaction.type").toLowerCase();
  const name = value(row, "span.name", "transaction.name").toLowerCase();
  if (sqlDetail(row) || type.includes("db") || name.includes("sql")) return "db";
  if (type.includes("redis") || name.includes("redis")) return "redis";
  if (type.includes("http") || type.includes("external") || name.startsWith("http")) return "http";
  if (type.includes("rpc") || name.includes("rpc")) return "rpc";
  if (value(row, "processor.event").toLowerCase() === "transaction") return "transaction";
  return "application";
};

const detailOf = (row: Record<string, unknown>): string | undefined => {
  const detail = sqlDetail(row) || requestDetail(row) || value(row, "error.exception.message", "error.message", "message");
  return detail || undefined;
};

const startTime = (row: Record<string, unknown>, index: number): number => {
  const parsed = Date.parse(value(row, "@timestamp"));
  return Number.isFinite(parsed) ? parsed : index;
};

const sortNodes = (nodes: TraceNode[]): void => {
  nodes.sort((left, right) => left.startMs - right.startMs || right.durationMs - left.durationMs);
  nodes.forEach(({ children }) => sortNodes(children));
};

export const buildTraceModel = (rows: Record<string, unknown>[]): TraceModel => {
  const nodes = rows.map((row, index): TraceNode => {
    const duration = durationMs(row);
    const start = startTime(row, index);
    const id = value(row, "span.id", "transaction.id");
    return {
      key: id ? `${id}:${index}` : `trace-node:${index}`,
      id,
      parentId: value(row, "parent.id", "span.parent.id", "transaction.parent.id"),
      name: value(row, "span.name", "transaction.name", "name") || "未命名 Span",
      service: value(row, "service.name", "service.node.name") || "unknown",
      category: categoryOf(row),
      startMs: start,
      durationMs: duration,
      endMs: start + duration,
      detail: detailOf(row),
      children: [],
      row
    };
  });
  const byId = new Map(nodes.filter(({ id }) => id).map((node) => [node.id, node]));
  const roots: TraceNode[] = [];
  for (const node of nodes) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent && parent !== node) parent.children.push(node); else roots.push(node);
  }
  sortNodes(roots);
  const start = nodes.length ? Math.min(...nodes.map(({ startMs }) => startMs)) : 0;
  const end = nodes.length ? Math.max(...nodes.map(({ endMs }) => endMs)) : start;
  return {
    roots,
    nodes,
    startMs: start,
    durationMs: Math.max(1, end - start),
    maximumDurationMs: Math.max(0, ...nodes.map(({ durationMs: spanDuration }) => spanDuration)),
    services: new Set(nodes.map(({ service }) => service).filter((service) => service !== "unknown")).size
  };
};

export const flattenTraceTree = (roots: TraceNode[], collapsed: ReadonlySet<string>): VisibleTraceNode[] => {
  const visible: VisibleTraceNode[] = [];
  const visit = (node: TraceNode, depth: number) => {
    visible.push({ node, depth });
    if (!collapsed.has(node.key)) node.children.forEach((child) => visit(child, depth + 1));
  };
  roots.forEach((root) => visit(root, 0));
  return visible;
};

export const durationSeverity = (milliseconds: number): "fast" | "normal" | "warning" | "slow" | "critical" => {
  if (milliseconds < 10) return "fast";
  if (milliseconds < 50) return "normal";
  if (milliseconds < 250) return "warning";
  if (milliseconds < 1000) return "slow";
  return "critical";
};

export const traceNodeTiming = (node: TraceNode, model: TraceModel): { left: number; width: number } => {
  const left = Math.max(0, Math.min(99.65, ((node.startMs - model.startMs) / model.durationMs) * 100));
  const width = Math.max(.35, Math.min(100 - left, (node.durationMs / model.durationMs) * 100));
  return { left, width };
};

export const traceCategoryLabel: Record<TraceCategory, string> = {
  transaction: "事务",
  db: "SQL",
  http: "HTTP",
  redis: "Redis",
  rpc: "RPC",
  application: "应用"
};
