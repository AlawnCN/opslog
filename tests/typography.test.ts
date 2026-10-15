import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { defaultTypography, normalizeTypography, fontFamily, validCustomFont, saveTypography, readTypography, initializeTypography, captureTypographyStyles, TYPOGRAPHY_KEY } from "../web/src/typography-preferences";
import { adaptTypographyCss } from "../web/src/typography-export";
import { measureTableColumnWidth } from "../web/src/table-auto-width";
import { READER_SETTINGS_KEYS } from "../web/src/reader-settings-storage";

test("font settings use concise category labels without requirement prose", () => {
  const source = readFileSync(new URL("../web/src/components/TypographySettings.tsx", import.meta.url), "utf8");
  assert.match(source, /<h2>字体设置<\/h2>/);
  assert.match(source, />全部重置<\/button>/);
  assert.match(source, /title=\{item.description\}/);
  assert.doesNotMatch(source, /APPEARANCE|恢复此项|恢复全部默认|<small>\{item.description\}|字体使用本机资源|运行环境　开始时间　执行查询/);
});

test("font categories are independent and malformed persisted preferences are bounded", () => {
  const preferences = normalizeTypography({ ui: { size: 99, family: "unknown" }, log: { size: 18, family: "mono" }, table: { size: NaN }, reading: { family: "custom", customFamily: '</style><script>' } });
  assert.equal(preferences.ui.size, 20);
  assert.equal(preferences.ui.family, "theme");
  assert.equal(preferences.log.size, 18);
  assert.equal(preferences.log.family, "mono");
  assert.equal(preferences.table.size, null);
  assert.equal(preferences.reading.family, "theme");
  assert.deepEqual(normalizeTypography(null), defaultTypography());
  assert.equal(validCustomFont("思源黑体"), true);
  assert.equal(validCustomFont("Font; color:red"), false);
  assert.match(fontFamily({ family: "custom", size: 16, customFamily: "Cascadia Code" }, "log"), /^"Cascadia Code",ui-monospace/);
});

test("save, cold initialization, reset and export preserve role-specific typography", () => {
  const descriptors = ["window", "document"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const values = new Map<string, string>(), storage = new Map<string, string>(), attributes = new Set<string>();
  const elements = new Map<string, { id: string; textContent: string }>();
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) }, dispatchEvent() {}, addEventListener() {}, removeEventListener() {} } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    documentElement: { style: { setProperty: (key: string, value: string) => values.set(key, value), removeProperty: (key: string) => values.delete(key), getPropertyValue: (key: string) => values.get(key) ?? "" }, toggleAttribute: (key: string, enabled: boolean) => enabled ? attributes.add(key) : attributes.delete(key) },
    getElementById: (key: string) => elements.get(key), createElement: () => ({ id: "", textContent: "" }), head: { append: (element: { id: string; textContent: string }) => elements.set(element.id, element) }
  } });
  try {
    const preferences = defaultTypography(); preferences.log = { family: "mono", size: 18, customFamily: "" };
    saveTypography(preferences);
    assert.equal(readTypography().log.size, 18);
    assert.equal(values.get("--type-log-size"), "18px");
    assert.equal(values.get("--type-ui-scale"), "1");
    assert.equal(attributes.has("data-typography-ui"), false);
    assert.ok(storage.has(TYPOGRAPHY_KEY));
    values.clear(); initializeTypography();
    assert.equal(values.get("--type-log-size"), "18px");
    assert.match(captureTypographyStyles(), /--type-log-size:18px/);
    assert.match(captureTypographyStyles(), /--type-table-scale/);
    assert.equal(elements.size, 1);
    saveTypography(defaultTypography());
    assert.equal(values.has("--type-log-size"), false);
    assert.equal(values.has("--type-log-font"), false);
    assert.ok(READER_SETTINGS_KEYS.includes(TYPOGRAPHY_KEY));
  } finally {
    for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

test("export conversion scales only text properties and is idempotent", () => {
  const css = '.test{width:120px;font:600 12px/18px monospace;padding:10px;font-size:14px;font-family:system-ui}';
  const converted = adaptTypographyCss(css);
  assert.match(converted, /width:120px/); assert.match(converted, /padding:10px/);
  assert.match(converted, /font:600 calc\(12px \* var\(--type-scale,1\)\)\/calc\(18px \* var\(--type-scale,1\)\)/);
  assert.match(converted, /font-family:var\(--type-font,system-ui\)/);
  assert.equal(adaptTypographyCss(converted), converted);
});

test("column auto-fit measures content, actual fonts, multiline cells and boundaries", () => {
  const descriptors = ["document", "getComputedStyle"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const fonts: string[] = [];
  const context = { font: "", measureText(text: string) { fonts.push(this.font); return { width: text.length * (this.font.includes("18px") ? 18 : 10) }; } };
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => ({ getContext: () => context }) } });
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: (element: { font: string }) => ({ font: element.font, letterSpacing: "1px", paddingLeft: "10px", paddingRight: "10px", borderLeftWidth: "1px", borderRightWidth: "1px" }) });
  const table = { rows: [{ cells: [{ textContent: "ID", font: "10px mono" }] }, { cells: [{ textContent: "中文长内容\nx", font: "18px mono" }] }] };
  try {
    assert.equal(measureTableColumnWidth(table as unknown as HTMLTableElement, 0), 136);
    assert.ok(fonts.includes("18px mono"));
    assert.equal(measureTableColumnWidth(table as unknown as HTMLTableElement, 0, 80, 100), 100);
    assert.equal(measureTableColumnWidth(table as unknown as HTMLTableElement, 1), 80);
  } finally {
    for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
