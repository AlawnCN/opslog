import type { CustomLogMarker } from "./custom-log-markers";

export interface CompactedLog {
  text: string;
  compacted: boolean;
  originalLines: number;
  retainedLines: number;
  foldedLines: number;
}

interface LogRecord {
  text: string;
  start: number;
  end: number;
  score: number;
}

const normalized = (line: string): string => line
  .replace(/^\s*\d{4}-\d{2}-\d{2}T\S+\s+/, "")
  .replace(/\[[\w.-]+\]\s*/g, "[] ")
  .replace(/\b\d{5,}\b/g, "#")
  .trim();

const markerExpressions = (markers: CustomLogMarker[]): (string | RegExp)[] => markers
  .flatMap((marker) => marker.rules)
  .map((rule) => {
    if (!rule.regex) return rule.query.toLocaleLowerCase();
    try { return new RegExp(rule.query, "i"); } catch { return undefined; }
  })
  .filter((value): value is string | RegExp => Boolean(value));

const scoreLine = (line: string, expressions: (string | RegExp)[]): number => {
  if (/\b(?:ERROR|FATAL|Exception|Caused by|failed|failure|timeout|timed out)\b/i.test(line)) return 100;
  const lower = line.toLocaleLowerCase();
  if (expressions.some((expression) => typeof expression === "string" ? lower.includes(expression) : expression.test(line))) return 90;
  if (/\bWARN(?:ING)?\b/i.test(line)) return 75;
  if (/\b(?:execute result|sql_id|select|insert|update|delete|merge)\b/i.test(line)) return 55;
  if (/(?:container|appName|txncod|txnCode|service|request|response|begin|\bend\b)/i.test(line)) return 35;
  return 0;
};

const collapseRuns = (content: string, expressions: (string | RegExp)[]): LogRecord[] => {
  const lines = content.split("\n");
  const records: LogRecord[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const previous = records.at(-1);
    if (previous && normalized(previous.text) === normalized(line) && normalized(line)) {
      previous.end = index;
      previous.score = Math.max(previous.score, scoreLine(line, expressions));
    } else {
      records.push({ text: line, start: index, end: index, score: scoreLine(line, expressions) });
    }
  }
  return records;
};

const renderRecord = (record: LogRecord): string => {
  const repeats = record.end - record.start;
  const text = record.text.length > 4_000 ? `${record.text.slice(0, 3_800)} … [长行已压缩]` : record.text;
  return repeats ? `${text}\n… [同类日志重复 ${repeats.toLocaleString()} 次，行 ${record.start + 2}-${record.end + 1}]` : text;
};

export const compactLogForAi = (content: string, markers: CustomLogMarker[], maximum: number): CompactedLog => {
  const limit = Math.max(1, Math.floor(maximum));
  const originalLines = content.split("\n").length;
  if (content.length <= limit) return { text: content, compacted: false, originalLines, retainedLines: originalLines, foldedLines: 0 };

  const records = collapseRuns(content, markerExpressions(markers));
  const selected = new Set<number>();
  const keep = (index: number) => { if (index >= 0 && index < records.length) selected.add(index); };
  const edge = Math.min(48, records.length);
  for (let index = 0; index < edge; index += 1) { keep(index); keep(records.length - 1 - index); }
  records.forEach((record, index) => {
    if (!record.score) return;
    const radius = record.score >= 75 ? 3 : 1;
    for (let offset = -radius; offset <= radius; offset += 1) keep(index + offset);
  });

  const averageBudget = Math.max(80, Math.floor(limit / 140));
  for (let index = 0; index < records.length; index += Math.max(1, Math.floor(records.length / averageBudget))) keep(index);
  const indexes = [...selected].sort((left, right) => left - right);
  let retainedIndexes = indexes;
  const sections: string[] = [];
  let previous = -1;
  for (const index of indexes) {
    if (previous >= 0 && index > previous + 1) sections.push(`… [省略 ${index - previous - 1} 个低信息区段]`);
    sections.push(renderRecord(records[index]));
    previous = index;
  }
  let text = sections.join("\n");
  if (text.length > limit) {
    const priority = indexes
      .map((index) => ({ index, score: records[index].score + (index < edge || index >= records.length - edge ? 20 : 0) }))
      .sort((left, right) => right.score - left.score);
    const retained = new Set<number>();
    let used = 0;
    for (const item of priority) {
      const size = renderRecord(records[item.index]).length + 48;
      if (used + size > limit && retained.size) continue;
      retained.add(item.index); used += size;
      if (used >= limit) break;
    }
    const ordered = [...retained].sort((left, right) => left - right);
    retainedIndexes = ordered;
    text = ordered.map((index, position) => {
      const gap = position && index > ordered[position - 1] + 1 ? `… [省略 ${index - ordered[position - 1] - 1} 个低信息区段]\n` : "";
      return `${gap}${renderRecord(records[index])}`;
    }).join("\n").slice(0, limit);
  }

  return { text: text.slice(0, limit), compacted: true, originalLines, retainedLines: retainedIndexes.length, foldedLines: originalLines - records.length };
};
