import { createHash } from "node:crypto";
import type { EnvironmentConfig, SearchInput, SshServerConfig } from "./domain.js";

export interface SnapshotSession {
  fingerprint: string;
  touched: number;
  page: number;
  cursors: Record<string, unknown>;
  outputs: Map<string, { server: SshServerConfig; raw: string }>;
}
const sessions = new Map<string, SnapshotSession>();
export const sshServerKey = (server: SshServerConfig): string => JSON.stringify([server.host, server.port ?? null, server.name]);
export const snapshotHasPage = (session: SnapshotSession, input: SearchInput): boolean => session.page > 0 &&
  Object.values(session.cursors).every((cursor) => Object.values((cursor as { files: Record<string, { position: number; matched?: number }> }).files)
    .every((file) => Number(file.position) === 0 || Number(file.matched ?? 0) >= input.page * input.pageSize + 1));
export const snapshotSession = (environment: EnvironmentConfig, input: SearchInput): SnapshotSession | undefined => {
  if (!input.sessionId || input.kind !== "transaction") return undefined;
  const application = input.application ? environment.sshMonitoredApplications?.find((app) => app.name === input.application) : environment.sshMonitoredApplications?.[0];
  const sources = application?.logSources?.filter((source) => source.role.startsWith("transaction") && !source.fallbackOnly);
  if (!sources?.length || sources.some((source) => source.role !== "transaction" || source.recordEnd !== "newline")) return undefined;
  const fingerprint = createHash("sha256").update(JSON.stringify([environment, { ...input, page: 0, sessionId: undefined }])).digest("hex");
  for (const [key, value] of sessions) if (Date.now() - value.touched > 15 * 60_000) sessions.delete(key);
  const existing = sessions.get(input.sessionId);
  if (existing) {
    if (existing.fingerprint !== fingerprint) throw new Error("查询条件或配置已变化，请重新查询首页");
    if (input.page > existing.page + 1) throw new Error("请按顺序翻页，或重新查询首页");
    existing.touched = Date.now();
    sessions.delete(input.sessionId);
    sessions.set(input.sessionId, existing);
    return existing;
  }
  if (input.page !== 1) throw new Error("SSH 查询会话已过期，请重新查询首页");
  while (sessions.size >= 8) sessions.delete(sessions.keys().next().value!);
  const session: SnapshotSession = { fingerprint, touched: Date.now(), page: 0, cursors: {}, outputs: new Map() };
  sessions.set(input.sessionId, session);
  return session;
};

export const appendSnapshotOutputs = (session: SnapshotSession, outputs: Array<{ server: SshServerConfig; raw: string }>, page: number, expectedPage: number) => {
  if (session.page !== expectedPage) throw new Error("同一查询会话已有翻页请求完成，请重试当前页");
  const cursors = { ...session.cursors };
  const combined = new Map(session.outputs);
  for (const { server, raw } of outputs) {
    const cursorLine = raw.split("\n").find((line) => line.startsWith("@OPSLOG_CURSOR\t"));
    if (!cursorLine) throw new Error("SSH 查询未返回续读位置，请重新查询首页");
    const key = sshServerKey(server);
    cursors[key] = JSON.parse(cursorLine.slice("@OPSLOG_CURSOR\t".length));
    const records = raw.split("\n").filter((line) => line.startsWith("@OPSLOG_ROW\t")).join("\n") + "\n";
    combined.set(key, { server, raw: (combined.get(key)?.raw ?? "") + records });
  }
  const bytes = [...combined.values()].reduce((sum, value) => sum + Buffer.byteLength(value.raw), 0);
  if (bytes > 16 * 1024 * 1024) throw new Error("查询会话达到内存安全上限，请增加筛选条件后重新查询首页");
  session.cursors = cursors;
  session.outputs = combined;
  session.page = page;
};
