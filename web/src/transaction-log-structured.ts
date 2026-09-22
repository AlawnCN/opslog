import type { LogHighlight, StructuredLogRange } from "./transaction-log-model";
import { decodeJsonLogEscapeLayer, parseJsonLogSource } from "./log-json-source";

const STRUCTURE_MARKER = /\b(?:(?:request|response|req(?!BusNo\b)|rsp|body|edb)\w*|object|argument|result|params?)\b[^:=>]{0,40}(?::|=>|=|>>>|<<<)/i;
const WRAPPED_XML_ASSIGNMENT = /\b(?:request|response|req|rsp|body|edb)\w*\s*=\s*\[?\s*(?=<)/i;
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

const findTagEnd = (content: string, start: number, limit = content.length): number | undefined => {
  let quote = "";
  for (let index = start + 1; index < limit; index += 1) {
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

const findXmlEnd = (content: string, start: number, limit: number): number | undefined => {
  const stack: string[] = [];
  for (let cursor = start; cursor < limit;) {
    const tagFrom = content.indexOf("<", cursor);
    if (tagFrom < 0 || tagFrom >= limit) return undefined;
    if (content.startsWith("<!--", tagFrom)) {
      const end = content.indexOf("-->", tagFrom + 4);
      if (end < 0 || end + 3 > limit) return undefined;
      cursor = end + 3;
      continue;
    }
    if (content.startsWith("<![CDATA[", tagFrom)) {
      const end = content.indexOf("]]>", tagFrom + 9);
      if (end < 0 || end + 3 > limit) return undefined;
      cursor = end + 3;
      continue;
    }
    const tagTo = findTagEnd(content, tagFrom, limit);
    if (!tagTo) return undefined;
    const source = content.slice(tagFrom, tagTo);
    const closing = /^<\/\s*([A-Za-z_][\w:.-]*)/.exec(source);
    const opening = /^<\s*([A-Za-z_][\w:.-]*)/.exec(source);
    if (closing) {
      if (stack.at(-1) !== closing[1]) return undefined;
      stack.pop();
      if (stack.length === 0) return tagTo;
    } else if (opening) {
      if (/\/\s*>$/.test(source)) {
        if (stack.length === 0) return tagTo;
      } else stack.push(opening[1]);
    }
    cursor = tagTo;
  }
  return undefined;
};

const enclosingJavaCollection = (
  content: string,
  from: number,
  objectFrom: number,
  objectTo: number,
  limit: number
): StructuredLogRange | undefined => {
  let cursor = objectFrom - 1;
  let collection: StructuredLogRange | undefined;
  while (cursor >= from) {
    while (cursor >= from && /\s/.test(content[cursor])) cursor -= 1;
    if (content[cursor] !== "[") break;
    const start = cursor;
    const end = findBalancedEnd(content, start, "[", "]", limit);
    if (!end || end < objectTo) break;
    collection = { kind: "java", start, end };
    cursor -= 1;
  }
  return collection;
};

const firstCompleteJavaObject = (content: string, from: number, to: number): StructuredLogRange | undefined => {
  const limit = nextLogHeader(content, from + 1);
  JAVA_OBJECT.lastIndex = from;
  for (let match = JAVA_OBJECT.exec(content); match && match.index < to; match = JAVA_OBJECT.exec(content)) {
    const start = match.index + match[0].lastIndexOf("(");
    const end = findBalancedEnd(content, start, "(", ")", limit);
    if (!end) continue;
    for (let bracket = content.indexOf("[", from); bracket >= from && bracket < match.index; bracket = content.indexOf("[", bracket + 1)) {
      const bracketEnd = findBalancedEnd(content, bracket, "[", "]", limit);
      if (bracketEnd && bracketEnd >= end && bracketEnd - bracket >= 100) {
        return { kind: "java", start: bracket, end: bracketEnd };
      }
    }
    // A collection may be preceded by an assignment marker or other text on
    // the same line. Recover the nearest balanced bracket when the immediate
    // whitespace walk cannot see it, preserving the complete outer list.
    let collection = enclosingJavaCollection(content, from, match.index, end, limit);
    if (!collection) {
      // Search all candidate opening brackets on the line. This also covers
      // payloads written as `field=[Type(...), ...]` where the marker text
      // separates the bracket from the first object match.
      for (let bracket = content.indexOf("[", from); bracket >= from && bracket < match.index; bracket = content.indexOf("[", bracket + 1)) {
        const bracketEnd = findBalancedEnd(content, bracket, "[", "]", limit);
        if (bracketEnd && bracketEnd >= end && bracketEnd - bracket >= 100) {
          collection = { kind: "java", start: bracket, end: bracketEnd };
          break;
        }
      }
    }
    if (collection && collection.end - collection.start >= 100) return collection;
    if (end - start >= 100) return { kind: "java", start, end };
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

const parsedJsonEnd = (content: string, start: number, limit: number): number | undefined => {
  const open = content[start];
  let candidate = content.slice(start, limit);
  let rawEnds = Array.from({ length: candidate.length }, (_, index) => index + 1);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const end = findBalancedEnd(candidate, 0, open, open === "{" ? "}" : "]");
    if (end && parseJsonLogSource(candidate.slice(0, end))) return start + rawEnds[end - 1];
    const decoded = decodeJsonLogEscapeLayer(candidate);
    if (decoded.content === candidate) return undefined;
    rawEnds = decoded.rawEnds.map((previousEnd) => rawEnds[previousEnd - 1]);
    candidate = decoded.content;
  }
  return undefined;
};

const findJsonEnd = (content: string, start: number, open: string): number | undefined => {
  const limit = nextLogHeader(content, start + 1);
  return parsedJsonEnd(content, start, limit);
};

const jsonCandidateBoundary = (content: string, start: number, from: number): boolean => {
  if (start === from) return true;
  let previous = start - 1;
  while (previous >= from && /\s/.test(content[previous])) previous -= 1;
  if (previous < from || /[:=>\[]/.test(content[previous])) return true;
  if (content[previous] !== '"' && content[previous] !== "'") return false;
  previous -= 1;
  while (previous >= from && /\s/.test(content[previous])) previous -= 1;
  return previous < from || /[:=>\[]/.test(content[previous]);
};

const xmlCandidateBoundary = (content: string, start: number, from: number): boolean => {
  if (start === from) return true;
  let previous = start - 1;
  while (previous >= from && /\s/.test(content[previous])) previous -= 1;
  return previous < from || /[:=>\[]/.test(content[previous]);
};

const firstCompleteJson = (content: string, from: number, to: number): StructuredLogRange | undefined => {
  for (let start = from; start < to; start += 1) {
    const open = content[start];
    if ((open !== "{" && open !== "[") || !jsonCandidateBoundary(content, start, from)) continue;
    if (!looksLikeJson(content, start) && !/\\+"/.test(content.slice(start, Math.min(start + 16, to)))) continue;
    const end = findJsonEnd(content, start, open);
    if (end) return { kind: "json", start, end };
  }
  return undefined;
};

export const findStructuredRange = (
  content: string, line: string, lineFrom: number, _lineTo: number, payloadFrom: number
): StructuredLogRange | undefined => {
  const payload = line.slice(payloadFrom);
  const containsSql = /(?:execute\s+sql|\bsql)\s*[:=]\s*\[?/i.test(payload);
  const marker = WRAPPED_XML_ASSIGNMENT.exec(payload) ?? STRUCTURE_MARKER.exec(payload);
  const relativeFrom = payloadFrom + (marker ? marker.index + marker[0].length : 0);
  const searchFrom = lineFrom + relativeFrom;
  const searchTo = lineFrom + line.length;
  const xmlRelative = line.slice(relativeFrom).search(/<\?xml\b|<[A-Za-z_][\w:.-]*(?:\s|>|\/)/i);
  if (xmlRelative >= 0) {
    const start = searchFrom + xmlRelative;
    if (xmlCandidateBoundary(content, start, searchFrom)) {
      const end = findXmlEnd(content, start, nextLogHeader(content, start + 1));
      if (end) return { kind: "xml", start, end };
    }
  }
  const java = containsSql ? undefined : firstCompleteJavaObject(content, searchFrom, searchTo);
  if (java && (marker || java.end - java.start >= 180)) return java;
  return firstCompleteJson(content, searchFrom, searchTo);
};

export const highlightJson = (content: string, from: number, to: number, highlights: LogHighlight[]) => {
  const source = content.slice(from, to);
  if (parseJsonLogSource(source)?.escaped) {
    const token = /\\"(?:\\\\.|[^"\\])*\\"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b|[{}\[\]]/g;
    for (let match = token.exec(source); match; match = token.exec(source)) {
      const value = match[0];
      let kind: LogHighlight["kind"] = "json-punctuation";
      if (value.startsWith('\\"')) {
        kind = /^\s*:/.test(source.slice(match.index + value.length)) ? "json-key" : "json-string";
      } else if (/^-?\d/.test(value)) kind = "json-number";
      else if (/^(?:true|false|null)$/.test(value)) kind = "json-literal";
      highlights.push({ from: from + match.index, to: from + match.index + value.length, kind });
    }
    return;
  }
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
