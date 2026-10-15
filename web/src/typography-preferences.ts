import { readerSettingsStorage } from "./reader-settings-storage";

export const TYPOGRAPHY_KEY = "opslog.appearance.typography.v1";
export const TYPOGRAPHY_EVENT = "opslog-typography-change";
export const FONT_CATEGORIES = [
  { id: "ui", label: "界面", description: "导航与控件", base: 12, maximum: 20 },
  { id: "table", label: "表格", description: "数据表格与调用链", base: 11, maximum: 28 },
  { id: "log", label: "代码", description: "日志与结构化数据", base: 11, maximum: 32 },
  { id: "reading", label: "文档", description: "分析报告与更新说明", base: 11, maximum: 32 }
] as const;
export type FontCategory = typeof FONT_CATEGORIES[number]["id"];
export const FONT_OPTIONS = [
  { value: "theme", label: "跟随主题" },
  { value: "system", label: "系统字体" },
  { value: "mono", label: "等宽字体" },
  { value: "yahei", label: "微软雅黑" },
  { value: "pingfang", label: "苹方" },
  { value: "source-han", label: "思源黑体" },
  { value: "jetbrains", label: "JetBrains Mono" },
  { value: "custom", label: "自定义字体" }
] as const;
type FontChoice = typeof FONT_OPTIONS[number]["value"];
export interface FontPreference { family: FontChoice; size: number | null; customFamily: string }
export type TypographyPreferences = Record<FontCategory, FontPreference>;
const system = 'system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif';
const mono = 'ui-monospace,"SFMono-Regular",Menlo,Consolas,"Liberation Mono",monospace';
const families: Partial<Record<FontChoice, string>> = {
  system, mono, yahei: `"Microsoft YaHei",${system}`, pingfang: `"PingFang SC",${system}`,
  "source-han": `"Source Han Sans SC","Noto Sans CJK SC",${system}`, jetbrains: `"JetBrains Mono",${mono}`
};
export const validCustomFont = (name: string): boolean => /^[\p{L}\p{N} ._'-]{1,80}$/u.test(name.trim());
export const fontFamily = (preference: FontPreference, category: FontCategory): string => {
  if (preference.family === "custom" && validCustomFont(preference.customFamily)) return `${JSON.stringify(preference.customFamily.trim())},${category === "log" ? mono : system}`;
  return families[preference.family] ?? (category === "log" ? "var(--font-mono)" : "var(--font-ui)");
};
export const defaultTypography = (): TypographyPreferences => Object.fromEntries(FONT_CATEGORIES.map(({ id }) => [id, { family: "theme", size: null, customFamily: "" }])) as TypographyPreferences;

export const normalizeTypography = (value: unknown): TypographyPreferences => {
  const result = defaultTypography();
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const category of FONT_CATEGORIES) {
    const item: unknown = Reflect.get(value, category.id);
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const family = Reflect.get(item, "family"), size = Reflect.get(item, "size"), custom = Reflect.get(item, "customFamily");
    result[category.id] = {
      family: FONT_OPTIONS.find(option => option.value === family)?.value ?? "theme",
      size: typeof size === "number" && Number.isFinite(size) ? Math.round(Math.max(10, Math.min(category.maximum, size))) : null,
      customFamily: typeof custom === "string" && validCustomFont(custom) ? custom.trim() : ""
    };
    if (result[category.id].family === "custom" && !result[category.id].customFamily) result[category.id].family = "theme";
  }
  return result;
};

export const readTypography = (): TypographyPreferences => {
  try { return normalizeTypography(JSON.parse(readerSettingsStorage.getItem(TYPOGRAPHY_KEY) ?? "null")); }
  catch { return defaultTypography(); }
};

