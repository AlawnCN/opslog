import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import postcss from "postcss";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { ThemePicker } from "../web/src/components/ThemePicker";
import { currentTheme, initializeTheme, normalizeTheme, setTheme, subscribeTheme, THEME_KEY, THEMES } from "../web/src/theme";
import { hydrateReaderSettings, readerSettingsStorage, READER_SETTINGS_KEYS } from "../web/src/reader-settings-storage";
import { captureHtmlExportTheme } from "../web/src/html-export-theme";
import { buildAiAnalysisHtml } from "../web/src/ai-analysis-export";

const stylesheet = (name: string) => readFileSync(new URL(`../web/src/${name}`, import.meta.url), "utf8");

test("offline HTML captures every selected theme without external CSS or local storage dependencies", () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousComputed = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
  const root = { dataset: { theme: "cyberpunk" } };
  Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: root } });
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({
    getPropertyValue: (key: string) => key === "--canvas" ? "#f5f5f7" : key === "--text" ? "#1d1d1f" : key === "--scene" ? '</style><script>alert(1)</script>' : ""
  }) });
  try {
    for (const definition of THEMES) {
      root.dataset.theme = definition.value;
      const snapshot = captureHtmlExportTheme();
      const html = buildAiAnalysisHtml("log-1", { provider: "test", model: "test", durationMs: 1, inputCharacters: 1, truncated: false, content: "test" });
      assert.match(html, new RegExp(`data-theme="${definition.value}"`));
      assert.match(html, new RegExp(`data-theme-tone="${definition.tone}"`));
      if (definition.value === "cyberpunk") assert.equal(snapshot.styles, "");
      else {
        assert.match(snapshot.styles, /--canvas:#f5f5f7/);
        assert.match(snapshot.styles, /--text:#1d1d1f/);
        assert.ok(html.includes(snapshot.styles));
        assert.doesNotMatch(snapshot.styles, /<\/style>|<script>|@import|https?:|localStorage/);
        assert.match(snapshot.styles, /\.portable-preview-dialog/);
        assert.match(snapshot.styles, /\.cm-log-code-error/);
        assert.match(snapshot.styles, /prefers-reduced-motion/);
        postcss.parse(snapshot.styles);
      }
    }
    root.dataset.theme = '" onload="alert(1)';
    assert.match(captureHtmlExportTheme().attributes, /^data-theme="cyberpunk"/);
    const source = stylesheet("portable-log-export.ts");
    assert.match(source, /const theme = captureHtmlExportTheme\(\)/);
    assert.match(source, /<html lang="zh-CN" \$\{theme.attributes\}>/);
    assert.match(source, /\$\{portableStyles\}\\n\$\{theme.styles\}/);
    assert.ok(source.indexOf("captureHtmlExportTheme();") < source.indexOf("await encodeCompressed"), "capture theme before asynchronous compression");
  } finally {
    for (const [key, descriptor] of [["document", previousDocument], ["getComputedStyle", previousComputed]] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("theme picker renders the app combobox, never a native system select", () => {
  const markup = renderToStaticMarkup(createElement(ThemePicker));
  assert.doesNotMatch(markup, /<(select|option|label)\b/);
  assert.match(markup, /role="combobox"/);
  assert.match(markup, /aria-label="界面主题"/);
  assert.match(markup, /aria-haspopup="listbox"/);
  assert.match(markup, /aria-expanded="false"/);
  assert.match(markup, />Cyberpunk<\/span>/);
  assert.equal((markup.match(/<button\b/g) ?? []).length, 1);
  assert.match(markup, /<button\b[^>]*><svg[\s\S]*<\/svg><span>Cyberpunk<\/span>/, "icon and label share a single clickable surface");
});

test("Cyber Anime exports HUD decoration and hex grid without clipping content", () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousComputed = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
  const palette = postcss.parse(stylesheet("theme-palettes-extra.css"));
  const values = new Map<string, string>();
  palette.walkRules(':root[data-theme="cyber-anime"]', (rule) => {
    rule.walkDecls((declaration) => { values.set(declaration.prop, declaration.value); });
  });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { dataset: { theme: "cyber-anime" } } } });
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: (key: string) => values.get(key) ?? "" }) });
  try {
    const snapshot = captureHtmlExportTheme();
    assert.match(snapshot.attributes, /data-theme-tone="dark"/);
    assert.ok(snapshot.styles.includes(`--scene:${values.get("--scene")}`));
    assert.ok(snapshot.styles.includes(`--hud-panel-background:${values.get("--hud-panel-background")}`));
    assert.match(snapshot.styles, /background:var\(--hud-panel-background\)/);
    assert.equal(values.get("--radius"), "0px");
    assert.equal(values.get("--focus-color"), "#06d6a0");
    palette.walkRules((rule) => {
      if (rule.selector.includes('data-theme="cyber-anime"')) {
        rule.walkDecls("clip-path", () => assert.fail("HUD decoration must not clip controls or content"));
      }
    });
    postcss.parse(snapshot.styles);
  } finally {
    for (const [key, descriptor] of [["document", previousDocument], ["getComputedStyle", previousComputed]] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("compound theme controls have a single material owner and flat inner segments", () => {
  const styles = postcss.parse(stylesheet("themes.css"));
  const compound = styles.nodes.find((node) => node.type === "rule" && node.selector.endsWith(".ssh-ai-actions) button"));
  assert.ok(compound && compound.type === "rule");
  assert.match(compound.selector, /\.ai-analysis-export/);
  const values = new Map<string, string>();
  compound.walkDecls((declaration) => { values.set(declaration.prop, declaration.value); });
  assert.equal(values.get("border-radius"), "0");
  assert.equal(values.get("background"), "transparent");
  assert.equal(values.get("--control-hover-shadow"), "none");
  assert.equal(values.get("--press-scale"), "1");
  assert.equal(values.get("--hover-lift"), "0 0");
});

test("clipped theme controls keep motion inside their material and focus boundaries", () => {
  const styles = postcss.parse(stylesheet("themes.css"));
  const rules = styles.nodes.filter((node) => node.type === "rule");
  const bounded = rules.find((node) => node.type === "rule" && node.selector.includes(".ai-profile-list,") && node.selector.endsWith(" button"));
  assert.ok(bounded && bounded.type === "rule");
  for (const selector of [".app-select-menu", ".table-shell", ".log-reader-body", ".reader-titlebar", ".log-reader-search-group", ".custom-marker-track"]) assert.ok(bounded.selector.includes(selector));
  const declarations = new Map<string, string>();
  bounded.walkDecls((declaration) => { declarations.set(declaration.prop, declaration.value); });
  assert.equal(declarations.get("--hover-lift"), "0 0");
  assert.equal(declarations.get("--press-scale"), "1");
  for (const token of ["--control-shadow", "--control-hover-shadow", "--control-pressed-shadow", "translate", "scale"]) assert.equal(declarations.get(token), "none");
  const focus = rules.filter((node) => node.type === "rule" && node.selector.includes("button:focus-visible"));
  assert.ok(focus.length >= 2);
  for (const node of focus) {
    if (node.type !== "rule") continue;
    const values = new Map<string, string>();
    node.walkDecls((declaration) => { values.set(declaration.prop, declaration.value); });
    assert.equal(values.get("outline-offset"), "-3px");
    assert.notEqual(values.get("outline"), "none");
  }
  const selected = rules.find((node) => node.type === "rule" && node.selector.includes('.ai-analysis-formats button[aria-pressed="true"]'));
  assert.ok(selected && selected.type === "rule");
  selected.walkDecls("box-shadow", (declaration) => assert.match(declaration.value, /^inset /));
});

test("theme palettes keep body, muted, semantic and editor text readable", () => {
  const palettes = postcss.parse(stylesheet("theme-palettes.css") + stylesheet("theme-palettes-extra.css"));
  const luminance = (hex: string) => {
    assert.match(hex, /^#[0-9a-f]{6}$/i);
    const rgb = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
      .map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  };
  const contrast = (foreground: string, background: string) => {
    const a = luminance(foreground), b = luminance(background);
    return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
  };
  for (const { value } of THEMES.filter(({ value }) => value !== "cyberpunk")) {
    const tokens = new Map<string, string>();
    palettes.walkRules(`:root[data-theme="${value}"]`, (rule) => {
      rule.walkDecls((declaration) => { tokens.set(declaration.prop, declaration.value); });
    });
    for (const background of ["--canvas", "--surface-solid", "--editor-surface"]) {
      const surface = tokens.get(background) ?? tokens.get("--surface-solid")!;
      for (const foreground of ["--text", "--muted", "--accent-text", "--red", "--green", "--amber"]) {
        assert.ok(contrast(tokens.get(foreground)!, surface) >= 4.5, `${value}: ${foreground} on ${background}`);
      }
    }
  }
});

test("theme motion preserves positioned controls and provides accessible fallback states", () => {
  const components = postcss.parse(stylesheet("theme-components.css"));
  components.walkDecls("transform", () => assert.fail("theme must not overwrite positioning transforms"));
  const utilityRule = components.nodes.find((node) => node.type === "rule" && node.selector.includes(".password-input-toggle,"));
  assert.ok(utilityRule && utilityRule.type === "rule");
  const utilityTokens = new Map<string, string>();
  utilityRule.walkDecls((declaration) => { utilityTokens.set(declaration.prop, declaration.value); });
  assert.equal(utilityTokens.get("--hover-lift"), "0 0");
  assert.equal(utilityTokens.get("--press-scale"), "1");
  assert.match(stylesheet("theme-components.css"), /:focus-visible/);
  assert.match(stylesheet("theme-components.css"), /@supports not \(backdrop-filter/);
  assert.match(stylesheet("themes.css"), /prefers-reduced-motion: reduce/);
  assert.match(stylesheet("theme-palettes.css"), /--font-mono:.*Consolas/);
  assert.match(stylesheet("themes.css"), /reader-family-mark.*stroke: var\(--accent-text\)/);
});

test("theme accepts only supported IDs and keeps Cyberpunk as default", () => {
  for (const value of [null, undefined, "", "dark", {}, "<script>"]) assert.equal(normalizeTheme(value), "cyberpunk");
  assert.equal(THEMES.length, 14);
  for (const { value, description } of THEMES) {
    assert.equal(normalizeTheme(value), value);
    assert.match(description, /[\u4e00-\u9fff]/, `${value} has a Chinese description`);
  }
  assert.ok(READER_SETTINGS_KEYS.includes(THEME_KEY));
});

test("theme switches, persists, restores and synchronizes without touching environment settings", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const values = new Map([["environment", "unchanged"]]);
  let blocked = false;
  let metaColor = "";
  const fakeWindow = Object.assign(new EventTarget(), {
    localStorage: {
      getItem: (key: string) => { if (blocked) throw new Error("blocked"); return values.get(key) ?? null; },
      setItem: (key: string, value: string) => { if (blocked) throw new Error("blocked"); values.set(key, value); }
    }
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    documentElement: { dataset: {} },
    querySelector: () => ({ setAttribute: (_key: string, value: string) => { metaColor = value; } })
  } });
  try {
    initializeTheme();
    assert.equal(currentTheme(), "cyberpunk");
    let notifications = 0;
    const unsubscribe = subscribeTheme(() => { notifications++; });
    setTheme("neumorphism");
    assert.equal(currentTheme(), "neumorphism");
    assert.equal(metaColor, "#e0e5ec");
    assert.equal(values.get(THEME_KEY), "neumorphism");
    assert.equal(notifications, 1);
    values.set(THEME_KEY, "cyberpunk");
    fakeWindow.dispatchEvent(Object.assign(new Event("storage"), { key: THEME_KEY }));
    assert.equal(currentTheme(), "cyberpunk");
    assert.equal(notifications, 2);
    for (const definition of THEMES) {
      setTheme(definition.value);
      assert.equal(currentTheme(), definition.value);
      assert.equal(metaColor, definition.canvas);
      assert.equal(values.get(THEME_KEY), definition.value);
      initializeTheme();
      assert.equal(currentTheme(), definition.value);
      assert.equal(document.documentElement.dataset.themeTone, definition.tone);
      assert.equal(document.documentElement.dataset.themeUi, definition.value === "cyberpunk" ? "classic" : "modern");
    }
    const beforeUnrelated = notifications;
    fakeWindow.dispatchEvent(Object.assign(new Event("storage"), { key: "environment" }));
    assert.equal(notifications, beforeUnrelated);
    values.delete(THEME_KEY);
    fakeWindow.dispatchEvent(Object.assign(new Event("storage"), { key: null }));
    assert.equal(currentTheme(), "cyberpunk");
    assert.equal(notifications, beforeUnrelated + 1, "reinitializing must not duplicate storage listeners");
    values.set(THEME_KEY, "neumorphism");
    initializeTheme();
    assert.equal(currentTheme(), "neumorphism");
    unsubscribe();
    blocked = true;
    setTheme("cyberpunk");
    assert.equal(currentTheme(), "cyberpunk");
    assert.equal(metaColor, "#06111f");
    assert.equal(values.get("environment"), "unchanged");
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else Reflect.deleteProperty(globalThis, "document");
  }
});

test("desktop theme writes remain ordered and restore from native storage on cold startup", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousTauri = Object.getOwnPropertyDescriptor(globalThis, "isTauri");
  const local = new Map<string, string>();
  const native = new Map<string, string>();
  const writes: string[] = [];
  let releaseFirst: (() => void) | undefined;
  let blockBrowser = false;
  let rejectNext = false;
  const firstWrite = new Promise<void>((resolve) => { releaseFirst = resolve; });
  Object.defineProperty(globalThis, "window", { configurable: true, value: Object.assign(new EventTarget(), {
    crypto: globalThis.crypto,
    localStorage: {
      getItem: (key: string) => local.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (blockBrowser) throw new Error("browser storage blocked");
        local.set(key, value);
      }
    }
  }) });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    documentElement: { dataset: {} }, querySelector: () => null
  } });
  Object.defineProperty(globalThis, "isTauri", { configurable: true, value: true });
  mockIPC(async (command, payload) => {
    if (command === "load_reader_settings") return Object.fromEntries(native);
    assert.equal(command, "save_reader_setting");
    assert.ok(payload && "input" in payload);
    const input = payload.input as { key: string; value: string };
    writes.push(input.value);
    if (writes.length === 1) await firstWrite;
    if (rejectNext) { rejectNext = false; throw new Error("temporary write failure"); }
    native.set(input.key, input.value);
  });
  try {
    setTheme("soft-ui");
    setTheme("apple-style");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(writes, ["soft-ui"], "later writes wait for the previous native write");
    releaseFirst?.();
    await hydrateReaderSettings();
    assert.equal(native.get(THEME_KEY), "apple-style");
    for (const definition of THEMES) {
      setTheme(definition.value);
      await hydrateReaderSettings();
      local.clear();
      await hydrateReaderSettings();
      initializeTheme();
      assert.equal(currentTheme(), definition.value, `${definition.value} restores without browser preferences`);
    }
    blockBrowser = true;
    setTheme("natural-organic");
    await hydrateReaderSettings();
    assert.equal(native.get(THEME_KEY), "natural-organic", "native save survives unavailable browser storage");
    blockBrowser = false;
    rejectNext = true;
    readerSettingsStorage.setItem(THEME_KEY, "dark-mode");
    readerSettingsStorage.setItem(THEME_KEY, "notion-style");
    await hydrateReaderSettings();
    assert.equal(native.get(THEME_KEY), "notion-style", "failed save does not block subsequent changes");
    for (const entry of ["main.tsx", "reader-main.tsx"]) {
      assert.match(stylesheet(entry), /await hydrateReaderSettings\(\);\s*initializeTheme\(\)/);
    }
  } finally {
    releaseFirst?.();
    clearMocks();
    for (const [key, descriptor] of [["window", previousWindow], ["document", previousDocument], ["isTauri", previousTauri]] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
