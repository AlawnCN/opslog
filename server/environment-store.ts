import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { EnvironmentConfig, PublicEnvironment } from "./domain.js";

const sshServerSchema = z.object({
  name: z.string().trim().min(1),
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().trim().optional(),
  authentication: z.enum(["ssh-config", "password", "private-key"]).default("ssh-config"),
  password: z.string().optional(),
  privateKeyPath: z.string().trim().optional()
});

const sshApplicationSchema = z.object({
  name: z.string().trim().regex(/^[A-Za-z0-9._-]+$/),
  directory: z.string().trim().min(1)
});

const environmentSchema = z.object({
  name: z.string().trim().min(1),
  sourceType: z.enum(["elk", "ssh"]).default("elk"),
  kibanaUrl: z.string().default(""),
  username: z.string().default(""),
  password: z.string().default(""),
  txnlstIndex: z.string().default(""),
  txntrcIndex: z.string().default(""),
  applogIndex: z.string().default(""),
  apmIndex: z.string().trim().optional(),
  allowInsecureTls: z.boolean().optional(),
  timeZone: z.string().trim().optional(),
  sshHost: z.string().trim().optional(),
  sshBaseDirectory: z.string().trim().optional(),
  sshApplications: z.array(z.string().trim().regex(/^[A-Za-z0-9._-]+$/)).optional(),
  sshConnectTimeoutSeconds: z.number().int().min(3).max(60).optional(),
  sshLogTimeOffset: z.string().regex(/^[+-](?:0\d|1\d|2[0-3]):[0-5]\d$/).optional(),
  sshAutoDetectTimeZone: z.boolean().optional(),
  sshServers: z.array(sshServerSchema).optional(),
  sshMonitoredApplications: z.array(sshApplicationSchema).optional()
}).superRefine((environment, context) => {
  if (environment.sourceType === "elk") {
    for (const [value, field] of [[environment.kibanaUrl, "kibanaUrl"], [environment.username, "username"], [environment.password, "password"], [environment.txnlstIndex, "txnlstIndex"], [environment.txntrcIndex, "txntrcIndex"], [environment.applogIndex, "applogIndex"]] as const) {
      if (!value.trim()) context.addIssue({ code: "custom", path: [field], message: `${field} 不能为空` });
    }
  }
  if (environment.sourceType === "elk" && environment.kibanaUrl) {
    try {
      const url = new URL(environment.kibanaUrl);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error("unsupported protocol");
    } catch { context.addIssue({ code: "custom", path: ["kibanaUrl"], message: "kibanaUrl 不合法" }); }
  }
  if (environment.timeZone) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: environment.timeZone }).format();
    } catch {
      context.addIssue({ code: "custom", path: ["timeZone"], message: "timeZone 不是有效的 IANA 时区" });
    }
  }
  const servers = environment.sshServers?.length ? environment.sshServers : environment.sshHost ? [{ name: environment.sshHost, host: environment.sshHost, port: undefined, username: undefined, authentication: "ssh-config" as const, password: undefined, privateKeyPath: undefined }] : [];
  const applications = environment.sshMonitoredApplications?.length ? environment.sshMonitoredApplications : (environment.sshApplications ?? []).map((name) => ({ name, directory: `${(environment.sshBaseDirectory ?? "/home/coradm").replace(/\/+$/, "")}/${name}` }));
  if (environment.sourceType === "ssh" && !servers.length) context.addIssue({ code: "custom", path: ["sshServers"], message: "至少配置一台 SSH 服务器" });
  if (environment.sourceType === "ssh" && !applications.length) context.addIssue({ code: "custom", path: ["sshMonitoredApplications"], message: "至少配置一个监控应用" });
  if (new Set(servers.map(({ name }) => name.toLocaleLowerCase())).size !== servers.length) context.addIssue({ code: "custom", path: ["sshServers"], message: "服务器名称不能重复" });
  if (new Set(applications.map(({ name }) => name.toLocaleLowerCase())).size !== applications.length) context.addIssue({ code: "custom", path: ["sshMonitoredApplications"], message: "监控应用简称不能重复" });
  for (const [index, server] of servers.entries()) {
    if (server.authentication === "password" && (!server.username?.trim() || !server.password)) context.addIssue({ code: "custom", path: ["sshServers", index], message: "密码认证需要用户名和密码" });
    if (server.authentication === "private-key" && (!server.username?.trim() || !server.privateKeyPath?.trim())) context.addIssue({ code: "custom", path: ["sshServers", index], message: "密钥认证需要用户名和私钥路径" });
  }
  if (applications.some((application) => !application.directory.startsWith("/") || application.directory.includes(".."))) {
    context.addIssue({ code: "custom", path: ["sshMonitoredApplications"], message: "SSH 应用目录必须是安全的绝对路径" });
  }
  if (environment.sshBaseDirectory && !environment.sshBaseDirectory.startsWith("/")) {
    context.addIssue({ code: "custom", path: ["sshBaseDirectory"], message: "SSH 基础目录必须是绝对路径" });
  }
});

