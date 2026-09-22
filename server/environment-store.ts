import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { EnvironmentConfig, PublicEnvironment } from "./domain.js";

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
  sshHost: z.string().trim().optional(),
  sshBaseDirectory: z.string().trim().optional(),
  sshApplications: z.array(z.string().trim().regex(/^[A-Za-z0-9._-]+$/)).optional(),
  sshConnectTimeoutSeconds: z.number().int().min(3).max(60).optional(),
  sshLogTimeOffset: z.string().regex(/^[+-](?:0\d|1\d|2[0-3]):[0-5]\d$/).optional()
}).superRefine((environment, context) => {
  const required = environment.sourceType === "ssh"
    ? [[environment.sshHost, "sshHost"], [environment.sshBaseDirectory, "sshBaseDirectory"]] as const
    : [[environment.kibanaUrl, "kibanaUrl"], [environment.username, "username"], [environment.password, "password"], [environment.txnlstIndex, "txnlstIndex"], [environment.txntrcIndex, "txntrcIndex"], [environment.applogIndex, "applogIndex"]] as const;
  for (const [value, field] of required) {
    if (!value?.trim()) context.addIssue({ code: "custom", path: [field], message: `${field} 不能为空` });
  }
  if (environment.sourceType === "elk" && environment.kibanaUrl) {
    try {
      const url = new URL(environment.kibanaUrl);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error("unsupported protocol");
    } catch { context.addIssue({ code: "custom", path: ["kibanaUrl"], message: "kibanaUrl 不合法" }); }
  }
  if (environment.sourceType === "ssh" && !environment.sshApplications?.length) {
    context.addIssue({ code: "custom", path: ["sshApplications"], message: "至少配置一个监控应用" });
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
    return environments.map((environment) => ({
      ...environment,
      kibanaUrl: normalizeKibanaUrl(environment.kibanaUrl)
    }));
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

export const toPublicEnvironment = (environment: EnvironmentConfig): PublicEnvironment => ({
  name: environment.name,
  sourceType: environment.sourceType,
  kibanaUrl: environment.kibanaUrl,
  txnlstIndex: environment.txnlstIndex,
  txntrcIndex: environment.txntrcIndex,
  applogIndex: environment.applogIndex,
  apmIndex: environment.apmIndex ?? "traces-apm*",
  insecureTls: environment.allowInsecureTls ?? false,
  sshApplications: environment.sshApplications ?? []
});
