import type { SshLogSource } from "./ssh-log-rules.js";
import type { parseSshAiResult } from "./ssh-ai-result.js";

export interface SshAnalysisSample {
  name: string;
  samples: Array<{ server: string; files: Array<{ path: string; size: number; summarySelected?: boolean; content: string }> }>;
  warnings: string[];
}

// Same field boundary rules as configured_search.sh: preserve empty columns,
// quoted JSON strings and nested payloads, including embedded pipe characters.
export const splitSummaryFields = (record: string, separator = "|"): string[] => {
  const body = separator === "|" ? record.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[.,]\d{3}\s*->\s*\|?/, "") : record;
  if (!separator) return [body];
  const fields: string[] = [];
  let field = "", depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < body.length; index++) {
    const char = body[index]!;
    if (!quoted && !depth && body.startsWith(separator, index)) { fields.push(field); field = ""; index += separator.length - 1; continue; }
    field += char;
    if (escaped) { escaped = false; continue; }
    if (quoted && char === "\\") { escaped = true; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (!quoted) { if (char === "{" || char === "[") depth++; else if ((char === "}" || char === "]") && depth > 0) depth--; }
  }
  fields.push(field);
  return fields;
};

const records = (content: string): string[] => content.split(/\r?\n/).filter(line => line.trim() && !/^\[(?:HEAD|TAIL|SAMPLE)/.test(line));
const matches = (source: SshLogSource, path: string): boolean => source.paths.some(pattern => new RegExp(`^(?:${pattern.replaceAll("{day}", "[0-9]{2}")})$`).test(path));
const extract = (source: SshLogSource, key: keyof SshLogSource["fields"], record: string, fields: string[]): string => {
  const mapping = source.fields[key];
  return (mapping?.regex ? new RegExp(mapping.regex).exec(record)?.[1] : mapping?.index !== undefined ? fields[mapping.index] : "")?.trim() ?? "";
};

// Validate against the actual sampled rows, not only against the JSON schema.
// The familiar M5 layout is asserted only when its semantic anchors are present;
// other layouts still have to replay timestamp/ID/duration/result/trace correctly.
export const validateSshAiSamples = (proposal: NonNullable<ReturnType<typeof parseSshAiResult>>, collected: SshAnalysisSample[]): void => {
  const errors: string[] = [];
  for (const app of collected) {
    const inferred = proposal.applications.find(item => item.name === app.name);
    if (!inferred) { errors.push(`${app.name}：未返回应用配置`); continue; }
    if (inferred.logSources.some(item => item.role === "detail")) errors.push(`${app.name}：单笔明细由完整日志 ID 精确定位，不应生成 detail 片段来源；数据库/容器日志请使用 application`);
    for (const server of app.samples) {
      for (const file of server.files.filter(item => item.summarySelected)) {
        const label = `${app.name} / ${server.server} / ${file.path}`;
        const sources = inferred.logSources.filter(source => source.role === "transaction" && !source.fallbackOnly && matches(source, file.path));
        if (sources.length !== 1) { errors.push(`${label}：最新 .lst 必须且只能由一个主要 transaction 来源覆盖`); continue; }
        const source = sources[0]!;
        if (source.fileSelection !== "latest" || source.stripAsyncSuffix) errors.push(`${label}：汇总必须按最新文件选择，并保留完整日志 ID`);
        const rows = records(file.content).filter(row => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[.,]\d{3}\s*->/.test(row));
        if (!rows.length) { errors.push(`${label}：无完整交易汇总记录，不能确认字段规则`); continue; }
        for (const row of rows) {
          const fields = splitSummaryFields(row, source.delimiter);
          const value = (key: keyof SshLogSource["fields"]) => extract(source, key, row, fields);
          if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[.,]\d{3}$/.test(value("timestamp"))) errors.push(`${label}：timestamp 未能解析所有完整样本（检查点号/逗号毫秒）`);
          const alternate = row.replace(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})([.,])/, (_, prefix: string, mark: string) => `${prefix}${mark === "." ? "," : "."}`);
          if (!extract(source, "timestamp", alternate, splitSummaryFields(alternate, source.delimiter))) errors.push(`${label}：timestamp 必须兼容规范中的点号和逗号毫秒，不能只匹配本次样本的一种标点`);
          if (!/^[A-Za-z0-9._-]+$/.test(value("logId"))) errors.push(`${label}：logId 未能提取完整文件关联 ID`);
          if (source.fields.duration && !/^\d+(?:\.\d+)?$/.test(value("duration"))) errors.push(`${label}：duration 不是毫秒数值`);
          if (value("traceId") && !/^[a-fA-F0-9]{32}$/.test(value("traceId"))) errors.push(`${label}：traceId 不是 32 位十六进制值`);
          if (value("messageCode") && !/^[A-Za-z][A-Za-z0-9]*\d{4,}$/.test(value("messageCode"))) errors.push(`${label}：messageCode 不是业务结果码`);
          const standard = source.delimiter === "|" && fields.length >= 12 && /^[A-Za-z0-9_-]+\.[A-Za-z][A-Za-z0-9-]*_\d+_\d+/.test(fields[3] ?? "")
            && /^\d+$/.test(fields[6] ?? "") && /^[A-Za-z][A-Za-z0-9]*\d{4,}$/.test(fields[10] ?? "");
          if (standard) {
            const expected = { logId: 0, txnNo: 1, tenant: 2, node: 3, business: 4, service: 5, duration: 6, traceId: 8, messageCode: 10, messageInfo: 11 } as const;
            for (const [key, index] of Object.entries(expected)) {
              const mapping = source.fields[key as keyof typeof expected];
              if (!mapping || (mapping.index !== undefined && mapping.index !== index) || value(key as keyof typeof expected) !== fields[index]?.trim()) errors.push(`${label}：${key} 与样本中已确认的字段不一致或漏配`);
            }
            const sourceIndex = fields.length - (fields.at(-1) === "" ? 2 : 1);
            const sourceNode = fields[sourceIndex]?.trim();
            // A trailing value alone is not proof of a source node. Recognize
            // both cen.u_0_152 and tlr.tlr.u_0_152, with or without a final pipe.
            const confirmedSource = sourceIndex >= 13 && sourceNode && /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.[A-Za-z][A-Za-z0-9-]*_\d+_\d+(?:\.\d+){0,3}$/.test(sourceNode);
            if (confirmedSource && value("sourceNode") !== sourceNode) errors.push(`${label}：sourceNode 来源节点漏配或位置错误；样本来源节点位于第 ${sourceIndex} 列（从 0 开始），不是 node 执行节点第 3 列，请映射该列或使用经样本核对的行尾提取正则`);
          }
        }
        if (inferred.logSources.some(item => item.role === "transactionEvent" && !item.fallbackOnly)) errors.push(`${label}：已有 .lst 汇总，不允许将事件聚合混入交易列表；请改为 application 或明确备用来源`);
      }
    }
  }
  if (errors.length) throw new Error(`AI 参数未通过实际样本回放，未应用：${[...new Set(errors)].slice(0, 8).join("；")}`);
};

