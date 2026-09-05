import type { LogHighlight, LogHighlightKind, ParsedLogHeader, StructuredLogRange } from "./transaction-log-model";

const HEADER_PATTERNS = [
  /^(\d{4}-\d\d-\d\dT[^ ]+)\s+\[([^\]]+)]\s+\[([A-Z]+\d*)]\s*->\s*/,
  /^\s*\[([^\]]+)]\s+\[([A-Z]+\d*)]\s*->\s*/,
  /^([A-Z]+\d*)\[([^\]]+)]\[([^\]]+)]\s*->\s*/
];
const XML_ROOT_START = /<([A-Za-z_][\w:.-]*)\b/y;
const JSON_PRIMITIVE = /(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)\b/y;

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

const findBalancedEnd = (content: string, start: number, open: string, close: string): number | undefined => {
  let depth = 0, quoted = false, escaped = false;
  for (let index = start; index < content.length; index += 1) {
    const character = content[index];
    if (escaped) { escaped = false; continue; }
    if (character === "\\" && quoted) { escaped = true; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (character === open) depth += 1;
    else if (character === close && --depth === 0) return index + 1;
  }
  return undefined;
};

const findXmlEnd = (content: string, start: number): number | undefined => {
  XML_ROOT_START.lastIndex = start;
  const root = XML_ROOT_START.exec(content);
  if (!root) return undefined;
  const closing = `</${root[1]}>`;
  const end = content.indexOf(closing, start + root[0].length);
  return end < 0 ? undefined : end + closing.length;
};

export const findStructuredRange = (content: string, line: string, lineFrom: number, lineTo: number, payloadFrom: number): StructuredLogRange | undefined => {
  const payload = line.slice(payloadFrom);
  const marker = /(?:request|response|reqRoot|rspRoot|requestBO|responseBO|body|edb|object|param(?:s)?)[^:=>]{0,32}(?::|=>|>>>|<<<)/i.exec(payload);
  const searchFrom = payloadFrom + (marker ? marker.index + marker[0].length : 0);
  const tail = line.slice(searchFrom);
  const jsonIndex = tail.search(/[\[{]/);
  if (jsonIndex >= 0 && (marker || /^\s*[\[{]/.test(tail))) {
    const start = lineFrom + searchFrom + jsonIndex;
    return { kind: "json", start, end: findBalancedEnd(content, start, content[start], content[start] === "{" ? "}" : "]") ?? lineTo };
  }
  const xmlIndex = tail.search(/<[A-Za-z_][\w:.-]*(?:\s|>)/);
  if (xmlIndex >= 0 && (marker || /^\s*</.test(tail))) {
    const start = lineFrom + searchFrom + xmlIndex;
    return { kind: "xml", start, end: findXmlEnd(content, start) ?? lineTo };
  }
  const javaIndex = tail.search(/[A-Z][\w$]*(?:<[^>]+>)?\s*\(/);
  if (!marker || javaIndex < 0) return undefined;
  const start = lineFrom + searchFrom + javaIndex + tail.slice(javaIndex).indexOf("(");
  return { kind: "java", start, end: findBalancedEnd(content, start, "(", ")") ?? lineTo };
};

export const highlightJson = (content: string, from: number, to: number, highlights: LogHighlight[]) => {
  for (let index = from; index < to;) {
    const character = content[index];
    if (character === '"') {
      let end = index + 1, escaped = false;
      while (end < to) {
        const current = content[end++];
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === '"') break;
      }
      let cursor = end;
      while (cursor < to && /\s/.test(content[cursor])) cursor += 1;
      highlights.push({ from: index, to: end, kind: content[cursor] === ":" ? "json-key" : "json-string" });
      index = end;
      continue;
    }
    JSON_PRIMITIVE.lastIndex = index;
    const token = JSON_PRIMITIVE.exec(content);
    if (token && index + token[0].length <= to) {
      highlights.push({ from: index, to: index + token[0].length, kind: /^[-\d]/.test(token[0]) ? "json-number" : "json-literal" });
      index += token[0].length;
      continue;
    }
    if (/[{}\[\]]/.test(character)) highlights.push({ from: index, to: index + 1, kind: "json-punctuation" });
    index += 1;
  }
};

export const highlightXml = (content: string, from: number, to: number, highlights: LogHighlight[]) => {
  addRegexHighlights(content.slice(from, to), from, /<\/?[A-Za-z_][\w:.-]*(?:\s[^<>]*?)?\/?\s*>/g, "xml-tag", highlights);
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
  const xmlCodePattern = /<(msg_?cd|rsp_?cd|msgCd|rspCd)>([^<]+)</gi;
  for (let match = xmlCodePattern.exec(payload); match; match = xmlCodePattern.exec(payload)) {
    const keyFrom = base + match.index + 1, valueFrom = base + match.index + match[0].indexOf(match[2]);
    const failed = resultContext && !/^[A-Z]{2,8}0{4,}$/.test(match[2]);
    highlights.push({ from: keyFrom, to: keyFrom + match[1].length, kind: "message-key" });
    highlights.push({ from: valueFrom, to: valueFrom + match[2].length, kind: failed ? "code-error" : "code-success" });
    failedResult ||= failed;
  }
  const fieldPattern = /\b(msg_?inf|rsp_?inf|msgInf|rspInf)\b["']?\s*[:=]\s*/gi;
  for (let match = fieldPattern.exec(payload); match; match = fieldPattern.exec(payload)) {
    const keyFrom = base + match.index, [valueFrom, valueTo] = valueBounds(payload, match.index + match[0].length);
    highlights.push({ from: keyFrom, to: keyFrom + match[1].length, kind: "message-key" });
    if (valueTo > valueFrom) highlights.push({ from: base + valueFrom, to: base + valueTo, kind: "message-info" });
  }
  const xmlInfoPattern = /<(?:msg_?inf|rsp_?inf|msgInf|rspInf)>([^<]+)</gi;
  for (let match = xmlInfoPattern.exec(payload); match; match = xmlInfoPattern.exec(payload)) {
    const valueOffset = match.index + match[0].indexOf(match[1]);
    const keyOffset = match.index + 1;
    const key = /[A-Za-z_]+/.exec(match[0].slice(1))?.[0];
    if (key) highlights.push({ from: base + keyOffset, to: base + keyOffset + key.length, kind: "message-key" });
    highlights.push({ from: base + valueOffset, to: base + valueOffset + match[1].length, kind: "message-info" });
  }
  const tracePattern = /\b(req_bus_no|reqBusNo)\b["']?\s*[:=]\s*/gi;
  for (let match = tracePattern.exec(payload); match; match = tracePattern.exec(payload)) {
    const keyFrom = base + match.index, [valueFrom, valueTo] = valueBounds(payload, match.index + match[0].length);
    highlights.push({ from: keyFrom, to: keyFrom + match[1].length, kind: "trace-key" });
    if (valueTo > valueFrom) highlights.push({ from: base + valueFrom, to: base + valueTo, kind: "trace-value" });
  }
  const xmlTracePattern = /<(req_bus_no|reqBusNo)>([^<]+)</gi;
  for (let match = xmlTracePattern.exec(payload); match; match = xmlTracePattern.exec(payload)) {
    const keyFrom = base + match.index + 1, valueFrom = base + match.index + match[0].indexOf(match[2]);
    highlights.push({ from: keyFrom, to: keyFrom + match[1].length, kind: "trace-key" });
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
