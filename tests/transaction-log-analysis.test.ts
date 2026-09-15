import assert from "node:assert/strict";
import test from "node:test";
import { clampLogOutlineGeometry, moveLogOutlineGeometry, resizeLogOutlineGeometry } from "../web/src/log-outline-geometry";
import { createSqlOutlinePreviews } from "../web/src/log-outline-preview";
import { directChildLogFolds, serviceFoldExpansionAnchor } from "../web/src/log-fold-hierarchy";
import { clampCustomMarkerWidthRatio, CUSTOM_MARKER_WIDTH_RATIO_KEY, readCustomMarkerWidthRatio, storeCustomMarkerWidthRatio } from "../web/src/custom-marker-layout";
import { CUSTOM_LOG_MARKER_EXPORT_FORMAT, mergeCustomLogMarkerImport, serializeCustomLogMarkers } from "../web/src/custom-log-marker-transfer";
import { buildCustomLogMarkerOutline, cloneCustomLogMarker, combineCustomLogMarkers, createEmptyCustomLogMarker, CUSTOM_LOG_MARKERS_KEY, readCustomLogMarkers, reorderCustomLogMarkerRules, reorderCustomLogMarkers, storeCustomLogMarkers, type CustomLogMarker } from "../web/src/custom-log-markers";
import { javaObjectSourceStart, parseJavaObjectPreview } from "../web/src/java-object-preview";
import { analyzeTransactionLog } from "../web/src/transaction-log-analysis";
import { findPlainLogMatchesInLowercase, findRegexLogMatches } from "../web/src/transaction-log-search";
import { directChildStructuredPreviewFolds, formatStructuredLogPreview } from "../web/src/structured-log-preview";
import { buildPortableLogSnapshot, encodeCompressedPortableLogSnapshot, encodePortableLogSnapshot, portableLogFilename, PORTABLE_LOG_FORMAT } from "../web/src/portable-log-export-data";

test("plain and regular-expression searches return exact highlight ranges", () => {
  assert.deepEqual(findPlainLogMatchesInLowercase("alpha beta alpha", "ALPHA"), [
    { from: 0, to: 5 },
    { from: 11, to: 16 }
  ]);
  assert.deepEqual(findRegexLogMatches("TX-12 tx-345 skip", String.raw`tx-\d+`).matches, [
    { from: 0, to: 5 },
    { from: 6, to: 12 }
  ]);
});

test("portable log snapshot preserves semantic highlights and read-only marker outlines", () => {
  const content = "2026-09-10T01:02:03.004Z [cte.p_0_21] [ERROR] -> execute sql: [select id from t_pay_order where req_bus_no = 'FT001']";
  const analysis = analyzeTransactionLog(content);
  const customMarker = marker("request", "请求号", "FT001");
  const snapshot = buildPortableLogSnapshot({
    logId: "channelPosting/unsafe",
    content,
    analysis,
    customMarkers: [customMarker],
    initiallyFolded: true,
    initialWrapLines: false,
    initialOutlineWrapLines: true,
    exportedAt: "2026-09-10T01:02:04.000Z"
  });

  assert.equal(snapshot.format, PORTABLE_LOG_FORMAT);
  assert.equal(snapshot.content, content);
  assert.equal(snapshot.initiallyFolded, true);
  assert.equal(snapshot.initialWrapLines, false);
  assert.equal(snapshot.initialOutlineWrapLines, true);
  assert.ok(snapshot.analysis.highlights.some(({ kind }) => kind === "sql-table"));
  assert.ok(snapshot.analysis.highlights.some(({ kind }) => kind === "trace-value"));
  assert.equal(snapshot.customMarkers[0].outline.items[0].line, 1);

  const encoded = encodePortableLogSnapshot(snapshot);
  assert.equal(encoded.includes("<"), false);
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  const decoded = JSON.parse(new TextDecoder().decode(bytes));
  assert.equal(decoded.content, snapshot.content);
  assert.deepEqual(decoded.analysis.highlights, snapshot.analysis.highlights);
  assert.deepEqual(decoded.customMarkers, snapshot.customMarkers);
  assert.equal(portableLogFilename(snapshot.logId), "OpsLog_channelPosting_unsafe.html");
});

