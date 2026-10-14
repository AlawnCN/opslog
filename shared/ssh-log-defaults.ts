import type { SshLogSource } from "./ssh-log-rules.js";
import { globToFileRegex } from "./ssh-file-patterns.js";
import defaults from "./file-log-defaults.json" with { type: "json" };

export const SSH_ROLE_LABELS: Record<SshLogSource["role"], string> = {
  transaction: "交易列表 / 摘要", transactionEvent: "交易事件（按日志 ID 聚合）",
  application: "应用日志", ecp: "平台日志", detail: "交易明细"
};
export const SSH_FIELD_LABELS = {
  timestamp: "时间", logId: "日志 ID", txnNo: "流水号", business: "业务 Key", service: "交易码",
  node: "节点", sourceNode: "来源节点", messageCode: "结果码", messageInfo: "结果信息", duration: "耗时（ms）",
  tenant: "租户", level: "日志级别", thread: "线程", message: "日志内容", traceId: "Trace ID"
};
const common = { recordEnd: "newline", timestampStyle: "full", ordered: false, successPattern: "00000$", stripAsyncSuffix: false } as const;

// Explicit templates based on the existing built-in parsers, not environment names.
// Displaying these never changes the selected environment until the user edits/applies.
export const defaultSshLogSources = (): SshLogSource[] => structuredClone(defaults)
  .map((source) => ({ ...source, pathMode: "regex", paths: source.paths.map((path) => globToFileRegex(path)) })) as SshLogSource[];

export const newSshLogSource = (): SshLogSource => ({
  ...common, name: "新日志源", role: "application", pathMode: "regex", paths: ["^log/.*\\.log$"], delimiter: "",
  fields: { timestamp: { regex: "(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}[.,]\\d{3})" } }
});
