// Match the complete path relative to the user-maintained application root.
export const validFileGlob = (pattern: string): boolean => pattern.length > 0 && pattern.length <= 240
  && /^[A-Za-z0-9_.*?{}/-]+$/.test(pattern) && !pattern.startsWith("/")
  && !pattern.split("/").includes("..") && !/[{}]/.test(pattern.replaceAll("{day}", ""));
export const validFileRegex = (pattern: string): boolean => {
  if (!pattern || pattern.length > 240 || /[\x00-\x1f]/.test(pattern) || /\(\?\??\s*\{/.test(pattern)
    || /^\^?\//.test(pattern) || pattern.replace(/^\^/, "").split("/").includes("..")) return false;
  try { new RegExp(`^(?:${pattern.replaceAll("{day}", "(?:01|02)")})$`); return true; } catch { return false; }
};

export const globToFileRegex = (pattern: string, generalizeNode = true): string => {
  const slash = pattern.lastIndexOf("/");
  const directory = pattern.slice(0, slash + 1);
  const filename = pattern.slice(slash + 1);
  // Recognize the M5 node/instance/IP suffix, not arbitrary business IDs or dates.
  const node = generalizeNode ? /\.[A-Za-z][A-Za-z0-9-]*_\d+_\d+(?:\.\d+){0,3}(?=\.(?:trc|lst|log)(?:\.\d+)?$)/.exec(filename) : null;
  const escapeGlob = (value: string) => value.split("").map((char) => char === "*" ? ".*" : char === "?" ? "." : /[\\^$+.[\]{}()|]/.test(char) ? `\\${char}` : char).join("");
  const body = node
    ? `${escapeGlob(filename.slice(0,node.index))}\\.[A-Za-z][A-Za-z0-9-]*_\\d+_\\d+(?:\\.\\d+){0,3}${escapeGlob(filename.slice(node.index+node[0].length))}`
    : escapeGlob(filename);
  const prefix = directory.split("{day}").map(escapeGlob).join("{day}");
  return `^${prefix}${body}$`;
};

export const generalizeFileRegex = (pattern: string): string => pattern.replace(
  /\\\.[A-Za-z][A-Za-z0-9-]*_\d+_\d+(?:\\\.\d+){0,3}(?=\\\.(?:trc|lst|log)(?:\\\.\d+)?\$)/g,
  () => "\\.[A-Za-z][A-Za-z0-9-]*_\\d+_\\d+(?:\\.\\d+){0,3}",
);