test("portable log snapshot uses lossless gzip compression when the platform supports it", async () => {
  const content = "same repeated transaction log line\n".repeat(2_000);
  const snapshot = buildPortableLogSnapshot({
    logId: "compressed",
    content,
    analysis: analyzeTransactionLog(content),
    customMarkers: [],
    initiallyFolded: false,
    initialWrapLines: true,
    initialOutlineWrapLines: false,
    exportedAt: "2026-09-10T01:02:04.000Z"
  });
  const encoded = await encodeCompressedPortableLogSnapshot(snapshot);

  if (typeof CompressionStream === "undefined") {
    assert.equal(encoded.encoding, "base64");
    return;
  }
  assert.equal(encoded.encoding, "gzip-base64");
  assert.ok(encoded.payload.length < encodePortableLogSnapshot(snapshot).length / 5);
  const compressed = Uint8Array.from(atob(encoded.payload), (character) => character.charCodeAt(0));
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"));
  const decoded = JSON.parse(new TextDecoder().decode(await new Response(stream).arrayBuffer()));
  assert.equal(decoded.content, content);
});

test("regular-expression search reports invalid patterns and skips empty matches", () => {
  assert.equal(findRegexLogMatches("content", "[").error, "正则表达式格式有误");
  assert.deepEqual(findRegexLogMatches("aaa", "(?=a)").matches, []);
});

const marker = (id: string, label: string, query = label, regex = false): CustomLogMarker => ({
  id,
  label,
  rules: [{ id: `${id}-rule`, label, query, regex }]
});

test("custom markers reorder and combine with the drop target rules first", () => {
  const markers = [marker("alpha", "Alpha"), marker("beta", "Beta"), marker("gamma", "Gamma")];
  assert.deepEqual(reorderCustomLogMarkers(markers, "gamma", "alpha", false).map(({ id }) => id), ["gamma", "alpha", "beta"]);

  const combined = combineCustomLogMarkers(markers, "gamma", "alpha");
  assert.equal(combined[0].label, "Alpha");
  assert.deepEqual(combined[0].rules.map(({ label }) => label), ["Alpha", "Gamma"]);
  assert.equal(combined[1].id, "beta");

  const sourceBeforeTarget = combineCustomLogMarkers(markers, "alpha", "gamma");
  assert.equal(sourceBeforeTarget[0].id, "beta");
  assert.equal(sourceBeforeTarget[1].label, "Gamma");
  assert.deepEqual(sourceBeforeTarget[1].rules.map(({ label }) => label), ["Gamma", "Alpha"]);
});

test("combining markers preserves the target name and every child rule unchanged", () => {
  const target: CustomLogMarker = {
    id: "request",
    label: "请求报文",
    rules: [{ id: "request-rule", label: "RequestBO 入参", query: "RequestBO >>>", regex: false }]
  };
  const source: CustomLogMarker = {
    id: "response",
    label: "响应报文",
    rules: [{ id: "response-rule", label: "RequestBO 出参", query: String.raw`RequestBO\s+<<<`, regex: true }]
  };

  const [combined] = combineCustomLogMarkers([target, source], source.id, target.id);

  assert.equal(combined.label, target.label);
  assert.deepEqual(combined.rules, [target.rules[0], source.rules[0]]);
});

test("custom marker creation, cloning, and child rule reordering preserve independent identities", () => {
  const draft = createEmptyCustomLogMarker();
  assert.equal(draft.rules.length, 1);
  const secondRule = createEmptyCustomLogMarker().rules[0];
  const rules = [...draft.rules, secondRule];

  const reordered = reorderCustomLogMarkerRules(rules, secondRule.id, draft.rules[0].id, false);
  assert.deepEqual(reordered.map(({ id }) => id), [secondRule.id, draft.rules[0].id]);

  const source = marker("source", "Source", "ERROR");
  const cloned = cloneCustomLogMarker([source], source.id);
  assert.equal(cloned.length, 2);
  assert.equal(cloned[1].label, "Source 副本");
  assert.notEqual(cloned[1].id, source.id);
  assert.notEqual(cloned[1].rules[0].id, source.rules[0].id);
  assert.equal(cloned[1].rules[0].query, source.rules[0].query);
});

