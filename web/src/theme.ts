import { readerSettingsStorage } from "./reader-settings-storage";

export const THEME_KEY = "opslog.appearance.theme.v1";
export const THEMES = [
  { value: "cyberpunk", label: "Cyberpunk", description: "赛博朋克 · 深蓝底色与霓虹强调", canvas: "#06111f", tone: "dark" },
  { value: "neumorphism", label: "Neumorphism", description: "新拟态 · 灰白基底与凹凸软阴影", canvas: "#e0e5ec", tone: "light" },
  { value: "glassmorphism", label: "Glassmorphism", description: "玻璃拟态 · 深色磨砂与香槟色高光", canvas: "#0b1322", tone: "dark" },
  { value: "stripe-style", label: "Stripe Style", description: "Stripe 风格 · 清爽卡片与紫色强调", canvas: "#f6f9fc", tone: "light" },
  { value: "fluent-design", label: "Fluent Design", description: "流畅设计 · 中性浅色与蓝色强调", canvas: "#f3f2f1", tone: "light" },
  { value: "soft-ui", label: "Soft UI", description: "柔和界面 · 圆润卡片与轻柔彩色阴影", canvas: "#f8fafc", tone: "light" },
  { value: "natural-organic", label: "Natural Organic", description: "自然有机 · 奶油暖色与大地色调", canvas: "#faf6f1", tone: "light" },
  { value: "modern-gradient", label: "Modern Gradient", description: "现代渐变 · 深色光场与紫红渐变", canvas: "#020617", tone: "dark" },
  { value: "dark-mode", label: "Dark Mode", description: "暗黑模式 · 低亮度层次与蓝色高光", canvas: "#0f172a", tone: "dark" },
  { value: "claymorphism", label: "Claymorphism", description: "粘土拟态 · 糖果色与柔软立体质感", canvas: "#fef3c7", tone: "light" },
  { value: "notion-style", label: "Notion Style", description: "Notion 风格 · 米白文档与极简交互", canvas: "#f7f6f3", tone: "light" },
  { value: "apple-style", label: "Apple Style", description: "Apple 风格 · 精致留白与简洁蓝白", canvas: "#f5f5f7", tone: "light" },
  { value: "shoujo-manga", label: "Shoujo Manga", description: "少女漫画 · 樱花粉、花形装饰与柔和网点", canvas: "#fff5f7", tone: "light" },
  { value: "cyber-anime", label: "Cyber Anime", description: "赛博动漫 · 紫色霓虹、机甲边框与全息网格", canvas: "#0f0f1a", tone: "dark" }
] as const;
export type Theme = typeof THEMES[number]["value"];
export const normalizeTheme = (value: unknown): Theme => THEMES.find((theme) => theme.value === value)?.value ?? "cyberpunk";

export const readTheme = (): Theme => {
  try { return normalizeTheme(readerSettingsStorage.getItem(THEME_KEY)); }
  catch { return "cyberpunk"; }
};

const applyTheme = (theme: Theme): void => {
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themeUi = theme === "cyberpunk" ? "classic" : "modern";
  const definition = THEMES.find((candidate) => candidate.value === theme) ?? THEMES[0];
  document.documentElement.dataset.themeTone = definition.tone;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", definition.canvas);
};

const handleStorageChange = (event: StorageEvent): void => {
  if (event.key !== THEME_KEY && event.key !== null) return;
  applyTheme(readTheme());
  window.dispatchEvent(new Event("opslog-theme-change"));
};

export const initializeTheme = (): void => {
  applyTheme(readTheme());
  window.removeEventListener("storage", handleStorageChange);
  window.addEventListener("storage", handleStorageChange);
};

export const setTheme = (value: Theme): void => {
  const theme = normalizeTheme(value);
  applyTheme(theme);
  try { readerSettingsStorage.setItem(THEME_KEY, theme); }
  catch { /* Switching still works when browser storage is unavailable. */ }
  window.dispatchEvent(new Event("opslog-theme-change"));
};

export const subscribeTheme = (listener: () => void): (() => void) => {
  window.addEventListener("opslog-theme-change", listener);
  return () => window.removeEventListener("opslog-theme-change", listener);
};

export const currentTheme = (): Theme => normalizeTheme(document.documentElement.dataset.theme);
