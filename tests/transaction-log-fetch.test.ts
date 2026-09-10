import assert from "node:assert/strict";
import test from "node:test";
import { OpsLogSessionCache, transactionLogCacheKey } from "../web/src/opslog-session-cache";
import { transactionLogNeedsWiderWindow, transactionLogTimeWindows } from "../web/src/transaction-log-fetch";

const fallback = {
  startTime: "2026-09-01T00:00:00.000Z",
  endTime: "2026-09-02T00:00:00.000Z"
};

test("交易日志优先使用时间锚点的大窗口", () => {
  const windows = transactionLogTimeWindows({
    "ecp.txn.timestamp": "2026-09-01T12:00:00.000Z",
    "ecp.txn.duration": 1500
  }, fallback);

  assert.deepEqual(windows[0], {
    startTime: "2026-09-01T11:00:00.000Z",
    endTime: "2026-09-01T13:00:00.000Z"
  });
  assert.deepEqual(windows[1], {
    startTime: "2026-09-01T06:00:00.000Z",
    endTime: "2026-09-01T18:00:00.000Z"
  });
  assert.deepEqual(windows[2], {
    startTime: "2026-09-01T00:00:00.000Z",
    endTime: "2026-09-02T00:00:00.000Z"
  });
  assert.equal(windows.length, 3);
});

test("长交易会按耗时扩大首轮锚点窗口", () => {
  const windows = transactionLogTimeWindows({
    "ecp.txn.timestamp": "2026-09-02T00:00:00.000Z",
    "ecp.txn.duration": 3 * 60 * 60 * 1000
  }, {
    startTime: "2026-09-01T12:00:00.000Z",
    endTime: "2026-09-02T12:00:00.000Z"
  });

  assert.deepEqual(windows[0], {
    startTime: "2026-09-01T20:30:00.000Z",
    endTime: "2026-09-02T03:30:00.000Z"
  });
});

test("时间锚点不可用时回退外层查询范围", () => {
  assert.deepEqual(transactionLogTimeWindows({}, fallback), [fallback]);
});

test("同一日志 ID 在外层时间变化后仍只加载一次", async () => {
  const cache = new OpsLogSessionCache();
  const firstKey = transactionLogCacheKey("uat", "transaction-1");
  const secondKey = transactionLogCacheKey("uat", "transaction-1");
  let loads = 0;
  const loader = async () => {
    loads += 1;
    return "transaction log";
  };

  assert.equal((await cache.loadTransactionLog(firstKey, loader)).cached, false);
  assert.equal((await cache.loadTransactionLog(secondKey, loader)).cached, true);
  assert.equal(loads, 1);
});

test("不同环境或日志 ID 不会共享日志缓存", () => {
  assert.notEqual(
    transactionLogCacheKey("uat", "transaction-1"),
    transactionLogCacheKey("prod", "transaction-1")
  );
  assert.notEqual(
    transactionLogCacheKey("uat", "transaction-1"),
    transactionLogCacheKey("uat", "transaction-2")
  );
});

test("查看 Trace 后交易日志在当前页面会话内仍保持缓存", () => {
  const cache = new OpsLogSessionCache();
  const key = transactionLogCacheKey("uat", "transaction-1");
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    cache.saveTransactionLog(key, "transaction log");
    now += 60 * 60 * 1000;
    cache.saveTrace("trace-1", [{ "trace.id": "trace-1" }]);
    assert.equal(cache.getTransactionLog(key), "transaction log");
  } finally {
    Date.now = originalNow;
  }
});

test("超过旧单文件上限的大日志仍可命中最近缓存", () => {
  const cache = new OpsLogSessionCache();
  const key = transactionLogCacheKey("uat", "large-transaction");
  const content = "x".repeat(16 * 1024 * 1024 + 1);
  cache.saveTransactionLog(key, content);
  assert.equal(cache.getTransactionLog(key), content);
});

test("短于锚点窗口的原查询范围不会被反向扩大", () => {
  const windows = transactionLogTimeWindows({
    "ecp.txn.timestamp": "2026-09-05T12:00:00.000Z"
  }, {
    startTime: "2026-09-05T11:00:00.000Z",
    endTime: "2026-09-05T13:00:00.000Z"
  });

  assert.deepEqual(windows, [{
    startTime: "2026-09-05T11:00:00.000Z",
    endTime: "2026-09-05T13:00:00.000Z"
  }]);
});

test("空内容或命中窗口边缘时自动扩窗", () => {
  const window = {
    startTime: "2026-09-01T10:00:00.000Z",
    endTime: "2026-09-01T14:00:00.000Z"
  };
  assert.equal(transactionLogNeedsWiderWindow("", window), true);
  assert.equal(transactionLogNeedsWiderWindow(
    "2026-09-01T10:00:30.000Z [app] [INFO] -> first\n2026-09-01T12:00:00.000Z [app] [INFO] -> last",
    window
  ), true);
  assert.equal(transactionLogNeedsWiderWindow(
    "2026-09-01T11:00:00.000Z [app] [INFO] -> first\n2026-09-01T13:00:00.000Z [app] [INFO] -> last",
    window
  ), false);
});
