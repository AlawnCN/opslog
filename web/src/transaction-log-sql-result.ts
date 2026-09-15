import type { LogHighlight } from "./transaction-log-model";

export interface SqlResultRange {
  start: number;
  end: number;
}

const SQL_RESULT_MARKER = /\bexecute\s+result\s*[:=]\s*/i;
const CLOSING_DELIMITER: Record<string, string> = { "[": "]", "{": "}", "(": ")" };

const balancedResultEnd = (content: string, start: number, limit: number): number | undefined => {
  const stack: string[] = [];
  let quote = "", escaped = false;
  for (let index = start; index < limit; index += 1) {
    const character = content[index];
    if (escaped) { escaped = false; continue; }
    if (quote) {
      if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'") { quote = character; continue; }
    const closing = CLOSING_DELIMITER[character];
    if (closing) stack.push(closing);
    else if (stack.at(-1) === character) {
      stack.pop();
      if (stack.length === 0) return index + 1;
    }
  }
  return undefined;
};

export const findSqlResultRange = (
  content: string,
  line: string,
  lineFrom: number,
  lineTo: number,
  payloadFrom: number
): SqlResultRange | undefined => {
  const payload = line.slice(payloadFrom);
  const marker = SQL_RESULT_MARKER.exec(payload);
  if (!marker) return undefined;
  let start = lineFrom + payloadFrom + marker.index + marker[0].length;
  while (start < lineTo && /\s/.test(content[start])) start += 1;
  if (start >= lineTo) return undefined;
  const balancedEnd = CLOSING_DELIMITER[content[start]]
    ? balancedResultEnd(content, start, lineTo)
    : undefined;
  let end = balancedEnd ?? lineTo;
  while (end > start && /\s/.test(content[end - 1])) end -= 1;
  return end > start ? { start, end } : undefined;
};

export const highlightSqlResult = (
  content: string,
  line: string,
  lineFrom: number,
  payloadFrom: number,
  range: SqlResultRange,
  highlights: LogHighlight[]
) => {
  const payload = line.slice(payloadFrom);
  const marker = SQL_RESULT_MARKER.exec(payload);
  if (marker) {
    const markerFrom = lineFrom + payloadFrom + marker.index;
    highlights.push({ from: markerFrom, to: markerFrom + marker[0].trimEnd().length, kind: "sql-result-label" });
  }
  const source = content.slice(range.start, range.end);
  const keyPattern = /(?:^|[\[{,]\s*)([A-Za-z_][\w.]*)\s*=/g;
  for (let match = keyPattern.exec(source); match; match = keyPattern.exec(source)) {
    const keyFrom = range.start + match.index + match[0].indexOf(match[1]);
    highlights.push({ from: keyFrom, to: keyFrom + match[1].length, kind: "sql-result-key" });
  }
  const valuePattern = /(?:^|[\[=,:]\s*)(-?\d+(?:\.\d+)?|true|false|null)(?=\s*[,}\]])/gi;
  for (let match = valuePattern.exec(source); match; match = valuePattern.exec(source)) {
    const valueFrom = range.start + match.index + match[0].lastIndexOf(match[1]);
    highlights.push({
      from: valueFrom,
      to: valueFrom + match[1].length,
      kind: /^-?\d/.test(match[1]) ? "sql-result-number" : "sql-result-literal"
    });
  }
};
