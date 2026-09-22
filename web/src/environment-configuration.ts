import type { EnvironmentConfiguration } from "./types";

export const createEnvironmentConfiguration = (sequence: number): EnvironmentConfiguration => ({
  name: `environment-${sequence}`,
  sourceType: "elk",
  kibanaUrl: "",
  username: "",
  password: "",
  txnlstIndex: "logs-ecp.txn.lst.dr*",
  txntrcIndex: "logs-ecp.txn.trc.dr*",
  applogIndex: "logs-ecp.app.dr*",
  sshHost: "",
  sshBaseDirectory: "/home/coradm",
  sshApplications: ["cte"],
  sshConnectTimeoutSeconds: 10,
  sshLogTimeOffset: "+03:00"
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const parseEnvironmentConfigurationFile = (contents: string): EnvironmentConfiguration[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    throw new Error("JSON 格式不正确，请检查文件内容");
  }
  if (!Array.isArray(parsed) || !parsed.length || parsed.some((item) => !isRecord(item))) {
    throw new Error("配置文件必须包含至少一个环境配置");
  }
  return parsed.map((item) => ({
    name: String(item.name ?? ""),
    sourceType: item.sourceType === "ssh" ? "ssh" : "elk",
    kibanaUrl: String(item.kibanaUrl ?? ""),
    username: String(item.username ?? ""),
    password: String(item.password ?? ""),
    txnlstIndex: String(item.txnlstIndex ?? ""),
    txntrcIndex: String(item.txntrcIndex ?? ""),
    applogIndex: String(item.applogIndex ?? ""),
    ...(typeof item.apmIndex === "string" ? { apmIndex: item.apmIndex } : {}),
    ...(typeof item.allowInsecureTls === "boolean" ? { allowInsecureTls: item.allowInsecureTls } : {}),
    sshHost: String(item.sshHost ?? ""),
    sshBaseDirectory: String(item.sshBaseDirectory ?? "/home/coradm"),
    sshApplications: Array.isArray(item.sshApplications) ? item.sshApplications.map(String) : ["cte"],
    sshConnectTimeoutSeconds: Number(item.sshConnectTimeoutSeconds ?? 10),
    sshLogTimeOffset: String(item.sshLogTimeOffset ?? "+03:00")
  }));
};

export const validateEnvironmentConfigurations = (items: EnvironmentConfiguration[]): string | undefined => {
  if (!items.length) return "至少需要保留一个运行环境";
  const names = new Set<string>();
  for (const item of items) {
    const fields: Array<[string, string]> = item.sourceType === "ssh"
      ? [[item.name, "配置名称"], [item.sshHost ?? "", "SSH 主机"], [item.sshBaseDirectory ?? "", "日志基础目录"]]
      : [[item.name, "配置名称"], [item.kibanaUrl, "Kibana 地址"], [item.username, "用户名"], [item.password, "密码"], [item.txnlstIndex, "交易日志索引"], [item.txntrcIndex, "Trace 日志索引"], [item.applogIndex, "应用日志索引"]];
    const empty = fields.find(([value]) => !value.trim());
    if (empty) return `${item.name || "未命名环境"}：${empty[1]}不能为空`;
    if (item.sourceType === "ssh") {
      if (!item.sshBaseDirectory?.startsWith("/")) return `${item.name}：日志基础目录必须使用绝对路径`;
      if (!item.sshApplications?.length) return `${item.name}：至少配置一个监控应用`;
      if (item.sshApplications.some((app) => !/^[A-Za-z0-9._-]+$/.test(app))) return `${item.name}：监控应用简称包含非法字符`;
    } else try {
      const url = new URL(item.kibanaUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") return `${item.name}：Kibana 地址仅支持 HTTP 或 HTTPS`;
    } catch { return `${item.name}：Kibana 地址格式不正确`; }
    const normalizedName = item.name.trim().toLocaleLowerCase();
    if (names.has(normalizedName)) return `配置名称不能重复：${item.name}`;
    names.add(normalizedName);
  }
  return undefined;
};