export const typographyScopeStyles = `
:root{--type-scale:var(--type-ui-scale,1);--type-font:var(--type-ui-font)}
:is(.table-shell,.trace-waterfall-shell,.trace-tooltip,.resizable-markdown-table,.trace-snapshot .waterfall){--type-scale:var(--type-table-scale,1);--type-font:var(--type-table-font);font-family:var(--type-font,var(--font-ui))}
:is(.structured-log-viewer,.structured-preview-editor,.java-object-tree,.log-outline-preview,.outline-preview,.log-line,.portable-preview-code,pre,code){--type-scale:var(--type-log-scale,1);--type-font:var(--type-log-font);font-family:var(--type-font,var(--font-mono))}
:is(.ai-analysis-markdown,.release-notes-markdown,.update-notes,.portable-analysis-content,.page>.content){--type-scale:var(--type-reading-scale,1);--type-font:var(--type-reading-font);font-family:var(--type-font,var(--font-ui))}
.resizable-markdown-table{--type-scale:var(--type-table-scale,1);--type-font:var(--type-table-font);font-family:var(--type-font,var(--font-ui))}
.trace-snapshot .content{--type-scale:var(--type-table-scale,1);--type-font:var(--type-table-font)}
.trace-snapshot pre,.trace-snapshot code{--type-scale:var(--type-log-scale,1);--type-font:var(--type-log-font)}
`;

const applyTypography = (preferences: TypographyPreferences): void => {
  const root = document.documentElement;
  let scopes = document.getElementById("opslog-typography-scopes");
  if (!scopes) { scopes = document.createElement("style"); scopes.id = "opslog-typography-scopes"; scopes.textContent = typographyScopeStyles; document.head.append(scopes); }
  for (const category of FONT_CATEGORIES) {
    const preference = preferences[category.id];
    root.style.setProperty(`--type-${category.id}-scale`, String((preference.size ?? category.base) / category.base));
    if (preference.family === "theme") root.style.removeProperty(`--type-${category.id}-font`);
    else root.style.setProperty(`--type-${category.id}-font`, fontFamily(preference, category.id));
    if (preference.size === null) root.style.removeProperty(`--type-${category.id}-size`);
    else root.style.setProperty(`--type-${category.id}-size`, `${preference.size}px`);
  }
  root.toggleAttribute("data-typography-ui", preferences.ui.size !== null || preferences.ui.family !== "theme");
};
const storageChanged = (event: StorageEvent) => {
  if (event.key !== TYPOGRAPHY_KEY && event.key !== null) return;
  applyTypography(readTypography()); window.dispatchEvent(new Event(TYPOGRAPHY_EVENT));
};
export const initializeTypography = (): void => {
  applyTypography(readTypography());
  window.removeEventListener("storage", storageChanged); window.addEventListener("storage", storageChanged);
};
export const saveTypography = (value: TypographyPreferences): void => {
  const preferences = normalizeTypography(value);
  readerSettingsStorage.setItem(TYPOGRAPHY_KEY, JSON.stringify(preferences));
  applyTypography(preferences); window.dispatchEvent(new Event(TYPOGRAPHY_EVENT));
};

export const captureTypographyStyles = (): string => {
  if (typeof document === "undefined") return "";
  const declarations = FONT_CATEGORIES.flatMap(({ id }) => ["scale", "size", "font"].flatMap(token => {
    const name = `--type-${id}-${token}`, value = document.documentElement.style?.getPropertyValue(name);
    return value && !/[<>{};]/.test(value) ? [`${name}:${value}`] : [];
  })).join(";");
  if (!declarations) return "";
  const computed = typeof getComputedStyle === "undefined" ? undefined : getComputedStyle(document.documentElement);
  const fonts = ["--font-ui", "--font-mono"].flatMap(name => {
    const value = computed?.getPropertyValue(name);
    return value && !/[<>{};]/.test(value) ? [`${name}:${value}`] : [];
  }).join(";");
  return `:root{${declarations}${fonts ? `;${fonts}` : ""}}\n${typographyScopeStyles}`;
};