// Preserve whole records (especially the result fields at the end of a .lst
// line). Budget reduction drops records, never chops a record into fake columns.
export const prepareSshAiSamples = (collected: SshAnalysisSample[], maxCharacters: number): SshAnalysisSample[] => {
  const context = collected.map(app => ({ ...app, samples: app.samples.map(server => ({ ...server, files: server.files.slice(0, 6).map(file => {
    const lines = file.summarySelected ? records(file.content) : file.content.split(" §§ logEnd");
    const chosen = lines.length > 6 ? [...lines.slice(0, 3), ...lines.slice(-3)] : lines;
    return { ...file, content: chosen.join(file.summarySelected ? "\n" : " §§ logEnd") };
  }) })) }));
  while (JSON.stringify(context).length > maxCharacters) {
    const candidates = context.flatMap(app => app.samples.flatMap(server => server.files)).sort((a, b) => Number(!!a.summarySelected) - Number(!!b.summarySelected) || b.content.length - a.content.length);
    const file = candidates.find(item => item.content && (!item.summarySelected || records(item.content).length > 1));
    if (!file) throw new Error("模型输入上限不足以保留每台服务器的完整汇总记录，请提高日志输入上限");
    if (!file.summarySelected) file.content = "";
    else { const lines = records(file.content); lines.splice(lines.length === 2 ? 0 : Math.floor(lines.length / 2), 1); file.content = lines.join("\n"); }
  }
  return context;
};
