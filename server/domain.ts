export type LogKind = "transaction" | "application" | "ecp" | "generic";
export type EnvironmentSource = "elk" | "ssh";

export interface EnvironmentConfig {
  name: string;
  sourceType: EnvironmentSource;
  kibanaUrl: string;
  username: string;
  password: string;
  txnlstIndex: string;
  txntrcIndex: string;
  applogIndex: string;
  apmIndex?: string;
  allowInsecureTls?: boolean;
  sshHost?: string;
  sshBaseDirectory?: string;
  sshApplications?: string[];
  sshConnectTimeoutSeconds?: number;
  sshLogTimeOffset?: string;
}

export interface PublicEnvironment {
  name: string;
  sourceType: EnvironmentSource;
  kibanaUrl: string;
  txnlstIndex: string;
  txntrcIndex: string;
  applogIndex: string;
  apmIndex: string;
  insecureTls: boolean;
  sshApplications: string[];
}

export interface SearchInput {
  environment: string;
  kind: LogKind;
  startTime: string;
  endTime: string;
  page: number;
  pageSize: number;
  index?: string;
  txnId?: string;
  traceId?: string;
  txnNo?: string;
  business?: string;
  service?: string;
  messageCode?: string;
  messageInfo?: string;
  status?: "ALL" | "SUCCESS" | "FAIL";
  minDurationMs?: number;
  node?: string;
  keyword?: string;
  level?: string;
  file?: string;
  application?: string;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
}

export const DISPLAY_FIELDS: Record<LogKind, string[]> = {
  transaction: [
    "ecp.txn.timestamp",
    "ecp.txn.id",
    "ecp.txn.no",
    "ecp.txn.business",
    "ecp.txn.node",
    "ecp.txn.service",
    "ecp.txn.server",
    "ecp.txn.duration",
    "ecp.txn.message.code",
    "ecp.txn.message.info",
    "ecp.txn.trace",
    "ecp.txn.tenant",
    "ecp.txn.src.node.id"
  ],
  application: [
    "ecp.log.timestamp",
    "ecp.log.application",
    "ecp.log.level",
    "ecp.log.thread",
    "message",
    "trace.id",
    "host.name"
  ],
  ecp: [
    "ecp.log.timestamp",
    "ecp.log.application",
    "ecp.log.level",
    "ecp.log.file",
    "ecp.log.thread",
    "message",
    "trace.id",
    "host.name"
  ],
  generic: [
    "@timestamp",
    "ecp.log.application",
    "ecp.log.level",
    "ecp.log.thread",
    "message",
    "trace.id",
    "host.name"
  ]
};
