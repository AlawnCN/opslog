import assert from "node:assert/strict";
import test from "node:test";
import { buildTraceModel, durationSeverity, flattenTraceTree, traceNodeTiming } from "../web/src/trace-model.ts";

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
