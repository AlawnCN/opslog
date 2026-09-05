import assert from "node:assert/strict";
import test from "node:test";
import { analyzeTransactionLog } from "../web/src/transaction-log-analysis";

test("SQL keeps semantic highlighting without becoming foldable", () => {
  const sql = "select customer_id, account_no, balance from t_account_balance where customer_id = '123' and status = 'A'";
  const analysis = analyzeTransactionLog(`2026-09-05T10:00:00.000Z [account] [INFO] -> execute sql: [${sql}]`);

  assert.equal(analysis.stats.sql, 1);
  assert.ok(analysis.highlights.some(({ kind }) => kind === "sql-keyword"));
  assert.ok(analysis.highlights.some(({ kind }) => kind === "sql-table"));
  assert.ok(analysis.highlights.some(({ kind }) => kind === "sql-muted"));
  assert.equal(analysis.folds.length, 0);
});

test("structured payloads remain foldable after SQL folding is removed", () => {
  const payload = JSON.stringify({ customer: { id: "123", accounts: Array.from({ length: 12 }, (_, index) => ({ index, status: "ACTIVE" })) } });
  const analysis = analyzeTransactionLog(`2026-09-05T10:00:00.000Z [account] [INFO] -> response body: ${payload}`);

  assert.ok(analysis.folds.some(({ kind }) => kind === "json"));
});
