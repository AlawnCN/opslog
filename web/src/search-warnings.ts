// Scan budgets are coverage information, not server execution failures.
const SCAN_LIMIT_MESSAGES = [
  "交易列表仅扫描文件末尾片段，结果可能不完整",
  "扫描达到预算上限，当前结果可能不完整",
  "声明式规则采集或输出已达到安全上限，结果可能不完整",
  "SSH log scan reached the 8 MiB / 64 file budget; results may be incomplete"
];

export const classifySearchWarnings = (warnings: string[] = []) => {
  const coverage: string[] = [];
  const failures: string[] = [];
  for (const warning of warnings) {
    (SCAN_LIMIT_MESSAGES.some((message) => warning.endsWith(message)) ? coverage : failures).push(warning);
  }
  return { coverage, failures };
};
