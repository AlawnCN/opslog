export type LogKind = "transaction" | "application" | "ecp" | "generic";
export type EnvironmentSource = "elk" | "ssh";

export interface Environment {
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

export interface EnvironmentConfiguration {
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

export interface SearchFilters {
  startLocal: string;
  endLocal: string;
  index: string;
  txnId: string;
  traceId: string;
  txnNo: string;
  business: string;
  service: string;
  messageCode: string;
  messageInfo: string;
  status: "ALL" | "SUCCESS" | "FAIL";
  minDurationMs: string;
  node: string;
  keyword: string;
  level: string;
  file: string;
  application: string;
}

export interface SearchResponse {
  columns: string[];
  rows: Record<string, unknown>[];
  page: number;
  pageSize: number;
  hasMore: boolean;
  truncated: boolean;
  queryTime: string;
}

export interface SearchRequest extends Omit<SearchFilters, "startLocal" | "endLocal" | "minDurationMs"> {
  environment: string;
  kind: LogKind;
  startTime: string;
  endTime: string;
  page: number;
  pageSize: number;
  minDurationMs?: number;
}
