import type {
  EnvironmentConfiguration,
  SshApplicationConfiguration,
  SshServerConfiguration
} from "./types";

const DEFAULT_TIME_ZONE = "Africa/Nairobi";
const DEFAULT_SSH_OFFSET = "+03:00";

const defaultSshServer = (sequence = 1): SshServerConfiguration => ({
  name: `server-${sequence}`, host: "", username: "", authentication: "ssh-config", password: "", privateKeyPath: ""
});

const defaultSshApplication = (): SshApplicationConfiguration => ({ name: "cte", directory: "/home/coradm/cte" });

const normalizeSshServer = (server: SshServerConfiguration): SshServerConfiguration => {
  const { port, ...rest } = server;
  return rest.authentication === "ssh-config" || port == null || String(port).trim() === ""
    ? rest
    : { ...rest, port };
};

export const createEnvironmentConfiguration = (sequence: number): EnvironmentConfiguration => ({
  name: `environment-${sequence}`, sourceType: "elk", kibanaUrl: "", username: "", password: "",
  txnlstIndex: "logs-ecp.txn.lst.dr*", txntrcIndex: "logs-ecp.txn.trc.dr*", applogIndex: "logs-ecp.app.dr*",
  timeZone: DEFAULT_TIME_ZONE, sshConnectTimeoutSeconds: 10, sshLogTimeOffset: DEFAULT_SSH_OFFSET,
  sshAutoDetectTimeZone: true, sshServers: [defaultSshServer()], sshMonitoredApplications: [defaultSshApplication()]
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const parseSshServers = (item: Record<string, unknown>): SshServerConfiguration[] => {
  if (Array.isArray(item.sshServers)) return item.sshServers.filter(isRecord).map((server, index): SshServerConfiguration => ({
    name: String(server.name ?? `server-${index + 1}`), host: String(server.host ?? ""), ...(server.port == null || server.port === "" ? {} : { port: Number(server.port) }),
    username: String(server.username ?? ""), authentication: server.authentication === "password" || server.authentication === "private-key" ? server.authentication : "ssh-config",
    password: String(server.password ?? ""), privateKeyPath: String(server.privateKeyPath ?? "")
  })).map(normalizeSshServer);
  const legacyHost = String(item.sshHost ?? "");
  return legacyHost ? [{ ...defaultSshServer(), name: legacyHost, host: legacyHost }] : [defaultSshServer()];
};

const parseSshApplications = (item: Record<string, unknown>): SshApplicationConfiguration[] => {
  if (Array.isArray(item.sshMonitoredApplications)) return item.sshMonitoredApplications.filter(isRecord).map((application) => ({
    name: String(application.name ?? ""), directory: String(application.directory ?? "")
  }));
  const base = String(item.sshBaseDirectory ?? "/home/coradm").replace(/\/+$/, "");
  const legacy = Array.isArray(item.sshApplications) ? item.sshApplications.map(String) : ["cte"];
  return legacy.map((name) => ({ name, directory: `${base}/${name}` }));
};

export const normalizeEnvironmentConfiguration = (item: EnvironmentConfiguration): EnvironmentConfiguration => ({
  ...item, timeZone: item.timeZone || DEFAULT_TIME_ZONE,
  sshConnectTimeoutSeconds: item.sshConnectTimeoutSeconds ?? 10, sshLogTimeOffset: item.sshLogTimeOffset || DEFAULT_SSH_OFFSET,
  sshAutoDetectTimeZone: item.sshAutoDetectTimeZone ?? true,
  sshServers: item.sshServers?.length ? item.sshServers.map(normalizeSshServer) : parseSshServers(item as unknown as Record<string, unknown>),
  sshMonitoredApplications: item.sshMonitoredApplications?.length ? item.sshMonitoredApplications.map((application) => ({ ...application })) : parseSshApplications(item as unknown as Record<string, unknown>)
});

export const parseEnvironmentConfigurationFile = (contents: string): EnvironmentConfiguration[] => {
  let parsed: unknown;
  try { parsed = JSON.parse(contents) as unknown; } catch { throw new Error("JSON 格式不正确，请检查文件内容"); }
  if (!Array.isArray(parsed) || !parsed.length || parsed.some((item) => !isRecord(item))) throw new Error("配置文件必须包含至少一个环境配置");
  return parsed.map((item) => normalizeEnvironmentConfiguration({
    name: String(item.name ?? ""), sourceType: item.sourceType === "ssh" ? "ssh" : "elk",
    kibanaUrl: String(item.kibanaUrl ?? ""), username: String(item.username ?? ""), password: String(item.password ?? ""),
    txnlstIndex: String(item.txnlstIndex ?? ""), txntrcIndex: String(item.txntrcIndex ?? ""), applogIndex: String(item.applogIndex ?? ""),
    ...(typeof item.apmIndex === "string" ? { apmIndex: item.apmIndex } : {}),
    ...(typeof item.allowInsecureTls === "boolean" ? { allowInsecureTls: item.allowInsecureTls } : {}),
    timeZone: String(item.timeZone ?? DEFAULT_TIME_ZONE), sshHost: String(item.sshHost ?? ""),
    sshBaseDirectory: String(item.sshBaseDirectory ?? "/home/coradm"),
    sshApplications: Array.isArray(item.sshApplications) ? item.sshApplications.map(String) : undefined,
    sshConnectTimeoutSeconds: Number(item.sshConnectTimeoutSeconds ?? 10), sshLogTimeOffset: String(item.sshLogTimeOffset ?? DEFAULT_SSH_OFFSET),
    sshAutoDetectTimeZone: item.sshAutoDetectTimeZone !== false, sshServers: parseSshServers(item), sshMonitoredApplications: parseSshApplications(item)
  }));
};

export const serializeEnvironmentConfigurations = (items: EnvironmentConfiguration[]): string => JSON.stringify(items.map((item) => {
  const normalized = normalizeEnvironmentConfiguration(item);
  const common = { name: normalized.name, sourceType: normalized.sourceType, timeZone: normalized.timeZone };
  if (normalized.sourceType === "elk") return {
    ...common, kibanaUrl: normalized.kibanaUrl, username: normalized.username,
    txnlstIndex: normalized.txnlstIndex, txntrcIndex: normalized.txntrcIndex, applogIndex: normalized.applogIndex,
    ...(normalized.apmIndex !== undefined ? { apmIndex: normalized.apmIndex } : {}),
    ...(normalized.allowInsecureTls !== undefined ? { allowInsecureTls: normalized.allowInsecureTls } : {})
  };
  return {
    ...common, sshConnectTimeoutSeconds: normalized.sshConnectTimeoutSeconds,
    sshLogTimeOffset: normalized.sshLogTimeOffset, sshAutoDetectTimeZone: normalized.sshAutoDetectTimeZone,
    sshServers: normalized.sshServers?.map((server) => ({
      name: server.name, host: server.host, authentication: server.authentication,
      ...(server.authentication !== "ssh-config" && server.port !== undefined ? { port: server.port } : {}),
      ...(server.authentication !== "ssh-config" ? { username: server.username ?? "" } : {}),
      ...(server.authentication === "private-key" ? { privateKeyPath: server.privateKeyPath ?? "" } : {})
    })),
    sshMonitoredApplications: normalized.sshMonitoredApplications
  };
}), null, 2);

const validTimeZone = (timeZone: string): boolean => {
  try { new Intl.DateTimeFormat("zh-CN", { timeZone }).format(); return true; } catch { return false; }
};

export const validateEnvironmentConfigurations = (items: EnvironmentConfiguration[]): string | undefined => {
  if (!items.length) return "至少需要保留一个运行环境";
  const names = new Set<string>();
  for (const rawItem of items) {
    const item = normalizeEnvironmentConfiguration(rawItem);
    if (!item.name.trim()) return "环境名称不能为空";
    if (!validTimeZone(item.timeZone || DEFAULT_TIME_ZONE)) return `${item.name}：日志时区不是有效的 IANA 时区`;
    if (item.sourceType === "ssh") {
      if (!Number.isInteger(item.sshConnectTimeoutSeconds) || (item.sshConnectTimeoutSeconds ?? 0) < 3 || (item.sshConnectTimeoutSeconds ?? 0) > 60) return `${item.name}：连接超时必须在 3～60 秒之间`;
      if (!/^[+-](?:0\d|1\d|2[0-3]):[0-5]\d$/.test(item.sshLogTimeOffset || "")) return `${item.name}：时区 UTC 偏移格式应为 +08:00`;
      if (!item.sshServers?.length) return `${item.name}：至少配置一台 SSH 服务器`;
      const serverNames = new Set<string>();
      for (const server of item.sshServers) {
        if (!server.name.trim() || !server.host.trim()) return `${item.name}：服务器名称和地址不能为空`;
        if (server.authentication !== "ssh-config" && server.port !== undefined && (!Number.isInteger(server.port) || server.port < 1 || server.port > 65535)) return `${item.name} / ${server.name}：SSH 端口必须在 1～65535 之间`;
        if (serverNames.has(server.name.trim().toLocaleLowerCase())) return `${item.name}：服务器名称不能重复`;
        serverNames.add(server.name.trim().toLocaleLowerCase());
        if (server.authentication === "password" && (!server.username?.trim() || !server.password)) return `${item.name} / ${server.name}：密码认证需要用户名和密码`;
        if (server.authentication === "private-key" && (!server.username?.trim() || !server.privateKeyPath?.trim())) return `${item.name} / ${server.name}：密钥认证需要用户名和私钥路径`;
      }
      if (!item.sshMonitoredApplications?.length) return `${item.name}：至少配置一项应用目录映射`;
      const applicationNames = new Set<string>();
      for (const application of item.sshMonitoredApplications) {
        if (!/^[A-Za-z0-9._-]+$/.test(application.name)) return `${item.name}：应用标识仅支持字母、数字、点、下划线与连字符`;
        if (!application.directory.startsWith("/") || application.directory.includes("..")) return `${item.name} / ${application.name || "未命名应用"}：日志目录必须为不含 .. 的绝对路径`;
        if (applicationNames.has(application.name.toLocaleLowerCase())) return `${item.name}：应用标识不能重复`;
        applicationNames.add(application.name.toLocaleLowerCase());
      }
    } else {
      const fields: Array<[string, string]> = [[item.kibanaUrl, "Kibana 服务地址"], [item.username, "用户名"], [item.password, "密码"], [item.txnlstIndex, "交易日志索引"], [item.txntrcIndex, "调用链日志索引"], [item.applogIndex, "应用日志索引"]];
      const empty = fields.find(([value]) => !value.trim());
      if (empty) return `${item.name}：${empty[1]}不能为空`;
      try { const url = new URL(item.kibanaUrl); if (!['http:', 'https:'].includes(url.protocol)) return `${item.name}：Kibana 服务地址仅支持 HTTP 或 HTTPS`; } catch { return `${item.name}：Kibana 服务地址格式无效`; }
    }
    const normalizedName = item.name.trim().toLocaleLowerCase();
    if (names.has(normalizedName)) return `环境名称重复：${item.name}`;
    names.add(normalizedName);
  }
  return undefined;
};
