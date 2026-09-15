export type JavaObjectScalarKind = "null" | "boolean" | "number" | "string" | "plain";

export interface JavaObjectPreviewMember {
  name: string;
  value: JavaObjectPreviewNode;
}

export interface JavaObjectPreviewNode {
  kind: "object" | "list" | "map" | "scalar";
  typeName?: string;
  scalarKind?: JavaObjectScalarKind;
  value?: string;
  members: JavaObjectPreviewMember[];
}

const compositePairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

const topLevelParts = (source: string, assignmentsOnly: boolean): string[] => {
  const parts: string[] = [];
  const stack: string[] = [];
  let from = 0, quote = "", escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) { escaped = false; continue; }
    if (quote) {
      if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'") { quote = character; continue; }
    if (compositePairs[character]) { stack.push(compositePairs[character]); continue; }
    if (character === stack.at(-1)) { stack.pop(); continue; }
    const startsNextField = /^\s*[A-Za-z_$][\w$]*\s*=/.test(source.slice(index + 1));
    if (character === "," && stack.length === 0 && (!assignmentsOnly || startsNextField)) {
      parts.push(source.slice(from, index).trim());
      from = index + 1;
    }
  }
  parts.push(source.slice(from).trim());
  return parts.filter(Boolean);
};

const topLevelAssignment = (source: string): number => {
  const stack: string[] = [];
  let quote = "", escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) { escaped = false; continue; }
    if (quote) {
      if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'") { quote = character; continue; }
    if (compositePairs[character]) { stack.push(compositePairs[character]); continue; }
    if (character === stack.at(-1)) { stack.pop(); continue; }
    if (character === "=" && stack.length === 0) return index;
  }
  return -1;
};

const scalarNode = (source: string): JavaObjectPreviewNode => {
  const value = source.trim();
  const scalarKind: JavaObjectScalarKind = value === "null"
    ? "null"
    : /^(?:true|false)$/i.test(value)
      ? "boolean"
      : /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)
        ? "number"
        : /^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/.test(value)
          ? "string"
          : "plain";
  return { kind: "scalar", scalarKind, value, members: [] };
};

const parseMembers = (source: string, depth: number, indexed: boolean): JavaObjectPreviewMember[] =>
  topLevelParts(source, !indexed).map((part, index) => {
    if (indexed) return { name: `[${index}]`, value: parseJavaValue(part, depth + 1) };
    const assignment = topLevelAssignment(part);
    if (assignment < 0) return { name: `[${index}]`, value: parseJavaValue(part, depth + 1) };
    return {
      name: part.slice(0, assignment).trim(),
      value: parseJavaValue(part.slice(assignment + 1), depth + 1)
    };
  });

const parseJavaValue = (source: string, depth = 0): JavaObjectPreviewNode => {
  const value = source.trim();
  if (depth > 80) return scalarNode(value);
  const object = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:<[^>]+>)?)\s*\(([\s\S]*)\)$/.exec(value);
  if (object) return { kind: "object", typeName: object[1], members: parseMembers(object[2], depth, false) };
  if (value.startsWith("[") && value.endsWith("]")) {
    return { kind: "list", typeName: "List", members: parseMembers(value.slice(1, -1), depth, true) };
  }
  if (value.startsWith("{") && value.endsWith("}")) {
    return { kind: "map", typeName: "Map", members: parseMembers(value.slice(1, -1), depth, false) };
  }
  return scalarNode(value);
};

export const parseJavaObjectPreview = (source: string): JavaObjectPreviewNode => parseJavaValue(source);

export const javaObjectSourceStart = (content: string, openingParenthesis: number): number => {
  const lineFrom = content.lastIndexOf("\n", openingParenthesis - 1) + 1;
  const prefix = content.slice(lineFrom, openingParenthesis);
  const match = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:<[^>\n]+>)?\s*$/.exec(prefix);
  return match ? lineFrom + match.index : openingParenthesis;
};
