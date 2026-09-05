import type { LogHighlight } from "./transaction-log-model";

const SQL_KEYWORDS = /\b(?:select|from|where|join|left|right|inner|outer|on|insert|into|values|update|set|delete|group|order|by|having|limit|offset|fetch|first|rows|only|and|or|as|case|when|then|else|end|null|is|in|exists|union|all)\b/gi;
const SQL_TABLE = /\b(?:from|join|into|update)\s+([A-Za-z_][\w.$]*)/gi;

interface RelativeRange { from: number; to: number }

const findMutedRanges = (sql: string): RelativeRange[] => {
  const ranges: RelativeRange[] = [];
  const select = /\bselect\b/i.exec(sql);
  if (select) {
    const afterSelect = select.index + select[0].length;
    const from = /\bfrom\b/i.exec(sql.slice(afterSelect));
    if (from && from.index > 0) ranges.push({ from: afterSelect, to: afterSelect + from.index });
  }
  const where = /\bwhere\b/i.exec(sql);
  if (where) {
    const start = where.index + where[0].length;
    const boundary = /\b(?:group\s+by|order\s+by|having|limit|offset|fetch|union)\b/i.exec(sql.slice(start));
    ranges.push({ from: start, to: boundary ? start + boundary.index : sql.length });
  }
  return ranges.filter(({ from, to }) => to > from);
};

export const highlightSql = (sql: string, base: number, highlights: LogHighlight[]): RelativeRange[] => {
  const mutedRanges = findMutedRanges(sql);
  mutedRanges.forEach(({ from, to }) => highlights.push({ from: base + from, to: base + to, kind: "sql-muted" }));
  SQL_KEYWORDS.lastIndex = 0;
  for (let match = SQL_KEYWORDS.exec(sql); match; match = SQL_KEYWORDS.exec(sql)) {
    const insideMuted = mutedRanges.some(({ from, to }) => match.index >= from && match.index < to);
    if (!insideMuted) highlights.push({ from: base + match.index, to: base + match.index + match[0].length, kind: "sql-keyword" });
  }
  SQL_TABLE.lastIndex = 0;
  for (let match = SQL_TABLE.exec(sql); match; match = SQL_TABLE.exec(sql)) {
    const tableOffset = match.index + match[0].lastIndexOf(match[1]);
    highlights.push({ from: base + tableOffset, to: base + tableOffset + match[1].length, kind: "sql-table" });
  }
  return mutedRanges;
};
