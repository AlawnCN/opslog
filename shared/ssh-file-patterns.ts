// Only the filename is a regex. Directory selection remains explicit and bounded.
export const splitFileRegex = (pattern: string) => /^\^(log|trc)\/(\{day\}\/)?([^/]+)\$$/.exec(pattern);
export const validFileRegex = (pattern: string): boolean => {
  const parts = splitFileRegex(pattern);
  if (!parts || pattern.length > 240 || /[\x00-\x1f]/.test(pattern) || /\(\?\??\s*\{/.test(pattern)) return false;
  try { new RegExp(`^(?:${parts[3]})$`); return true; } catch { return false; }
};

export const globToFileRegex = (pattern: string, generalizeNode = true): string => {
  const match = /^(log|trc)\/(\{day\}\/)?([^/]+)$/.exec(pattern);
  if (!match) return pattern;
  const filename = match[3]!;
  // Recognize the M5 node/instance/IP suffix, not arbitrary business IDs or dates.
  const node = generalizeNode ? /\.[A-Za-z][A-Za-z0-9-]*_\d+_\d+(?:\.\d+){0,3}(?=\.(?:trc|lst|log)(?:\.\d+)?$)/.exec(filename) : null;
  const escapeGlob = (value: string) => value.split("").map((char) => char === "*" ? ".*" : char === "?" ? "." : /[\\^$+.[\]{}()|]/.test(char) ? `\\${char}` : char).join("");
  const body = node
    ? `${escapeGlob(filename.slice(0,node.index))}\\.[A-Za-z][A-Za-z0-9-]*_\\d+_\\d+(?:\\.\\d+){0,3}${escapeGlob(filename.slice(node.index+node[0].length))}`
    : escapeGlob(filename);
  return `^${match[1]}/${match[2] ?? ""}${body}$`;
};

export const generalizeFileRegex = (pattern: string): string => pattern.replace(
  /\\\.[A-Za-z][A-Za-z0-9-]*_\d+_\d+(?:\\\.\d+){0,3}(?=\\\.(?:trc|lst|log)(?:\\\.\d+)?\$)/g,
  () => "\\.[A-Za-z][A-Za-z0-9-]*_\\d+_\\d+(?:\\.\\d+){0,3}",
);
