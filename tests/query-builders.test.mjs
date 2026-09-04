import assert from "node:assert/strict";
import test from "node:test";
import { buildSearchQuery, buildTraceQuery, buildTrcQuery, pageRows } from "../dist-server/server/query-builders.js";

const environment = {
  name: "test",
  kibanaUrl: "https://kibana.example.test",
  username: "reader",
  password: "secret",
  txnlstIndex: "logs-ecp.txn.lst*",
  txntrcIndex: "logs-ecp.txn.trc*",
  applogIndex: "logs-ecp.log.*"
};

const base = {
  environment: "test",
  kind: "transaction",
  startTime: "2026-09-01T00:00:00.000Z",
  endTime: "2026-09-02T00:00:00.000Z",
  page: 2,
  pageSize: 50,
  status: "FAIL"
};

test("交易查询保留 OpsLog 错误码与分页规则", () => {
  const query = buildSearchQuery({ ...base, txnId: 'approve-"credit', minDurationMs: 120 }, environment);
  assert.match(query, /^FROM logs-ecp\.txn\.lst\*/);
  assert.match(query, /@timestamp >= "2026-09-01T00:00:00\.000Z"/);
  assert.match(query, /ecp\.txn\.id LIKE "\*approve-\\"credit\*"/);
  assert.match(query, /RIGHT\(ecp\.txn\.message\.code, 5\) != "00000"/);
  assert.match(query, /TO_INTEGER\(ecp\.txn\.duration\) >= 120/);
  assert.match(query, /LIMIT 100$/);
  assert.match(query, /EVAL ecp\.txn\.timestamp = COALESCE\(ecp\.txn\.timestamp, @timestamp\)/);
  assert.match(query, /SORT @timestamp DESC \| KEEP/);
});

test("应用日志关键词在规范字段中组合查询", () => {
  const query = buildSearchQuery({ ...base, kind: "application", keyword: "timeout", application: "payments" }, environment);
  assert.match(query, /FROM logs-ecp\.log\.\*/);
  assert.match(query, /message LIKE "\*timeout\*" OR ecp\.log\.thread LIKE/);
  assert.match(query, /ecp\.log\.application LIKE "\*payments\*"/);
});

test("通用查询不允许配置外索引", () => {
  assert.throws(
    () => buildSearchQuery({ ...base, kind: "generic", index: "secrets-*" }, environment),
    /索引未在当前环境中配置/
  );
});

test("TRC 与 APM 查询保留原工具的关联规则", () => {
  assert.match(buildTrcQuery(environment, "log-1", base.startTime, base.endTime), /ecp\.log\.id == "log-1"/);
  assert.match(buildTraceQuery(environment, "trace-1", base.startTime, base.endTime), /^FROM traces-apm\*/);
});

test("分页只返回当前窗口", () => {
  assert.deepEqual(pageRows([1, 2, 3, 4, 5], 2, 2), [3, 4]);
});
