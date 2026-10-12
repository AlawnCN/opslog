import assert from "node:assert/strict";
import test from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SshServerProbe } from "../web/src/components/SshServerProbe";

test("connection test shares the server header with secondary actions", () => {
  // The root Node test runner uses classic JSX; Vite uses the automatic runtime.
  const previousReact = Object.getOwnPropertyDescriptor(globalThis, "React");
  Object.defineProperty(globalThis, "React", { configurable: true, value: React });
  let html: string;
  try { html = renderToStaticMarkup(createElement(SshServerProbe, {
    name: "test-server",
    server: { name: "test-server", host: "test-server", authentication: "ssh-config" },
    actions: createElement("button", { "aria-label": "移除服务器" }, "删除"),
    onTrust: () => undefined,
  })); } finally {
    if (previousReact) Object.defineProperty(globalThis, "React", previousReact);
    else Reflect.deleteProperty(globalThis, "React");
  }
  assert.match(html, /class="ssh-server-heading"><strong>test-server<\/strong><span class="ssh-server-probe-status" role="status"><\/span>/);
  assert.match(html, /role="group" aria-label="test-server 操作"/);
  assert.match(html, /class="ssh-server-test-button"[^>]*aria-busy="false"/);
  assert.match(html, /<\/svg><\/button><button aria-label="移除服务器"/);
  assert.doesNotMatch(html, /<small|不保存|不读取|测试连接/);
  assert.match(html, /aria-label="探测服务器状态"/);
  assert.match(html, /title="探测服务器状态"/);
});
