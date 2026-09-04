import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { EnvironmentConfig, PublicEnvironment } from "./domain.js";

const environmentSchema = z.object({
  name: z.string().trim().min(1),
  kibanaUrl: z.string().url(),
  username: z.string().min(1),
  password: z.string().min(1),
  txnlstIndex: z.string().trim().min(1),
  txntrcIndex: z.string().trim().min(1),
  applogIndex: z.string().trim().min(1),
  apmIndex: z.string().trim().optional(),
  allowInsecureTls: z.boolean().optional()
});

const LEGACY_KIBANA_URLS = new Map([
  ["https://10.1.6.10/kibana", "https://nexus.faulukenya.com/kibana"],
  ["https://10.1.145.70/kibana", "https://m5uat.faulukenya.com/kibana"]
]);

const configPath = path.resolve(process.cwd(), "opslog-envs.json");

export const normalizeKibanaUrl = (url: string): string =>
  LEGACY_KIBANA_URLS.get(url.toLowerCase()) ?? url;

export const loadEnvironments = async (): Promise<EnvironmentConfig[]> => {
  const raw = await readFile(configPath, "utf8");
  return z.array(environmentSchema)
    .parse(JSON.parse(raw))
    .map((environment) => ({ ...environment, kibanaUrl: normalizeKibanaUrl(environment.kibanaUrl) }));
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
  kibanaUrl: environment.kibanaUrl,
  txnlstIndex: environment.txnlstIndex,
  txntrcIndex: environment.txntrcIndex,
  applogIndex: environment.applogIndex,
  apmIndex: environment.apmIndex ?? "traces-apm*",
  insecureTls: environment.allowInsecureTls ?? false
});
