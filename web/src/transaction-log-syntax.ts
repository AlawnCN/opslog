import type { LogHighlight, LogHighlightKind, ParsedLogHeader } from "./transaction-log-model";

const HEADER_PATTERNS = [
  /^(\d{4}-\d\d-\d\dT[^ ]+)\s+\[([^\]]+)]\s+\[([A-Z]+\d*)]\s*->\s*/,
  /^\s*\[([^\]]+)]\s+\[([A-Z]+\d*)]\s*->\s*/,
  /^([A-Z]+\d*)\[([^\]]+)]\[([^\]]+)]\s*->\s*/
];

export const parseLogHeader = (line: string): ParsedLogHeader | undefined => {
  const canonical = HEADER_PATTERNS[0].exec(line);
  if (canonical) {
    const sourceFrom = line.indexOf(canonical[2], canonical[1].length);
    const levelFrom = line.indexOf(canonical[3], sourceFrom + canonical[2].length);
    return { timestamp: [0, canonical[1].length], source: [sourceFrom, sourceFrom + canonical[2].length], level: [levelFrom, levelFrom + canonical[3].length], levelText: canonical[3], payloadFrom: canonical[0].length };
  }
  const compact = HEADER_PATTERNS[1].exec(line);
  if (compact) {
    const sourceFrom = line.indexOf(compact[1]);
    const levelFrom = line.indexOf(compact[2], sourceFrom + compact[1].length);
    return { source: [sourceFrom, sourceFrom + compact[1].length], level: [levelFrom, levelFrom + compact[2].length], levelText: compact[2], payloadFrom: compact[0].length };
  }
  const legacy = HEADER_PATTERNS[2].exec(line);
  if (!legacy) return undefined;
  const timestampFrom = line.indexOf(legacy[2]);
  const sourceFrom = line.indexOf(legacy[3], timestampFrom + legacy[2].length);
  return { level: [0, legacy[1].length], timestamp: [timestampFrom, timestampFrom + legacy[2].length], source: [sourceFrom, sourceFrom + legacy[3].length], levelText: legacy[1], payloadFrom: legacy[0].length };
};

export const addRegexHighlights = (text: string, base: number, regex: RegExp, kind: LogHighlightKind, highlights: LogHighlight[]) => {
  regex.lastIndex = 0;
  for (let match = regex.exec(text); match; match = regex.exec(text)) highlights.push({ from: base + match.index, to: base + match.index + match[0].length, kind });
};

