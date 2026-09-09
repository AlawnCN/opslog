export const MAX_LOG_SEARCH_MATCHES = 5_000;

export interface LogSearchMatch {
  from: number;
  to: number;
}

export interface LogSearchResult {
  matches: LogSearchMatch[];
  error?: string;
}

export const findPlainLogMatchesInLowercase = (source: string, query: string, limit = MAX_LOG_SEARCH_MATCHES): LogSearchMatch[] => {
  if (!query) return [];
  const needle = query.toLocaleLowerCase();
  const matches: LogSearchMatch[] = [];
  for (let from = 0, match = source.indexOf(needle); match >= 0; match = source.indexOf(needle, from)) {
    matches.push({ from: match, to: match + needle.length });
    if (matches.length >= limit) return matches;
    from = match + needle.length;
  }
  return matches;
};

const advancePastEmptyMatch = (source: string, index: number): number => {
  if (index >= source.length) return source.length + 1;
  return index + ((source.codePointAt(index) ?? 0) > 0xffff ? 2 : 1);
};

export const findRegexLogMatches = (source: string, pattern: string, limit = MAX_LOG_SEARCH_MATCHES): LogSearchResult => {
  if (!pattern) return { matches: [] };
  let expression: RegExp;
  try {
    expression = new RegExp(pattern, "gimu");
  } catch {
    return { matches: [], error: "正则表达式格式有误" };
  }

  const matches: LogSearchMatch[] = [];
  for (let match = expression.exec(source); match; match = expression.exec(source)) {
    if (!match[0].length) {
      expression.lastIndex = advancePastEmptyMatch(source, expression.lastIndex);
      continue;
    }
    matches.push({ from: match.index, to: match.index + match[0].length });
    if (matches.length >= limit) break;
  }
  return { matches };
};
