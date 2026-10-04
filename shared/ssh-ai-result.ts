import { sshAnalysisResultSchema } from "./ssh-log-rules.js";
import { globToFileRegex, generalizeFileRegex } from "./ssh-file-patterns.js";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// A container log without an ID extractor can be browsed, but cannot be used
// for transaction details. Preserve it as an application source, never invent IDs.
const normalizeUncorrelatedDetails = (value: unknown): unknown => {
  if (!isRecord(value) || !Array.isArray(value.applications) || !Array.isArray(value.notes)) return value;
  const warnings: string[] = [];
  const applications = value.applications.map((application: unknown) => {
    if (!isRecord(application) || !Array.isArray(application.logSources)) return application;
    const logSources = application.logSources.map((source: unknown) => {
      if (isRecord(source) && (source.pathMode === undefined || source.pathMode === "glob") && Array.isArray(source.paths) && source.paths.every((path) => typeof path === "string")) {
        source = { ...source, pathMode: "regex", paths: source.paths.map((path) => globToFileRegex(path as string)) };
      }
      if (isRecord(source) && source.pathMode === "regex" && Array.isArray(source.paths) && source.paths.every((path) => typeof path === "string")) source = {...source, paths:source.paths.map((path)=>generalizeFileRegex(path as string))};
      if (!isRecord(source) || source.role !== "detail" || !isRecord(source.fields) || "logId" in source.fields) return source;
      warnings.push(`${String(application.name)} / ${String(source.name)}：缺少日志 ID 映射，已降为应用日志，仅支持日志浏览与检索，不参与交易明细关联。`);
      return { ...source, role: "application" };
    });
    return { ...application, logSources };
  });
  return { ...value, applications, notes: [...value.notes, ...warnings] };
};

const configurationError = (value: unknown) => {
  const result = sshAnalysisResultSchema.safeParse(normalizeUncorrelatedDetails(value));
  if (result.success) return result.data;
  const details = result.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".") || "配置"}：${issue.message}`).join("；");
  throw new Error(`AI 返回的规则未通过校验：${details}`);
};

// Match whole JSON objects only. Braces inside quoted/escaped strings are data,
// not boundaries. Do not repair invalid JSON or silently choose between proposals.
const objectCandidates = (text: string): string[] => {
  const candidates: string[] = [];
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (start < 0) {
      if (char === "{") { start = index; depth = 1; }
      continue;
    }
    if (escaped) { escaped = false; continue; }
    if (quoted && char === "\\") { escaped = true; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (char === "{") depth++;
    if (char === "}" && --depth === 0) {
      candidates.push(text.slice(start, index + 1)); start = -1;
    }
  }
  return candidates;
};

export const parseSshAiResult = (content: string) => {
  const text = content.trim().replace(/^\uFEFF/, "");
  if (text.length > 1_200_000) throw new Error("AI 返回内容超过解析上限，请减少输出长度");
  let value: unknown;
  try { value = JSON.parse(text); }
  catch {
    const valid = [];
    for (const candidate of objectCandidates(text)) {
      try {
        valid.push(configurationError(JSON.parse(candidate)));
      } catch { /* Invalid candidates are never repaired or applied. */ }
    }
    if (valid.length > 1) throw new Error("AI 返回了多份有效配置，请在预览中保留一份后再应用");
    if (valid.length === 1) return valid[0];
    throw new Error("AI 返回内容不含完整有效的规则 JSON，可能已截断或格式不符合要求。请检查返回原文或重新分析");
  }
  return configurationError(value);
};