test("custom marker section width is clamped and restored from storage", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }
  };

  assert.equal(clampCustomMarkerWidthRatio(.05), .16);
  assert.equal(clampCustomMarkerWidthRatio(.9), .58);
  storeCustomMarkerWidthRatio(.41, storage);
  assert.equal(values.get(CUSTOM_MARKER_WIDTH_RATIO_KEY), "0.41");
  assert.equal(readCustomMarkerWidthRatio(storage), .41);
});

test("custom marker outline merges text and regex hits with their source aliases", () => {
  const content = ["first ERROR E1001", "second warning W2002", "third error E3003"].join("\n");
  const combined: CustomLogMarker = {
    id: "combined",
    label: "Problems",
    rules: [
      { id: "errors", label: "Errors", query: "error", regex: false },
      { id: "codes", label: "Codes", query: String.raw`[EW]\d{4}`, regex: true }
    ]
  };
  const outline = buildCustomLogMarkerOutline(content, combined);

  assert.deepEqual(outline.items.map(({ line, detail }) => [line, detail]), [
    [1, "Errors"], [1, "Codes"], [2, "Codes"], [3, "Errors"], [3, "Codes"]
  ]);
  assert.equal(outline.highlights.length, 5);
  assert.ok(outline.highlights.every(({ kind }) => kind === "custom-match"));
});

test("a custom marker built from the live search text finds matching log lines", () => {
  const content = [
    "2026-09-09T02:47:02.654Z [cte.p_0_22] [INFO] -> execute sql: [insert into t_sav_acjnl]",
    "2026-09-09T02:47:02.655Z [cte.p_0_22] [INFO] -> ordinary log entry"
  ].join("\n");
  const outline = buildCustomLogMarkerOutline(content, marker("sql", "SQL", "execute sql"));

  assert.equal(outline.items.length, 1);
  assert.equal(outline.items[0].line, 1);
  assert.equal(content.slice(outline.highlights[0].from, outline.highlights[0].to), "execute sql");
});

test("custom markers survive reload with combination order and regex settings intact", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }
  };
  const combined = combineCustomLogMarkers([
    marker("plain", "普通", "ERROR"),
    marker("regex", "追踪号", String.raw`req_(bus|jrn)_no`, true)
  ], "regex", "plain");

  storeCustomLogMarkers(combined, storage);
  assert.ok(values.has(CUSTOM_LOG_MARKERS_KEY));
  assert.deepEqual(readCustomLogMarkers(storage), combined);
});

test("legacy single and combine markers migrate into one marker model without changing child rules", () => {
  const legacyRules = [
    { id: "request", label: "请求报文", query: "RequestBO >>>", regex: false },
    { id: "response", label: "响应报文", query: String.raw`RequestBO\s+<<<`, regex: true }
  ];
  const storage = {
    getItem: () => JSON.stringify([{ id: "legacy", label: "组合 · 2", kind: "combine", rules: legacyRules }]),
    setItem: () => undefined
  };

  assert.deepEqual(readCustomLogMarkers(storage), [{ id: "legacy", label: "请求报文", rules: legacyRules }]);
});

test("custom marker export uses a versioned portable format", () => {
  const source = [marker("request", "请求报文", "RequestBO >>>")];
  const exported = JSON.parse(serializeCustomLogMarkers(source)) as { format: string; version: number; exportedAt: string; markers: CustomLogMarker[] };

  assert.equal(exported.format, CUSTOM_LOG_MARKER_EXPORT_FORMAT);
  assert.equal(exported.version, 1);
  assert.ok(Number.isFinite(Date.parse(exported.exportedAt)));
  assert.deepEqual(exported.markers, source);
});

