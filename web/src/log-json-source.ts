export interface ParsedJsonLogSource {
  content: string;
  value: unknown;
  escaped: boolean;
}

export interface DecodedJsonLogSource {
  content: string;
  rawEnds: number[];
}

const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t"
};

export const decodeJsonLogEscapeLayer = (source: string): DecodedJsonLogSource => {
  let content = "";
  const rawEnds: number[] = [];
  for (let index = 0; index < source.length;) {
    if (source[index] !== "\\" || index + 1 >= source.length) {
      content += source[index];
      rawEnds.push(index + 1);
      index += 1;
      continue;
    }
    const escaped = source[index + 1];
    if (escaped === "u" && /^[\da-fA-F]{4}$/.test(source.slice(index + 2, index + 6))) {
      content += String.fromCharCode(Number.parseInt(source.slice(index + 2, index + 6), 16));
      rawEnds.push(index + 6);
      index += 6;
      continue;
    }
    const decoded = SIMPLE_ESCAPES[escaped];
    if (decoded === undefined) {
      content += source[index];
      rawEnds.push(index + 1);
      index += 1;
      continue;
    }
    content += decoded;
    rawEnds.push(index + 2);
    index += 2;
  }
  return { content, rawEnds };
};

const compositeJsonValue = (value: unknown): boolean =>
  value !== null && typeof value === "object";

export const parseJsonLogSource = (source: string): ParsedJsonLogSource | undefined => {
  const original = source.trim();
  let content = original;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const value: unknown = JSON.parse(content);
      if (compositeJsonValue(value)) return { content, value, escaped: content !== original };
      if (typeof value !== "string" || !/^\s*[\[{]/.test(value)) return undefined;
      content = value.trim();
      continue;
    } catch {
      const decoded = decodeJsonLogEscapeLayer(content).content;
      if (decoded === content) return undefined;
      content = decoded.trim();
    }
  }
  return undefined;
};
