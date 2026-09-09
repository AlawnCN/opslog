export type LogHighlightKind =
  | "timestamp"
  | "source"
  | "level-info"
  | "level-warn"
  | "level-error"
  | "sql-keyword"
  | "sql-table"
  | "sql-muted"
  | "message-key"
  | "message-info"
  | "code-success"
  | "code-error"
  | "trace-key"
  | "trace-value"
  | "json-key"
  | "json-string"
  | "json-number"
  | "json-literal"
  | "json-punctuation"
  | "xml-tag"
  | "xml-name"
  | "xml-attribute"
  | "xml-string"
  | "xml-punctuation"
  | "xml-comment"
  | "exception"
  | "service-entry"
  | "service-name"
  | "custom-match";

export interface LogHighlight {
  from: number;
  to: number;
  kind: LogHighlightKind;
}

export interface LogLineStyle {
  at: number;
  tone: number;
}

export interface LogFoldBlock {
  lineFrom: number;
  from: number;
  to: number;
  kind: "json" | "xml" | "java" | "stack" | "service";
}

export type LogOutlineCategory = "service" | "call" | "sql" | "failed-result" | "exception" | "structured";

export interface LogOutlineItem {
  line: number;
  from: number;
  to: number;
  detail?: string;
}

export type LogOutline = Record<LogOutlineCategory, LogOutlineItem[]>;

export interface TransactionLogAnalysis {
  highlights: LogHighlight[];
  lineStyles: LogLineStyle[];
  folds: LogFoldBlock[];
  outline: LogOutline;
  stats: {
    lines: number;
    calls: number;
    services: number;
    sql: number;
    failedResults: number;
    exceptions: number;
    structured: number;
  };
}

export interface ParsedLogHeader {
  timestamp?: [number, number];
  source?: [number, number];
  level?: [number, number];
  levelText?: string;
  payloadFrom: number;
}

export interface StructuredLogRange {
  kind: "json" | "xml" | "java";
  start: number;
  end: number;
}
