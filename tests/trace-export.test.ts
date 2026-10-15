import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { buildTraceHtml, traceExportFilename } from "../web/src/trace-export";
import { buildTraceModel, filterTraceTree } from "../web/src/trace-model";
import { traceExportRuntime } from "../web/src/trace-export-runtime";
import { THEMES } from "../web/src/theme";

const rows = [
  { "@timestamp": "2026-10-15T08:00:00.000Z", "transaction.id": "root", "transaction.name": "POST /payments", "transaction.duration.us": 500_000, "processor.event": "transaction", "service.name": "gateway" },
  { "@timestamp": "2026-10-15T08:00:00.050Z", "span.id": "service", "parent.id": "root", "span.name": "PaymentService#execute", "span.duration.us": 300_000, "service.name": "payments" },
  { "@timestamp": "2026-10-15T08:00:00.100Z", "span.id": "sql", "parent.id": "service", "span.name": "SELECT", "span.duration.us": 40_000, "span.type": "db", "db.statement": "select * from t_pay_txn where req_bus_no = ?", "service.name": "payments" },
  { "@timestamp": "2026-10-15T08:00:00.200Z", "span.id": "redis", "parent.id": "root", "span.name": "HGET unrelated", "span.duration.us": 2000, "service.name": "cache" }
];

class Element {
  value = ""; textContent = ""; hidden = false; disabled = false;
  attributes = new Map<string, string>(); classes = new Set<string>();
  listeners = new Map<string, () => void>();
  classList = { toggle: (name: string, enabled: boolean) => { if (enabled) this.classes.add(name); else this.classes.delete(name); } };
  toggle?: Element;
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  addEventListener(name: string, listener: () => void) { this.listeners.set(name, listener); }
  querySelector() { return this.toggle; }
  focus() {} select() {}
  fire(name: string) { assert.ok(!this.disabled); this.listeners.get(name)?.(); }
}

const openDocument = (keyword = "", collapsed = new Set<string>()) => {
  const html = buildTraceHtml({ traceId: "trace-1", rows, keyword, collapsed, timeZone: "Asia/Shanghai" });
  const data = /<script id="trace-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1];
  const snapshot = JSON.parse(data) as { nodes: { key: string; hasChildren: boolean }[] };
  const elements = new Map(["trace-data", "trace-search", "trace-count", "trace-empty", "trace-clear", "trace-collapse", "trace-expand"].map(id => [id, new Element()]));
  elements.get("trace-data")!.textContent = data;
  const articles = snapshot.nodes.map(node => { const element = new Element(); if (node.hasChildren) element.toggle = new Element(); return element; });
  runInNewContext(traceExportRuntime, { document: { getElementById: (id: string) => elements.get(id), querySelectorAll: () => articles, addEventListener: () => undefined } });
  const search = (text: string) => { const input = elements.get("trace-search")!; input.value = text; input.fire("input"); };
  const visible = () => articles.flatMap((article, index) => article.hidden ? [] : [snapshot.nodes[index].key]);
  return { html, elements, articles, search, visible };
};

test("Trace HTML embeds complete fields, time axis, timezone and an offline runtime", () => {
  const { html } = openDocument("T_PAY_TXN", new Set(["root:0"]));
  assert.match(html, /data-trace-index="3"/);
  assert.match(html, /select \* from t_pay_txn where req_bus_no = \?/);
  assert.match(html, /2026-10-15 16:00:00.100/);
  assert.match(html, /500.00 ms/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /<meta name="generator" content="opslog-trace-snapshot">/);
  assert.doesNotMatch(html, /<script[^>]+src=|<link\b|fetch\(|localStorage|https?:\/\//);
});

test("offline filtering matches the live view, including SQL, services, IDs and ancestor paths", () => {
  const exported = openDocument();
  const model = buildTraceModel(rows);
  for (const keyword of ["T_PAY_TXN SELECT", "payments", "gateway", "sql", "service sql", "中文无匹配", " "]) {
    exported.search(keyword);
    assert.deepEqual(exported.visible(), filterTraceTree(model.roots, new Set(), keyword).visible.map(({ node }) => node.key));
  }
  exported.search("T_PAY_TXN");
  assert.equal(exported.elements.get("trace-count")!.textContent, "命中 1 / 4 · 保留父级路径");
  assert.equal(exported.articles[0].classes.has("is-context"), true);
  assert.equal(exported.elements.get("trace-collapse")!.disabled, true);
  exported.search("不存在");
  assert.equal(exported.elements.get("trace-empty")!.hidden, false);
});

test("export preserves current view but clearing search restores folds without dropping spans", () => {
  const exported = openDocument("t_pay_txn", new Set(["root:0"]));
  assert.equal(exported.visible().length, 3);
  exported.elements.get("trace-clear")!.fire("click");
  assert.deepEqual(exported.visible(), ["root:0"]);
  exported.elements.get("trace-expand")!.fire("click");
  assert.equal(exported.visible().length, 4);
  exported.elements.get("trace-collapse")!.fire("click");
  exported.articles[0].toggle!.fire("click");
  assert.deepEqual(exported.visible(), ["root:0", "service:1", "redis:3"]);
  assert.equal(exported.articles[0].toggle!.attributes.get("aria-expanded"), "true");
});

test("untrusted names, SQL and IDs cannot escape markup or the embedded JSON script", () => {
  const malicious = '</script><script>globalThis.pwned=true</script><img src=x onerror=alert(1)> & "';
  const html = buildTraceHtml({ traceId: malicious, rows: [{ ...rows[0], "transaction.name": malicious, "db.statement": malicious, "span.id": malicious }], keyword: malicious });
  assert.doesNotMatch(html, /<script>globalThis.pwned|<img src=x/);
  assert.equal((html.match(/<script\b/g) ?? []).length, 2);
  const snapshot = JSON.parse(/<script id="trace-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]);
  assert.equal(snapshot.keyword, malicious);
  assert.ok(snapshot.nodes[0].searchText.includes(malicious.toLowerCase()));
  assert.equal(traceExportFilename('../trace:123/<x>'), "trace-.._trace_123__x_.html");
});

test("every exported theme captures its material palette and keeps duration heat semantic", () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalComputed = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
  const root = { dataset: { theme: "cyberpunk" } };
  Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: root } });
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: (name: string) => name === "--canvas" ? "#fff5f7" : name === "--text" ? "#1d1d1f" : "" }) });
  try {
    for (const theme of THEMES) {
      root.dataset.theme = theme.value;
      const html = buildTraceHtml({ traceId: "theme-test", rows });
      assert.ok(html.includes(`data-theme="${theme.value}"`));
      assert.match(html, /\.fast \.duration-bar\{background:#43e2a6\}/);
      assert.match(html, /\.warning \.duration-bar\{background:#e0c05e\}/);
      if (theme.value !== "cyberpunk") assert.match(html, /--canvas:#fff5f7/);
    }
  } finally {
    for (const [key, descriptor] of [["document", originalDocument], ["getComputedStyle", originalComputed]] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("empty Trace exports remain readable and report no matches", () => {
  const html = buildTraceHtml({ traceId: "empty", rows: [] });
  assert.match(html, /SPAN 数量：0/);
  assert.match(html, /"nodes":\[\]/);
});
