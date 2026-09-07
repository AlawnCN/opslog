import type { LogHighlight, StructuredLogRange } from "./transaction-log-model";

const STRUCTURE_MARKER = /(?:request|response|req|rsp|body|edb|object|argument|result|param(?:s)?)[^:=>]{0,40}(?::|=>|>>>|<<<)/i;
const JAVA_OBJECT = /\b[A-Z][\w$]*(?:<[^>\n]+>)?\s*\(/g;
const JSON_PRIMITIVE = /(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)\b/y;

const findBalancedEnd = (content: string, start: number, open: string, close: string, limit = content.length): number | undefined => {
  let depth = 0, quoted = false, escaped = false;
  for (let index = start; index < limit; index += 1) {
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

const findTagEnd = (content: string, start: number): number | undefined => {
  let quote = "";
  for (let index = start + 1; index < content.length; index += 1) {
    const character = content[index];
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === ">") return index + 1;
  }
  return undefined;
};

const findXmlEnd = (content: string, start: number): number | undefined => {
  const stack: string[] = [];
  for (let cursor = start; cursor < content.length;) {
    const tagFrom = content.indexOf("<", cursor);
    if (tagFrom < 0) return undefined;
    if (content.startsWith("<!--", tagFrom)) {
      const end = content.indexOf("-->", tagFrom + 4);
      if (end < 0) return undefined;
      cursor = end + 3;
      continue;
    }
    if (content.startsWith("<![CDATA[", tagFrom)) {
      const end = content.indexOf("]]>", tagFrom + 9);
      if (end < 0) return undefined;
      cursor = end + 3;
      continue;
    }
    const tagTo = findTagEnd(content, tagFrom);
    if (!tagTo) return undefined;
    const source = content.slice(tagFrom, tagTo);
    const closing = /^<\/\s*([A-Za-z_][\w:.-]*)/.exec(source);
    const opening = /^<\s*([A-Za-z_][\w:.-]*)/.exec(source);
    if (closing) {
      if (stack.at(-1) !== closing[1]) return undefined;
      stack.pop();
      if (stack.length === 0) return tagTo;
    } else if (opening && !/\/\s*>$/.test(source)) stack.push(opening[1]);
    cursor = tagTo;
  }
  return undefined;
};

const firstCompleteJavaObject = (content: string, from: number, to: number): StructuredLogRange | undefined => {
  JAVA_OBJECT.lastIndex = from;
  for (let match = JAVA_OBJECT.exec(content); match && match.index < to; match = JAVA_OBJECT.exec(content)) {
    const start = match.index + match[0].lastIndexOf("(");
    const end = findBalancedEnd(content, start, "(", ")");
    if (end && end - start >= 100) return { kind: "java", start, end };
  }
  return undefined;
};

const looksLikeJson = (content: string, start: number): boolean => {
  let next = start + 1;
  while (/\s/.test(content[next] ?? "")) next += 1;
  if (content[start] === "{") return content[next] === '"' || content[next] === "}";
  while (content[next] === "[") {
    next += 1;
    while (/\s/.test(content[next] ?? "")) next += 1;
  }
  return ["{", '"', "]"].includes(content[next]);
};

const nextLogHeader = (content: string, start: number): number => {
  const match = /\n(?:\d{4}-\d\d-\d\dT[^ ]+\s+\[[^\]]+]\s+\[[A-Z]+\d*]|\s*[A-Z]+\d*\[[^\]]+])/g.exec(content.slice(start));
  return match ? start + match.index : content.length;
};

const findJsonEnd = (content: string, start: number, open: string): number | undefined => {
  const limit = nextLogHeader(content, start + 1);
  const balanced = findBalancedEnd(content, start, open, open === "{" ? "}" : "]", limit);
  if (balanced || open !== "{" || !content.slice(start, limit).includes("\n")) return balanced;
  const rootClose = /\n}\s*(?:,)?\s*(?=\n|$)/g.exec(content.slice(start, limit));
  return rootClose ? start + rootClose.index + rootClose[0].indexOf("}") + 1 : undefined;
};

