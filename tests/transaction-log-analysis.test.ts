import assert from "node:assert/strict";
import test from "node:test";
import { clampLogOutlineGeometry, moveLogOutlineGeometry, resizeLogOutlineGeometry } from "../web/src/log-outline-geometry";
import { createSqlOutlinePreviews } from "../web/src/log-outline-preview";
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
  assert.equal(analysis.outline.structured.length, 1);
  assert.equal(analysis.outline.structured[0]?.line, 1);
});

test("analysis builds lightweight outline entries for navigable log categories", () => {
  const content = [
    "2026-09-05T10:00:00.000Z [gateway] [INFO] -> ==========> container:[msgproc] appName:[payment]",
    "2026-09-05T10:00:00.001Z [payment] [INFO] -> txnCode:[accountDetailQry]",
    "2026-09-05T10:00:00.002Z [payment] [INFO] -> execute sql: [select id from t_account where id = '1']",
    "2026-09-05T10:00:00.003Z [payment] [ERROR] -> Caused by: QueryException",
    "2026-09-05T10:00:00.004Z [payment] [INFO] -> responseBO: msg_cd:[E1001], msg_inf:[failed]"
  ].join("\n");
  const analysis = analyzeTransactionLog(content);

  assert.deepEqual(analysis.outline.service.map(({ line }) => line), [1]);
  assert.deepEqual(analysis.outline.call.map(({ line }) => line), [1, 2]);
  assert.deepEqual(analysis.outline.sql.map(({ line }) => line), [3]);
  assert.deepEqual(analysis.outline.exception.map(({ line }) => line), [4]);
  assert.deepEqual(analysis.outline["failed-result"].map(({ line }) => line), [5]);
});

test("outline geometry stays entirely inside the log preview area", () => {
  const bounds = { width: 1000, height: 700 };
  const geometry = clampLogOutlineGeometry({ x: 900, y: 650, width: 640, height: 500 }, bounds);

  assert.equal(geometry.x + geometry.width, bounds.width - 8);
  assert.equal(geometry.y + geometry.height, bounds.height - 8);
  assert.deepEqual(moveLogOutlineGeometry(geometry, -5000, -5000, bounds), { ...geometry, x: 8, y: 8 });
});

test("outline resizing keeps the opposite edge fixed and observes minimum size", () => {
  const bounds = { width: 1000, height: 700 };
  const geometry = { x: 300, y: 100, width: 500, height: 400 };
  const expandedWest = resizeLogOutlineGeometry(geometry, "w", -200, 0, bounds);
  const minimumNorthEast = resizeLogOutlineGeometry(geometry, "ne", 900, 900, bounds);

  assert.deepEqual(expandedWest, { x: 100, y: 100, width: 700, height: 400 });
  assert.equal(minimumNorthEast.x, geometry.x);
  assert.equal(minimumNorthEast.y + minimumNorthEast.height, geometry.y + geometry.height);
  assert.equal(minimumNorthEast.width, bounds.width - geometry.x - 8);
  assert.equal(minimumNorthEast.height, 230);
});

test("SQL outline reuses the reader semantic highlight ranges", () => {
  const content = "2026-09-05T10:00:00.000Z [account] [INFO] -> execute sql: [select customer_id from t_account where status = 'A']";
  const analysis = analyzeTransactionLog(content);
  const previews = createSqlOutlinePreviews(content, analysis.outline.sql, analysis.highlights);
  const kinds = previews.get(analysis.outline.sql[0].from)?.map(({ kind }) => kind).filter(Boolean);

  assert.ok(kinds?.includes("sql-keyword"));
  assert.ok(kinds?.includes("sql-table"));
  assert.ok(kinds?.includes("sql-muted"));
});

