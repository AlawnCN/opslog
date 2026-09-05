import type { LogFoldBlock, LogHighlight, LogLineStyle, TransactionLogAnalysis } from "./transaction-log-model";
import { highlightSql } from "./transaction-log-sql";
import { addRegexHighlights, findStructuredRange, highlightJson, highlightSemanticFields, highlightXml, parseLogHeader } from "./transaction-log-syntax";

export type { LogHighlight, TransactionLogAnalysis } from "./transaction-log-model";
export const MAX_LOG_SEARCH_MATCHES = 5_000;

interface OpenServiceSection {
  lineFrom: number;
  foldFrom: number;
  tone: number;
}

const SERVICE_ENTRY = /=+>\s*container:\[([^\]]+)](?:\s+appName:\[([^\]]+)])?/i;

const addInnerFold = (folds: LogFoldBlock[], block: LogFoldBlock) => {
  if (block.to - block.from < 100 || block.from >= block.to) return;
  if (folds.some((current) => current.kind !== "service" && block.from < current.to && block.to > current.from)) return;
  folds.push(block);
};

const toneForService = (name: string, tones: Map<string, number>): number => {
  const known = tones.get(name);
  if (known !== undefined) return known;
  const tone = tones.size % 6;
  tones.set(name, tone);
  return tone;
};

const addHeaderHighlights = (lineFrom: number, header: ReturnType<typeof parseLogHeader>, highlights: LogHighlight[]): boolean => {
  if (!header) return false;
  if (header.timestamp) highlights.push({ from: lineFrom + header.timestamp[0], to: lineFrom + header.timestamp[1], kind: "timestamp" });
  if (header.source) highlights.push({ from: lineFrom + header.source[0], to: lineFrom + header.source[1], kind: "source" });
  if (!header.level) return false;
  const kind = header.levelText?.startsWith("ERROR") ? "level-error" : header.levelText?.startsWith("WARN") ? "level-warn" : "level-info";
  highlights.push({ from: lineFrom + header.level[0], to: lineFrom + header.level[1], kind });
  return kind === "level-error";
};

const closeServiceSection = (section: OpenServiceSection | undefined, to: number, folds: LogFoldBlock[]) => {
  if (!section || to - section.foldFrom < 100) return;
  folds.push({ lineFrom: section.lineFrom, from: section.foldFrom, to, kind: "service" });
};

export const findLogMatchesInLowercase = (source: string, query: string): number[] => {
  if (!query) return [];
  const needle = query.toLocaleLowerCase(), matches: number[] = [];
  for (let from = 0, match = source.indexOf(needle); match >= 0; match = source.indexOf(needle, from)) {
    matches.push(match);
    if (matches.length >= MAX_LOG_SEARCH_MATCHES) return matches;
    from = match + needle.length;
  }
  return matches;
};

export const findLogMatches = (content: string, query: string): number[] =>
  findLogMatchesInLowercase(content.toLocaleLowerCase(), query);

export const analyzeTransactionLog = (content: string): TransactionLogAnalysis => {
  const emptyStats = { lines: 0, calls: 0, services: 0, sql: 0, failedResults: 0, exceptions: 0, structured: 0 };
  if (!content) return { highlights: [], lineStyles: [], folds: [], stats: emptyStats };
  const highlights: LogHighlight[] = [], lineStyles: LogLineStyle[] = [], folds: LogFoldBlock[] = [];
  const serviceTones = new Map<string, number>();
  let activeService: OpenServiceSection | undefined;
  let structuredUntil = 0;
  let lines = 0, calls = 0, sql = 0, failedResults = 0, exceptions = 0, structured = 0;
  for (let lineFrom = 0; lineFrom <= content.length;) {
    const newline = content.indexOf("\n", lineFrom), lineTo = newline < 0 ? content.length : newline;
    const line = content.slice(lineFrom, lineTo), header = parseLogHeader(line);
    const payloadFrom = header?.payloadFrom ?? 0, payload = line.slice(payloadFrom), payloadBase = lineFrom + payloadFrom;
    let exceptional = addHeaderHighlights(lineFrom, header, highlights);
    const serviceEntry = SERVICE_ENTRY.exec(payload);
    if (serviceEntry) {
      closeServiceSection(activeService, Math.max(lineFrom - 1, 0), folds);
      const serviceName = `${serviceEntry[2] ?? "unknown"}/${serviceEntry[1]}`;
      const tone = toneForService(serviceName, serviceTones);
      activeService = { lineFrom, foldFrom: lineTo, tone };
      const markerFrom = payloadBase + serviceEntry.index;
      highlights.push({ from: markerFrom, to: markerFrom + serviceEntry[0].length, kind: "service-entry" });
      [serviceEntry[1], serviceEntry[2]].filter(Boolean).forEach((name) => {
        const relative = serviceEntry[0].indexOf(name as string);
        highlights.push({ from: markerFrom + relative, to: markerFrom + relative + (name as string).length, kind: "service-name" });
      });
    }
    if (activeService) lineStyles.push({ at: lineFrom, tone: activeService.tone });
    if (/\b(?:Exception|Caused by:|Stack:|ERROR\s+CODE)\b/.test(payload)) {
      addRegexHighlights(payload, payloadBase, /\b(?:[\w.$]+Exception|Caused by:|Stack:|ERROR\s+CODE)\b/g, "exception", highlights);
      exceptional = true;
    }
    if (/(?:txncod|txnCode|service|container)\s*[:=]/i.test(payload)) calls += 1;
    const sqlMarker = /(?:execute\s+sql|sql)\s*[:=]\s*\[?/i.exec(payload);
    if (sqlMarker) {
      const sqlFrom = payloadBase + sqlMarker.index + sqlMarker[0].length, sqlText = line.slice(sqlFrom - lineFrom);
      sql += 1;
      highlightSql(sqlText, sqlFrom, highlights);
    }
    const resultContext = /(?:response|result|exception|error|failed|rspRoot|responseBO)/i.test(payload);
    if (highlightSemanticFields(payload, payloadBase, resultContext, highlights)) failedResults += 1;
    const structure = lineFrom >= structuredUntil
      ? findStructuredRange(content, line, lineFrom, lineTo, payloadFrom)
      : undefined;
    if (structure) {
      structuredUntil = Math.max(structuredUntil, structure.end);
      structured += 1;
      if (structure.kind === "json") highlightJson(content, structure.start, structure.end, highlights);
      else if (structure.kind === "xml") highlightXml(content, structure.start, structure.end, highlights);
      addInnerFold(folds, { lineFrom, from: structure.start, to: structure.end, kind: structure.kind });
    }
    if (/\b(?:Stack:|Caused by:)\b/.test(payload)) {
      let stackEnd = newline < 0 ? lineTo : newline + 1;
      while (stackEnd < content.length) {
        const nextEnd = content.indexOf("\n", stackEnd), nextLineEnd = nextEnd < 0 ? content.length : nextEnd;
        if (parseLogHeader(content.slice(stackEnd, nextLineEnd))) break;
        stackEnd = nextEnd < 0 ? content.length : nextEnd + 1;
      }
      addInnerFold(folds, { lineFrom, from: payloadBase, to: stackEnd, kind: "stack" });
    }
    if (exceptional) exceptions += 1;
    lines += 1;
    if (newline < 0) break;
    lineFrom = newline + 1;
  }
  closeServiceSection(activeService, content.length, folds);
  return { highlights, lineStyles, folds, stats: { lines, calls, services: serviceTones.size, sql, failedResults, exceptions, structured } };
};