const firstCompleteJson = (content: string, from: number, to: number): StructuredLogRange | undefined => {
  for (let start = from; start < to; start += 1) {
    const open = content[start];
    if ((open !== "{" && open !== "[") || !looksLikeJson(content, start)) continue;
    const end = findJsonEnd(content, start, open);
    if (end) return { kind: "json", start, end };
  }
  return undefined;
};

export const findStructuredRange = (
  content: string, line: string, lineFrom: number, _lineTo: number, payloadFrom: number
): StructuredLogRange | undefined => {
  const payload = line.slice(payloadFrom);
  const marker = STRUCTURE_MARKER.exec(payload);
  const relativeFrom = payloadFrom + (marker ? marker.index + marker[0].length : 0);
  const searchFrom = lineFrom + relativeFrom;
  const searchTo = lineFrom + line.length;
  const xmlRelative = line.slice(relativeFrom).search(/<[A-Za-z_][\w:.-]*(?:\s|>|\/)/);
  if (xmlRelative >= 0 && (marker || /^\s*</.test(line.slice(relativeFrom)))) {
    const start = searchFrom + xmlRelative;
    const end = findXmlEnd(content, start);
    if (end) return { kind: "xml", start, end };
  }
  const java = firstCompleteJavaObject(content, searchFrom, searchTo);
  if (java && (marker || java.end - java.start >= 180)) return java;
  return marker || /^\s*[\[{]/.test(line.slice(relativeFrom))
    ? firstCompleteJson(content, searchFrom, searchTo)
    : undefined;
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

const highlightXmlTag = (source: string, base: number, highlights: LogHighlight[]) => {
  const name = /^<(?:\/\s*)?([A-Za-z_][\w:.-]*)/.exec(source);
  if (!name) return;
  const nameFrom = base + source.indexOf(name[1]);
  const prefixTo = nameFrom;
  if (prefixTo > base) highlights.push({ from: base, to: prefixTo, kind: "xml-punctuation" });
  highlights.push({ from: nameFrom, to: nameFrom + name[1].length, kind: "xml-name" });
  const attributes = /([A-Za-z_:][\w:.-]*)\s*=\s*("[^"]*"|'[^']*')/g;
  for (let attribute = attributes.exec(source); attribute; attribute = attributes.exec(source)) {
    const attributeFrom = base + attribute.index;
    const valueFrom = base + attribute.index + attribute[0].lastIndexOf(attribute[2]);
    highlights.push({ from: attributeFrom, to: attributeFrom + attribute[1].length, kind: "xml-attribute" });
    highlights.push({ from: valueFrom, to: valueFrom + attribute[2].length, kind: "xml-string" });
  }
  const suffixFrom = base + Math.max(source.lastIndexOf("/>"), source.lastIndexOf(">"));
  highlights.push({ from: suffixFrom, to: base + source.length, kind: "xml-punctuation" });
};

export const highlightXml = (content: string, from: number, to: number, highlights: LogHighlight[]) => {
  for (let cursor = from; cursor < to;) {
    const tagFrom = content.indexOf("<", cursor);
    if (tagFrom < 0 || tagFrom >= to) break;
    if (content.startsWith("<!--", tagFrom)) {
      const end = content.indexOf("-->", tagFrom + 4);
      if (end < 0 || end + 3 > to) break;
      highlights.push({ from: tagFrom, to: end + 3, kind: "xml-comment" });
      cursor = end + 3;
      continue;
    }
    const tagTo = findTagEnd(content, tagFrom);
    if (!tagTo || tagTo > to) break;
    highlightXmlTag(content.slice(tagFrom, tagTo), tagFrom, highlights);
    cursor = tagTo;
  }
};
