import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TraceDrawer } from "../web/src/components/TraceDrawer.tsx";
import { buildTraceModel, durationSeverity, flattenTraceTree, filterTraceTree, traceNodeTiming } from "../web/src/trace-model.ts";
import { clampTraceColumnWidth, TRACE_COLUMN_DEFAULT } from "../web/src/components/useTraceColumnWidth.ts";

const rows = [
  { "@timestamp": "2026-09-11T08:00:00.000Z", "transaction.id": "root", "transaction.name": "POST /payments", "transaction.duration.us": 500_000, "processor.event": "transaction", "service.name": "gateway" },
  { "@timestamp": "2026-09-11T08:00:00.050Z", "span.id": "service", "parent.id": "root", "span.name": "PaymentService#execute", "span.duration.us": 300_000, "span.type": "app", "service.name": "payments" },
  { "@timestamp": "2026-09-11T08:00:00.100Z", "span.id": "sql", "parent.id": "service", "span.name": "SELECT", "span.duration.us": 40_000, "span.type": "db", "db.statement": "select * from t_pay_txn where req_bus_no = ?", "service.name": "payments" }
];

test("Trace rows are rebuilt into parent-child hierarchy", () => {
  const model = buildTraceModel(rows);
  assert.equal(model.roots.length, 1);
  assert.equal(model.roots[0].children[0].id, "service");
  assert.equal(model.roots[0].children[0].children[0].id, "sql");
  assert.equal(model.nodes[2].detail, "select * from t_pay_txn where req_bus_no = ?");
  assert.equal(model.services, 2);
});

test("Trace collapsing hides only descendants and preserves time positions", () => {
  const model = buildTraceModel(rows);
  const service = model.nodes.find(({ id }) => id === "service")!;
  assert.deepEqual(flattenTraceTree(model.roots, new Set([service.key])).map(({ node }) => node.id), ["root", "service"]);
  const sqlTiming = traceNodeTiming(model.nodes.find(({ id }) => id === "sql")!, model);
  assert.equal(sqlTiming.left, 20);
  assert.equal(sqlTiming.width, 8);
});

test("Trace duration heat uses stable operational thresholds", () => {
  assert.equal(durationSeverity(2), "fast");
  assert.equal(durationSeverity(20), "normal");
  assert.equal(durationSeverity(120), "warning");
  assert.equal(durationSeverity(600), "slow");
  assert.equal(durationSeverity(1200), "critical");
});

test("Trace filter searches SQL and reveals matching descendants with ancestors even when collapsed", () => {
  const model = buildTraceModel([...rows, { "span.id": "other", "parent.id": "root", "span.name": "Unrelated call" }]);
  const collapsed = new Set(model.nodes.map(({ key }) => key));
  const result = filterTraceTree(model.roots, collapsed, "T_PAY_TXN select");
  assert.deepEqual(result.visible.map(({ node, depth }) => [node.id, depth]), [["root", 0], ["service", 1], ["sql", 2]]);
  assert.equal(result.matches.size, 1);
  assert.equal(collapsed.size, 4);
  assert.deepEqual(filterTraceTree(model.roots, collapsed, "  ").visible.map(({ node }) => node.id), ["root"]);
});

test("Trace filtering handles service, IDs, unmatched keywords and keeps timeline coordinates", () => {
  const model = buildTraceModel(rows);
  assert.equal(filterTraceTree(model.roots, new Set(), "payments").matches.size, 3);
  assert.equal(filterTraceTree(model.roots, new Set(), "gateway").matches.size, 1);
  assert.equal(filterTraceTree(model.roots, new Set(), "sql").matches.size, 1);
  assert.equal(filterTraceTree(model.roots, new Set(), "missing").visible.length, 0);
  const before = traceNodeTiming(model.nodes[2], model);
  const result = filterTraceTree(model.roots, new Set(), "t_pay_txn");
  assert.deepEqual(traceNodeTiming(result.visible[2].node, model), before);
});

test("Trace column widths have safe bounds and a readable default", () => {
  assert.equal(TRACE_COLUMN_DEFAULT, 460);
  assert.equal(clampTraceColumnWidth(10), 280);
  assert.equal(clampTraceColumnWidth(2000), 1400);
  assert.equal(clampTraceColumnWidth(632.8), 633);
});

test("Trace view exposes accessible column resize and keyword controls", () => {
  // tsx uses classic JSX for these source imports; Vite uses automatic JSX.
  const previous = Object.getOwnPropertyDescriptor(globalThis, "React");
  Object.defineProperty(globalThis, "React", { value: React, configurable: true });
  let html: string;
  try { html = renderToStaticMarkup(createElement(TraceDrawer, { traceId: "trace-1", rows, loading: false, onClose: () => undefined })); }
  finally { if (previous) Object.defineProperty(globalThis, "React", previous); else Reflect.deleteProperty(globalThis, "React"); }
  assert.match(html, /aria-label="调整调用层级列宽"/);
  assert.match(html, /role="separator"/);
  assert.match(html, /aria-valuenow="460"/);
  assert.match(html, /aria-label="Trace 关键字过滤"/);
  assert.match(html, /trace-waterfall-shell/);
  assert.match(html, /title="PaymentService#execute"/);
});