test("custom marker import appends unique markers with fresh identities", () => {
  const existing = marker("existing", "错误", "ERROR");
  const imported = marker("shared-id", "请求", "RequestBO >>>");
  const contents = serializeCustomLogMarkers([existing, imported]);
  const result = mergeCustomLogMarkerImport([existing], contents);

  assert.equal(result.imported, 1);
  assert.equal(result.duplicates, 1);
  assert.equal(result.invalid, 0);
  assert.equal(result.overflow, 0);
  assert.equal(result.markers[1].label, imported.label);
  assert.notEqual(result.markers[1].id, imported.id);
  assert.notEqual(result.markers[1].rules[0].id, imported.rules[0].id);
  assert.equal(result.markers[1].rules[0].query, imported.rules[0].query);
});

test("custom marker import accepts legacy arrays and reports invalid or unsupported files", () => {
  const legacy = JSON.stringify([marker("legacy", "旧标记", "legacy"), { id: "invalid", label: "无查询", rules: [] }]);
  const result = mergeCustomLogMarkerImport([], legacy);

  assert.equal(result.imported, 1);
  assert.equal(result.invalid, 1);
  assert.throws(() => mergeCustomLogMarkerImport([], "not json"), /有效的 JSON/);
  assert.throws(() => mergeCustomLogMarkerImport([], JSON.stringify({ format: CUSTOM_LOG_MARKER_EXPORT_FORMAT, version: 99, markers: [] })), /更高版本/);
});

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

test("JSON assigned with equals keeps its outer array instead of starting at a nested object", () => {
  const payload = JSON.stringify([{
    gda: { msg_cd: "URM00000", msg_inf: "Success", req_bus_no: "FT26258UA6CA" },
    bda: { prd_set_cd: "M5", ci_no: 768550, customer: { name: "STEPHEN NZIVO MWANGANGI" } }
  }]);
  const content = `2026-09-15T05:54:51.002Z [ntc.p_0_25] [INFO] -> Call URM response=${payload}`;
  const analysis = analyzeTransactionLog(content);
  const fold = analysis.folds.find(({ kind }) => kind === "json");

  assert.ok(fold);
  assert.equal(fold.from, content.indexOf("[", content.indexOf("response=")));
  assert.equal(fold.to, content.length);
  assert.equal(content.slice(fold.from, fold.to), payload);
  assert.equal(analysis.stats.structured, 1);
});