test("plain parameter lists and source line numbers are not mistaken for JSON numbers", () => {
  const content = [
    "2026-09-07T06:35:02.709Z [cte.p_0_21] [INFO] -> [com.murong.ecp.m5.bcp.application.tools.CmmBusTools:106] set context property",
    "2026-09-07T06:35:02.710Z [cte.p_0_21] [INFO] -> params: [[1001, 1001]]"
  ].join("\n");
  const analysis = analyzeTransactionLog(content);

  assert.equal(analysis.highlights.filter(({ kind }) => kind === "json-number").length, 0);
  assert.equal(analysis.folds.filter(({ kind }) => kind === "json").length, 0);
});

test("nested SQL highlights every scope while keeping table names prominent", () => {
  const sql = "select count(1) from (select a.id, (select max(x.id) from audit_log x where x.id = a.id) last_id from account a left join customer c on c.id = a.customer_id where a.status = 'A' union all select id, 0 from archive_account where status = 'C') q where q.id > 0 order by q.id";
  const content = `2026-09-07T06:35:02.823Z [cte.p_0_21] [INFO] -> selectList sql:[${sql}]`;
  const analysis = analyzeTransactionLog(content);
  const values = (kind: string) => analysis.highlights
    .filter((highlight) => highlight.kind === kind)
    .map(({ from, to }) => content.slice(from, to).toLowerCase());

  assert.ok(values("sql-keyword").filter((value) => value === "select").length >= 4);
  assert.deepEqual(new Set(values("sql-table")), new Set(["audit_log", "account", "customer", "archive_account"]));
  assert.ok(analysis.highlights.some(({ kind }) => kind === "sql-muted"));
});

test("large Java object dumps are detected as foldable structures before bracket lists", () => {
  const javaObject = `PrdDpInfoRspCO(super=PrdBaseRspCO(code=0), account=PrdLiabilityAccount(prdCd=6106, rules=[${Array.from({ length: 12 }, (_, index) => `RuleVO(id=${index}, enabled=Y)`).join(", ")}]))`;
  const content = `2026-09-07T06:35:02.841Z [cte.p_0_21] [INFO] -> qryDpProductInfo rsp: [${javaObject}]`;
  const analysis = analyzeTransactionLog(content);

  assert.ok(analysis.folds.some(({ kind }) => kind === "java"));
  assert.equal(analysis.folds.some(({ kind }) => kind === "json"), false);
  assert.ok(analysis.outline.structured.some(({ detail }) => detail === "JAVA"));
});

test("XML structures keep semantic highlighting on opening and closing field names", () => {
  const xml = `<root><gda channel="BCP"><req_bus_no>FT262505KYM4</req_bus_no><msg_cd>SCM60001</msg_cd><msgInf>Success</msgInf><msg_inf>Accepted</msg_inf><amount>6400</amount></gda><detail>${"entry".repeat(20)}</detail></root>`;
  const content = `2026-09-07T06:35:02.712Z [cte.p_0_21] [INFO] -> RequestEDB:[${xml}]`;
  const analysis = analyzeTransactionLog(content);
  const kinds = new Set(analysis.highlights.map(({ kind }) => kind));
  const highlightedFields = analysis.highlights
    .filter(({ kind }) => kind === "trace-key" || kind === "message-key")
    .map(({ from, to }) => content.slice(from, to));

  assert.ok(analysis.folds.some(({ kind }) => kind === "xml"));
  assert.ok(kinds.has("xml-name"));
  assert.ok(kinds.has("xml-attribute"));
  assert.ok(kinds.has("xml-string"));
  assert.ok(kinds.has("xml-punctuation"));
  assert.ok(kinds.has("trace-key"));
  assert.ok(kinds.has("trace-value"));
  assert.equal(highlightedFields.filter((field) => field === "req_bus_no").length, 2);
  assert.equal(highlightedFields.filter((field) => field === "msg_cd").length, 2);
  assert.equal(highlightedFields.filter((field) => field === "msgInf").length, 2);
  assert.equal(highlightedFields.filter((field) => field === "msg_inf").length, 2);
  assert.equal(kinds.has("json-number"), false);
});
