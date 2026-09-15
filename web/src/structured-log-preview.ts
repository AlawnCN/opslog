import { highlightJson, highlightXml } from "./transaction-log-structured";
import type { LogHighlight } from "./transaction-log-model";

export type InspectableLogStructureKind = "json" | "xml";

export interface StructuredLogPreview {
  kind: InspectableLogStructureKind;
  content: string;
  highlights: LogHighlight[];
  folds: StructuredPreviewFold[];
  error?: string;
}

export interface StructuredPreviewFold {
  lineFrom: number;
  from: number;
  to: number;
}

export const directChildStructuredPreviewFolds = (
  folds: StructuredPreviewFold[],
  parent: Pick<StructuredPreviewFold, "from" | "to">
): StructuredPreviewFold[] => folds.filter((candidate) => {
  if (candidate.from <= parent.from || candidate.to >= parent.to) return false;
  return !folds.some((possibleParent) =>
    possibleParent.from > parent.from
    && possibleParent.to < parent.to
    && possibleParent.from < candidate.from
    && possibleParent.to > candidate.to
  );
});

interface XmlToken {
  source: string;
  tag: boolean;
}

const xmlTagEnd = (source: string, start: number): number => {
  if (source.startsWith("<!--", start)) {
    const end = source.indexOf("-->", start + 4);
    return end < 0 ? source.length : end + 3;
  }
  if (source.startsWith("<![CDATA[", start)) {
    const end = source.indexOf("]]>", start + 9);
    return end < 0 ? source.length : end + 3;
  }
  if (source.startsWith("<?", start)) {
    const end = source.indexOf("?>", start + 2);
    return end < 0 ? source.length : end + 2;
  }
  let quote = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'") quote = character;
    else if (character === ">") return index + 1;
  }
  return source.length;
};

const tokenizeXml = (source: string): XmlToken[] => {
  const tokens: XmlToken[] = [];
  for (let cursor = 0; cursor < source.length;) {
    if (source[cursor] === "<") {
      const end = xmlTagEnd(source, cursor);
      tokens.push({ source: source.slice(cursor, end), tag: true });
      cursor = end;
      continue;
    }
    const next = source.indexOf("<", cursor);
    const end = next < 0 ? source.length : next;
    tokens.push({ source: source.slice(cursor, end), tag: false });
    cursor = end;
  }
  return tokens;
};

const openingTagName = (source: string): string | undefined =>
  /^<\s*([A-Za-z_][\w:.-]*)/.exec(source)?.[1];

const closingTagName = (source: string): string | undefined =>
  /^<\/\s*([A-Za-z_][\w:.-]*)/.exec(source)?.[1];

const isStandaloneTag = (source: string): boolean =>
  /^<(?:\?|!)/.test(source) || /\/\s*>$/.test(source);

const indentedText = (source: string, depth: number): string[] => source
  .trim()
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => `${"  ".repeat(depth)}${line}`);

export const formatXmlLogStructure = (source: string): string => {
  const tokens = tokenizeXml(source.trim());
  const lines: string[] = [];
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.tag) {
      lines.push(...indentedText(token.source, depth));
      continue;
    }

    const opening = openingTagName(token.source);
    const text = tokens[index + 1];
    const closing = tokens[index + 2];
    if (opening && text && !text.tag && closing?.tag && closingTagName(closing.source) === opening) {
      lines.push(`${"  ".repeat(depth)}${token.source}${text.source.trim()}${closing.source}`);
      index += 2;
      continue;
    }

    if (closingTagName(token.source)) depth = Math.max(0, depth - 1);
    lines.push(`${"  ".repeat(depth)}${token.source.trim()}`);
    if (opening && !isStandaloneTag(token.source)) depth += 1;
  }
  return lines.join("\n");
};

const lineStartAt = (content: string, position: number): number => content.lastIndexOf("\n", position - 1) + 1;

const jsonPreviewFolds = (content: string): StructuredPreviewFold[] => {
  const folds: StructuredPreviewFold[] = [];
  const stack: Array<{ close: string; open: number; lineFrom: number }> = [];
  let quote = false, escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (escaped) { escaped = false; continue; }
    if (quote) {
      if (character === "\\") escaped = true;
      else if (character === '"') quote = false;
      continue;
    }
    if (character === '"') { quote = true; continue; }
    if (character === "{" || character === "[") {
      stack.push({ close: character === "{" ? "}" : "]", open: index, lineFrom: lineStartAt(content, index) });
      continue;
    }
    const opened = stack.at(-1);
    if (!opened || character !== opened.close) continue;
    stack.pop();
    if (lineStartAt(content, index) > opened.lineFrom) {
      folds.push({ lineFrom: opened.lineFrom, from: opened.open + 1, to: index });
    }
  }
  return folds;
};

const xmlPreviewFolds = (content: string): StructuredPreviewFold[] => {
  const folds: StructuredPreviewFold[] = [];
  const stack: Array<{ name: string; tagTo: number; lineFrom: number }> = [];
  for (let cursor = 0; cursor < content.length;) {
    const tagFrom = content.indexOf("<", cursor);
    if (tagFrom < 0) break;
    const tagTo = xmlTagEnd(content, tagFrom);
    const tag = content.slice(tagFrom, tagTo);
    const closing = closingTagName(tag);
    if (closing) {
      const opened = stack.at(-1);
      if (opened?.name === closing) {
        stack.pop();
        if (lineStartAt(content, tagFrom) > opened.lineFrom) {
          folds.push({ lineFrom: opened.lineFrom, from: opened.tagTo, to: tagFrom });
        }
      }
    } else {
      const opening = openingTagName(tag);
      if (opening && !isStandaloneTag(tag)) stack.push({ name: opening, tagTo, lineFrom: lineStartAt(content, tagFrom) });
    }
    cursor = Math.max(tagTo, tagFrom + 1);
  }
  return folds;
};

export const findStructuredPreviewFolds = (
  kind: InspectableLogStructureKind,
  content: string
): StructuredPreviewFold[] => (kind === "json" ? jsonPreviewFolds(content) : xmlPreviewFolds(content))
  .sort((left, right) => left.lineFrom - right.lineFrom || right.to - left.to);

export const formatStructuredLogPreview = (
  kind: InspectableLogStructureKind,
  source: string
): StructuredLogPreview => {
  let content = source.trim();
  let error: string | undefined;
  if (kind === "json") {
    try {
      const parsed: unknown = JSON.parse(source);
      const previewValue = Array.isArray(parsed)
        && parsed.length === 1
        && typeof parsed[0] === "object"
        && parsed[0] !== null
        && !Array.isArray(parsed[0])
        ? parsed[0]
        : parsed;
      content = JSON.stringify(previewValue, null, 2);
    } catch {
      error = "JSON 内容不完整，暂时显示原始结构";
    }
  } else content = formatXmlLogStructure(source);
  const highlights: LogHighlight[] = [];
  if (kind === "json") highlightJson(content, 0, content.length, highlights);
  else highlightXml(content, 0, content.length, highlights);
  return { kind, content, highlights, folds: findStructuredPreviewFolds(kind, content), error };
};