test("JSON and XML structure previews are formatted with semantic highlights", () => {
  const json = formatStructuredLogPreview("json", '{"request":{"amount":6400,"valid":true}}');
  const xml = formatStructuredLogPreview("xml", '<root><request id="1"><amount>6400</amount></request><empty/></root>');

  assert.match(json.content, /\n  "request": \{\n    "amount": 6400,/);
  assert.ok(json.highlights.some(({ kind }) => kind === "json-key"));
  assert.ok(json.highlights.some(({ kind }) => kind === "json-number"));
  assert.equal(xml.content, '<root>\n  <request id="1">\n    <amount>6400</amount>\n  </request>\n  <empty/>\n</root>');
  assert.ok(xml.highlights.some(({ kind }) => kind === "xml-name"));
  assert.ok(xml.highlights.some(({ kind }) => kind === "xml-attribute"));
  assert.equal(json.folds.length, 2);
  assert.equal(xml.folds.length, 2);
  assert.ok(json.folds.every(({ from, to }) => from < to));
  assert.ok(xml.folds.every(({ from, to }) => from < to));
  assert.match(formatStructuredLogPreview("json", '{"incomplete":').error ?? "", /不完整/);
});

test("JSON preview unwraps a single object while preserving real arrays", () => {
  const wrappedObject = formatStructuredLogPreview("json", '[{"gda":{"msg_cd":"SCM60001"},"bda":{"ci_no":768550}}]');
  const multipleObjects = formatStructuredLogPreview("json", '[{"id":1},{"id":2}]');
  const scalarArray = formatStructuredLogPreview("json", '[2]');

  assert.equal(wrappedObject.content.startsWith("{\n"), true);
  assert.equal(wrappedObject.content.endsWith("\n}"), true);
  assert.equal(wrappedObject.content.startsWith("["), false);
  assert.equal(multipleObjects.content.startsWith("[\n"), true);
  assert.equal(scalarArray.content, "[\n  2\n]");
});

test("structured preview unfolding restores only the direct child folds", () => {
  const preview = formatStructuredLogPreview("json", JSON.stringify({
    request: { account: { number: "1001" }, amount: 6400 },
    response: { code: "0" }
  }));
  const root = preview.folds.find((fold) => fold.lineFrom === 0);
  assert.ok(root);
  const children = directChildStructuredPreviewFolds(preview.folds, root);
  assert.equal(children.length, 2);
  assert.deepEqual(
    children.map((fold) => preview.content.slice(fold.from - 1, fold.from)),
    ["{", "{"]
  );
  assert.equal(directChildStructuredPreviewFolds(preview.folds, children[0]).length, 1);
});

test("expanding a folded range keeps only its direct child ranges folded", () => {
  const parent = { lineFrom: 0, from: 10, to: 1_000, kind: "service" as const };
  const child = { lineFrom: 100, from: 100, to: 500, kind: "json" as const };
  const grandchild = { lineFrom: 150, from: 150, to: 250, kind: "xml" as const };
  const sibling = { lineFrom: 600, from: 600, to: 900, kind: "stack" as const };
  const outside = { lineFrom: 1_100, from: 1_100, to: 1_200, kind: "java" as const };

  assert.deepEqual(directChildLogFolds([parent, child, grandchild, sibling, outside], parent), [child, sibling]);
  assert.deepEqual(directChildLogFolds([parent, child, grandchild, sibling, outside], child), [grandchild]);
});

test("expanding a service fold anchors its header while structure folds stay local", () => {
  const service = { lineFrom: 24, from: 80, to: 1_000, kind: "service" as const };
  const json = { lineFrom: 120, from: 160, to: 420, kind: "json" as const };

  assert.equal(serviceFoldExpansionAnchor([service, json], service), service.lineFrom);
  assert.equal(serviceFoldExpansionAnchor([service, json], json), undefined);
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

test("SQL results use their log semantics instead of being classified as JSON", () => {
  const fields = Array.from({ length: 14 }, (_, index) => `field_${index}=${index}`).join(", ");
  const structuredContent = `2026-09-15T01:37:22.709Z [cte.p_0_23] [INFO] -> execute result:[{${fields}, active=true}]`;
  const scalarContent = "2026-09-15T01:37:22.710Z [cte.p_0_23] [INFO] -> execute result:[2]";
  const structured = analyzeTransactionLog(structuredContent);
  const scalar = analyzeTransactionLog(scalarContent);

  assert.ok(structured.folds.some(({ kind }) => kind === "sql-result"));
  assert.equal(structured.folds.some(({ kind }) => kind === "json"), false);
  assert.equal(structured.outline.structured[0]?.detail, "SQL Result");
  assert.ok(structured.highlights.some(({ kind }) => kind === "sql-result-key"));
  assert.ok(structured.highlights.some(({ kind }) => kind === "sql-result-number"));
  assert.equal(scalar.folds.length, 0);
  assert.equal(scalar.outline.structured[0]?.detail, "SQL Result");
  assert.ok(scalar.highlights.some(({ kind }) => kind === "sql-result-number"));
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
  const payload = `[${javaObject}]`;
  const content = `2026-09-07T06:35:02.841Z [cte.p_0_21] [INFO] -> qryDpProductInfo rsp: ${payload}`;
  const analysis = analyzeTransactionLog(content);
  const fold = analysis.folds.find(({ kind }) => kind === "java");

  assert.ok(fold);
  assert.equal(content.slice(fold.from, fold.to), payload);
  assert.equal(analysis.folds.some(({ kind }) => kind === "json"), false);
  assert.ok(analysis.outline.structured.some(({ detail }) => detail === "JAVA"));
});

test("Java object collections keep the complete outer list as the preview structure", () => {
  const rules = Array.from({ length: 8 }, (_, index) =>
    `RrcRulePO(chkDt=null, chkOpr=null, rulDesc=Risk rule ${index}, rulFactor=transaction_amount, rulId=RTM0${index}, rulSts=2, reqBusNo=null)`
  );
  const payload = `[${rules.join(", ")}]`;
  const content = `2026-09-15T14:44:57.154Z [cte.p_0_23] [INFO] -> getRuleCacheInfo last lst=${payload}`;
  const analysis = analyzeTransactionLog(content);
  const fold = analysis.folds.find(({ kind }) => kind === "java");

  assert.ok(fold);
  assert.equal(content.slice(fold.from, fold.to), payload);
  const preview = parseJavaObjectPreview(content.slice(fold.from, fold.to));
  assert.equal(preview.kind, "list");
  assert.equal(preview.typeName, "List");
  assert.equal(preview.members.length, rules.length);
  assert.ok(preview.members.every(({ value }) => value.kind === "object" && value.typeName === "RrcRulePO"));
});

test("Java object preview keeps class, field, nested object, and list hierarchy", () => {
  const source = "PrdDpInfoRspCO(super=PrdBaseRspCO(code=0), account=PrdLiabilityAccount(prdCd=6106, rules=[RuleVO(id=1, enabled=Y), RuleVO(id=2, enabled=N)]), description=transfer, approved manually, remark=null)";
  const preview = parseJavaObjectPreview(source);
  const account = preview.members.find(({ name }) => name === "account")?.value;
  const rules = account?.members.find(({ name }) => name === "rules")?.value;

  assert.equal(preview.kind, "object");
  assert.equal(preview.typeName, "PrdDpInfoRspCO");
  assert.equal(preview.members.find(({ name }) => name === "super")?.value.typeName, "PrdBaseRspCO");
  assert.equal(account?.typeName, "PrdLiabilityAccount");
  assert.equal(rules?.kind, "list");
  assert.deepEqual(rules?.members.map(({ name, value }) => [name, value.typeName]), [["[0]", "RuleVO"], ["[1]", "RuleVO"]]);
  assert.equal(preview.members.find(({ name }) => name === "description")?.value.value, "transfer, approved manually");
  assert.equal(preview.members.find(({ name }) => name === "remark")?.value.scalarKind, "null");

  const logPrefix = "2026-09-15T05:54:51.002Z [cte] [INFO] -> response: ";
  const openingParenthesis = logPrefix.length + source.indexOf("(");
  assert.equal(javaObjectSourceStart(`${logPrefix}${source}`, openingParenthesis), logPrefix.length);
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

test("XML wrapped by an edb assignment is parsed as an XML structure", () => {
  const xml = `<root><gda><req_bus_no>FT26258XYPKU</req_bus_no><msg_cd>SCM60001</msg_cd></gda><cache_edb><rsk_params_desc>${"security review ".repeat(12)}</rsk_params_desc></cache_edb></root>`;
  const content = `2026-09-15T01:37:22.348Z [cte.p_0_23] [INFO] -> checkFactorParam start paramNo=[13], ruleFactor=[dormant_account_flag], edb=[${xml}]`;
  const analysis = analyzeTransactionLog(content);
  const fold = analysis.folds.find(({ kind }) => kind === "xml");

  assert.ok(fold);
  assert.equal(fold.from, content.indexOf("<root>"));
  assert.equal(fold.to, content.indexOf("</root>") + "</root>".length);
  assert.equal(content[fold.to], "]");
  assert.equal(analysis.outline.structured[0]?.detail, "XML");
  assert.ok(analysis.highlights.some(({ kind }) => kind === "xml-name"));
});
