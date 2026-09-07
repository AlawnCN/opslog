import type { LogHighlight } from "./transaction-log-model";

const KEYWORDS = new Set([
  "select", "from", "where", "join", "left", "right", "inner", "outer", "full", "cross", "on",
  "insert", "into", "values", "update", "set", "delete", "group", "order", "by", "having", "limit",
  "offset", "fetch", "first", "rows", "only", "and", "or", "as", "case", "when", "then", "else",
  "end", "null", "is", "in", "exists", "union", "all", "distinct", "with", "asc", "desc"
]);
const WHERE_BOUNDARIES = new Set(["group", "order", "having", "limit", "offset", "fetch", "union"]);
const TABLE_PRECEDERS = new Set(["from", "join", "into", "update"]);

interface RelativeRange { from: number; to: number }
interface SqlToken extends RelativeRange { text: string; depth: number }

const scanSqlTokens = (sql: string): SqlToken[] => {
  const tokens: SqlToken[] = [];
  let depth = 0;
  for (let index = 0; index < sql.length;) {
    const character = sql[index];
    if (character === "'" || character === '"' || character === "`") {
      const quote = character;
      for (index += 1; index < sql.length; index += 1) {
        if (sql[index] === quote && sql[index + 1] === quote) { index += 1; continue; }
        if (sql[index] === quote) { index += 1; break; }
      }
      continue;
    }
    if (character === "-" && sql[index + 1] === "-") {
      const end = sql.indexOf("\n", index + 2);
      index = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (character === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      index = end < 0 ? sql.length : end + 2;
      continue;
    }
    if (character === "(") { depth += 1; index += 1; continue; }
    if (character === ")") { depth = Math.max(0, depth - 1); index += 1; continue; }
    const word = /^[A-Za-z_][\w$]*/.exec(sql.slice(index));
    if (!word) { index += 1; continue; }
    tokens.push({ text: word[0].toLowerCase(), from: index, to: index + word[0].length, depth });
    index += word[0].length;
  }
  return tokens;
};

const findSameDepth = (tokens: SqlToken[], after: number, depth: number, names: Set<string>): SqlToken | undefined => {
  for (let index = after + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.depth < depth) return token;
    if (token.depth === depth && names.has(token.text)) return token;
  }
  return undefined;
};

const findMutedRanges = (sql: string, tokens: SqlToken[]): RelativeRange[] => {
  const ranges: RelativeRange[] = [];
  tokens.forEach((token, index) => {
    if (token.text === "select") {
      const from = findSameDepth(tokens, index, token.depth, new Set(["from"]));
      if (from?.text === "from" && from.from > token.to) ranges.push({ from: token.to, to: from.from });
    }
    if (token.text === "where") {
      const boundary = findSameDepth(tokens, index, token.depth, WHERE_BOUNDARIES);
      const to = boundary?.from ?? sql.length;
      if (to > token.to) ranges.push({ from: token.to, to });
    }
  });
  return ranges;
};

const findTableRanges = (sql: string, tokens: SqlToken[]): RelativeRange[] => {
  const ranges: RelativeRange[] = [];
  tokens.forEach((token) => {
    if (!TABLE_PRECEDERS.has(token.text)) return;
    let cursor = token.to;
    while (/\s/.test(sql[cursor] ?? "")) cursor += 1;
    if (sql[cursor] === "(") return;
    const table = /^[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)*/.exec(sql.slice(cursor));
    if (table && !KEYWORDS.has(table[0].toLowerCase())) ranges.push({ from: cursor, to: cursor + table[0].length });
  });
  return ranges;
};

const mergeRanges = (ranges: RelativeRange[]): RelativeRange[] => {
  const sorted = [...ranges].filter(({ from, to }) => to > from).sort((left, right) => left.from - right.from || left.to - right.to);
  const merged: RelativeRange[] = [];
  sorted.forEach((range) => {
    const previous = merged.at(-1);
    if (previous && range.from <= previous.to) previous.to = Math.max(previous.to, range.to);
    else merged.push({ ...range });
  });
  return merged;
};

const subtractRanges = (ranges: RelativeRange[], blockers: RelativeRange[]): RelativeRange[] => {
  const result: RelativeRange[] = [];
  mergeRanges(ranges).forEach((range) => {
    let cursor = range.from;
    blockers.forEach((blocker) => {
      if (blocker.to <= cursor || blocker.from >= range.to) return;
      if (blocker.from > cursor) result.push({ from: cursor, to: Math.min(blocker.from, range.to) });
      cursor = Math.max(cursor, blocker.to);
    });
    if (cursor < range.to) result.push({ from: cursor, to: range.to });
  });
  return result;
};

export const highlightSql = (sql: string, base: number, highlights: LogHighlight[]): RelativeRange[] => {
  const tokens = scanSqlTokens(sql);
  const keywordRanges = tokens.filter(({ text }) => KEYWORDS.has(text)).map(({ from, to }) => ({ from, to }));
  const tableRanges = findTableRanges(sql, tokens);
  const priorityRanges = mergeRanges([...keywordRanges, ...tableRanges]);
  const mutedRanges = subtractRanges(findMutedRanges(sql, tokens), priorityRanges);
  mutedRanges.forEach(({ from, to }) => highlights.push({ from: base + from, to: base + to, kind: "sql-muted" }));
  keywordRanges.forEach(({ from, to }) => highlights.push({ from: base + from, to: base + to, kind: "sql-keyword" }));
  tableRanges.forEach(({ from, to }) => highlights.push({ from: base + from, to: base + to, kind: "sql-table" }));
  return mutedRanges;
};
