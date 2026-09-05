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
  | "exception"
  | "service-entry"
  | "service-name";

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

export interface TransactionLogAnalysis {
  highlights: LogHighlight[];
  lineStyles: LogLineStyle[];
  folds: LogFoldBlock[];
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