const valueBounds = (text: string, start: number): [number, number] => {
  let from = start;
  while (from < text.length && /\s/.test(text[from])) from += 1;
  const delimiter = text[from];
  if (delimiter === '"' || delimiter === "'") {
    let end = from + 1, escaped = false;
    while (end < text.length) {
      const current = text[end];
      if (!escaped && current === delimiter) return [from + 1, end];
      escaped = !escaped && current === "\\";
      if (current !== "\\") escaped = false;
      end += 1;
    }
  }
  if (delimiter === "[") {
    const end = text.indexOf("]", from + 1);
    if (end >= 0) return [from + 1, end];
  }
  const nextField = /,\s*["']?[A-Za-z_][\w.]*["']?\s*[:=]/.exec(text.slice(from));
  const to = nextField ? from + nextField.index : text.length;
  return [from, to];
};

const addXmlKeyPair = (
  match: RegExpExecArray,
  base: number,
  kind: LogHighlightKind,
  highlights: LogHighlight[]
) => {
  const openingFrom = base + match.index + match[0].indexOf(match[1]);
  const closingFrom = base + match.index + match[0].lastIndexOf(match[1]);
  highlights.push({ from: openingFrom, to: openingFrom + match[1].length, kind });
  if (closingFrom !== openingFrom) highlights.push({ from: closingFrom, to: closingFrom + match[1].length, kind });
};

export const highlightSemanticFields = (payload: string, base: number, resultContext: boolean, highlights: LogHighlight[]): boolean => {
  let failedResult = false;
  const codePattern = /\b(msg_?cd|rsp_?cd|msgCd|rspCd)\b["']?\s*[:=]\s*["'\[]?([A-Z][A-Z0-9_-]{3,})/gi;
  for (let match = codePattern.exec(payload); match; match = codePattern.exec(payload)) {
    const keyFrom = base + match.index, valueOffset = match[0].lastIndexOf(match[2]);
    highlights.push({ from: keyFrom, to: keyFrom + match[1].length, kind: "message-key" });
    const failed = resultContext && !/^[A-Z]{2,8}0{4,}$/.test(match[2]);
    highlights.push({ from: keyFrom + valueOffset, to: keyFrom + valueOffset + match[2].length, kind: failed ? "code-error" : "code-success" });
    failedResult ||= failed;
  }
  const xmlCodePattern = /<(msg_?cd|rsp_?cd|msgCd|rspCd)>([^<]+)<\/\1>/gi;
  for (let match = xmlCodePattern.exec(payload); match; match = xmlCodePattern.exec(payload)) {
    const valueFrom = base + match.index + match[0].indexOf(match[2]);
    const failed = resultContext && !/^[A-Z]{2,8}0{4,}$/.test(match[2]);
    addXmlKeyPair(match, base, "message-key", highlights);
    highlights.push({ from: valueFrom, to: valueFrom + match[2].length, kind: failed ? "code-error" : "code-success" });
    failedResult ||= failed;
  }
  const fieldPattern = /\b(msg_?inf|rsp_?inf|msgInf|rspInf)\b["']?\s*[:=]\s*/gi;
  for (let match = fieldPattern.exec(payload); match; match = fieldPattern.exec(payload)) {
    const keyFrom = base + match.index, [valueFrom, valueTo] = valueBounds(payload, match.index + match[0].length);
    highlights.push({ from: keyFrom, to: keyFrom + match[1].length, kind: "message-key" });
    if (valueTo > valueFrom) highlights.push({ from: base + valueFrom, to: base + valueTo, kind: "message-info" });
  }
  const xmlInfoPattern = /<(msg_?inf|rsp_?inf|msgInf|rspInf)>([^<]+)<\/\1>/gi;
  for (let match = xmlInfoPattern.exec(payload); match; match = xmlInfoPattern.exec(payload)) {
    const valueFrom = base + match.index + match[0].indexOf(match[2]);
    addXmlKeyPair(match, base, "message-key", highlights);
    highlights.push({ from: valueFrom, to: valueFrom + match[2].length, kind: "message-info" });
  }
  const tracePattern = /\b(req_bus_no|reqBusNo)\b["']?\s*[:=]\s*/gi;
  for (let match = tracePattern.exec(payload); match; match = tracePattern.exec(payload)) {
    const keyFrom = base + match.index, [valueFrom, valueTo] = valueBounds(payload, match.index + match[0].length);
    highlights.push({ from: keyFrom, to: keyFrom + match[1].length, kind: "trace-key" });
    if (valueTo > valueFrom) highlights.push({ from: base + valueFrom, to: base + valueTo, kind: "trace-value" });
  }
  const xmlTracePattern = /<(req_bus_no|reqBusNo)>([^<]+)<\/\1>/gi;
  for (let match = xmlTracePattern.exec(payload); match; match = xmlTracePattern.exec(payload)) {
    const valueFrom = base + match.index + match[0].indexOf(match[2]);
    addXmlKeyPair(match, base, "trace-key", highlights);
    highlights.push({ from: valueFrom, to: valueFrom + match[2].length, kind: "trace-value" });
  }
  const contextTracePattern = /key\s*[:=]\s*\[(req_bus_no|reqBusNo)]\s*,?\s*value\s*[:=]\s*\[([^\]]+)]/gi;
  for (let match = contextTracePattern.exec(payload); match; match = contextTracePattern.exec(payload)) {
    const keyFrom = base + match.index + match[0].indexOf(match[1]), valueFrom = base + match.index + match[0].lastIndexOf(match[2]);
    highlights.push({ from: keyFrom, to: keyFrom + match[1].length, kind: "trace-key" });
    highlights.push({ from: valueFrom, to: valueFrom + match[2].length, kind: "trace-value" });
  }
  return failedResult;
};
