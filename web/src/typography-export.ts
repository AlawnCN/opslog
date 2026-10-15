// Static exported documents use the same inherited typography roles as the app.
export const adaptTypographyCss = (css: string): string => css.replace(/([;{]\s*)(font-size|font-family|font|line-height)\s*:\s*([^;}]+)/g, (whole: string, prefix: string, property: string, value: string) => {
  if (value.includes("--type-")) return whole;
  const scale = (text: string) => text.replace(/(\d+(?:\.\d+)?)px/g, "calc($1px * var(--type-scale,1))");
  if (property === "font-size" || property === "line-height") return `${prefix}${property}:${scale(value)}`;
  if (property === "font-family") return /^(inherit|initial|unset)$/.test(value.trim()) ? whole : `${prefix}font-family:var(--type-font,${value})`;
  const match = /^(.*?)(\d+(?:\.\d+)?px)(\s*\/\s*[^\s]+)?\s+(.+)$/s.exec(value);
  return match ? `${prefix}font:${match[1]}${scale(match[2])}${match[3] ? scale(match[3]) : ""} var(--type-font,${match[4]})` : whole;
});