const LEGACY_KIBANA_URLS = new Map([
  ["https://10.1.6.10/kibana", "https://nexus.faulukenya.com/kibana"],
  ["https://10.1.145.70/kibana", "https://m5uat.faulukenya.com/kibana"]
]);

const configPath = path.resolve(process.cwd(), "opslog-envs.json");

export const normalizeKibanaUrl = (url: string): string =>
  LEGACY_KIBANA_URLS.get(url.toLowerCase()) ?? url;

export const parseEnvironmentConfig = (contents: string): EnvironmentConfig[] => {
  try {
    const parsed = JSON.parse(contents) as unknown;
    const environments = z.array(environmentSchema).min(1).parse(parsed);
    return environments.map((environment) => {
      const sshServers = environment.sshServers?.length ? environment.sshServers : environment.sshHost ? [{ name: environment.sshHost, host: environment.sshHost, authentication: "ssh-config" as const }] : [];
      const sshMonitoredApplications = environment.sshMonitoredApplications?.length ? environment.sshMonitoredApplications : (environment.sshApplications ?? []).map((name) => ({ name, directory: `${(environment.sshBaseDirectory ?? "/home/coradm").replace(/\/+$/, "")}/${name}` }));
      return { ...environment, kibanaUrl: normalizeKibanaUrl(environment.kibanaUrl), sshAutoDetectTimeZone: environment.sshAutoDetectTimeZone ?? true, sshServers, sshMonitoredApplications };
    });
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`环境配置 JSON 不合法：${error.message}`);
    if (error instanceof z.ZodError) throw new Error("环境配置内容不完整或字段格式不合法");
    throw error;
  }
};

export const loadEnvironments = async (): Promise<EnvironmentConfig[]> => {
  const raw = await readFile(configPath, "utf8");
  return parseEnvironmentConfig(raw);
};

export const saveEnvironmentConfig = async (contents: string): Promise<string> => {
  parseEnvironmentConfig(contents);
  await writeFile(configPath, contents, { encoding: "utf8", mode: 0o600 });
  return configPath;
};

export const findEnvironment = async (name: string): Promise<EnvironmentConfig> => {
  const environments = await loadEnvironments();
  const environment = environments.find((candidate) => candidate.name === name);
  if (!environment) {
    throw new Error(`未知环境：${name}`);
  }
  return environment;
};

export const toPublicEnvironment = (
  environment: EnvironmentConfig,
  timeProfile?: Pick<PublicEnvironment, "timeZone" | "timeZoneOffset" | "timeZoneSource">
): PublicEnvironment => ({
  name: environment.name,
  sourceType: environment.sourceType,
  kibanaUrl: environment.kibanaUrl,
  txnlstIndex: environment.txnlstIndex,
  txntrcIndex: environment.txntrcIndex,
  applogIndex: environment.applogIndex,
  apmIndex: environment.apmIndex ?? "traces-apm*",
  insecureTls: environment.allowInsecureTls ?? false,
  sshApplications: environment.sshMonitoredApplications?.map(({ name }) => name) ?? environment.sshApplications ?? [],
  timeZone: timeProfile?.timeZone ?? environment.timeZone ?? "Africa/Nairobi",
  timeZoneOffset: timeProfile?.timeZoneOffset ?? "+03:00",
  timeZoneSource: timeProfile?.timeZoneSource ?? (environment.timeZone ? "configured" : "default")
});
