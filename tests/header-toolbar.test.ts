import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Header } from "../web/src/components/Header";
import { EnvironmentPicker } from "../web/src/components/EnvironmentPicker";

test("toolbar groups appearance and gives environment priority without losing accessible actions", () => {
  const noop = () => {};
  const previous = Object.getOwnPropertyDescriptor(globalThis, "React");
  Object.defineProperty(globalThis, "React", { configurable: true, value: React });
  try {
  const html = renderToStaticMarkup(createElement(Header, {
    environments: [], selected: "", onSelect: noop, loading: false, desktopMode: false, canImportConfig: true,
    lanShare: { enabled: false, busy: false, enable: async () => {}, disable: async () => {} },
    onConfigure: noop, updateAvailable: false, updateBusy: false, onCheckForUpdates: noop
  }));
  assert.ok(html.indexOf('class="environment-control"') < html.indexOf('class="appearance-control"'));
  assert.match(html, /class="appearance-control" role="group" aria-label="外观设置"/);
  assert.match(html, /aria-label="环境配置"/);
  assert.match(html, /aria-label="字体设置"/);
  assert.match(html, /role="status"/);
  assert.match(html, /environment-picker-status is-idle/);
  assert.doesNotMatch(html, /<span>环境<\/span>|class="connection-state/);
  assert.doesNotMatch(html, /<span>配置<\/span>/);
  for (const tone of ["connecting", "ready", "error"] as const) {
    const picker = renderToStaticMarkup(createElement(EnvironmentPicker, { environments: [], value: "", onChange: noop, status: { label: tone, tone } }));
    assert.match(picker, new RegExp(`environment-picker-status is-${tone}`));
    assert.match(picker, new RegExp(`aria-busy="${tone === "connecting"}"`));
  }
  } finally {
    if (previous) Object.defineProperty(globalThis, "React", previous); else Reflect.deleteProperty(globalThis, "React");
  }
});

test("toolbar CSS scopes presentation, shares control height and avoids clipping focus effects", () => {
  const css = readFileSync(new URL("../web/src/header-toolbar.css", import.meta.url), "utf8");
  assert.match(css, /--toolbar-height:/);
  assert.match(css, /height: var\(--toolbar-height\)/);
  assert.match(css, /\.appearance-control[^{}]*\{[^{}]*box-shadow: var\(--control-shadow,none\)/);
  assert.doesNotMatch(css, /\.appearance-control[^{}]*\{[^{}]*overflow: hidden/);
  assert.match(css, /@media\(max-width:720px\)/);
});
