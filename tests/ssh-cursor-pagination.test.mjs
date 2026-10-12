import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, appendFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
const execute = promisify(execFile);
const source = { name: "summary", role: "transaction", pathMode: "regex", fileSelection: "latest", paths: ["^log/.*\\.lst$"], delimiter: "|", recordEnd: "newline", timestampStyle: "full", ordered: false, stripAsyncSuffix: false, fields: { timestamp: { regex: "^(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}[.,]\\d{3})" }, logId: { index: 0 }, messageCode: { index: 1 } } };
const stamp = (i) => new Date(Date.UTC(2026, 9, 12, 0, 0, i)).toISOString().replace("T", " ").replace("Z", "");
const line = (i, code = "OK00000") => `${stamp(i)} -> ID${i}|${code}|\n`;
const fixture = async (action) => {
  const root = await mkdtemp(join(tmpdir(), "opslog-cursor-"));
  try {
    await mkdir(join(root, "log"));
    const script = (await readFile("server/ssh-scripts/configured_search.sh", "utf8"))
      .replace("# OPSLOG_JSON_CODEC", await readFile("server/ssh-scripts/json_codec.pl", "utf8"))
      .replace("my %compiled_regex;", "my %compiled_regex; my $test_parts_calls=0;")
      .replace("sub parts {", "sub parts { $test_parts_calls++;")
      .replace("my $output_budget=", "print qq(\\@OPSLOG_TEST_PARTS\\t$test_parts_calls\\n); my $output_budget=");
    const scriptPath = join(root, "collector.sh"); await writeFile(scriptPath, script);
    const baselinePath = join(root, "baseline.sh");
    assert.ok(script.includes("if ($paging && @text_needles)"));
    await writeFile(baselinePath, script.replace("if ($paging && @text_needles)", "if (0 && @text_needles)"));
    const run = async ({ cursor, start = stamp(0), end = stamp(20000), filters = {}, rules = [source], paging = true, limit = 51, prefilter = true } = {}) => {
      const query = { ...filters, ...(paging ? { _snapshotPaging: true, _scanServer: "fixture", _scanCursors: cursor ? { fixture: cursor } : {} } : {}) };
      const args = [root, "12", start, end, limit, "transaction", JSON.stringify(rules), JSON.stringify(query)].map((value) => Buffer.from(String(value)).toString("hex") || "-");
      const { stdout } = await execute("sh", [prefilter ? scriptPath : baselinePath, ...args], { timeout: 10000, maxBuffer: 20 * 1024 * 1024 });
      const lines = stdout.split("\n");
      return { rows: lines.filter((line) => line.startsWith("@OPSLOG_ROW\t")).map((line) => JSON.parse(line.slice(12))), cursor: JSON.parse(lines.find((line) => line.startsWith("@OPSLOG_CURSOR\t"))?.slice(15) || "null"), partsCalls: Number(lines.find((line) => line.startsWith("@OPSLOG_TEST_PARTS\t"))?.split("\t")[1]) };
    };
    await action({ root, run, file: join(root, "log", "summary.lst") });
  } finally { await rm(root, { recursive: true, force: true }); }
};

test("snapshot tail cursor reads bounded pages, ignores append and newly created latest files", () => fixture(async ({ root, run, file }) => {
  await writeFile(file, Array.from({ length: 1000 }, (_, i) => line(i)).join(""));
  const first = await run();
  assert.ok(first.rows.length >= 51 && first.rows.length < 150);
  const state = Object.values(first.cursor.files)[0]; assert.ok(state.position > 0 && state.position < state.size);
  await appendFile(file, line(1000));
  await writeFile(join(root, "log", "new.lst"), line(1001));
  const second = await run({ cursor: first.cursor });
  assert.ok(second.rows.length >= 51 && second.rows.length < 150);
  assert.equal(new Set([...first.rows, ...second.rows].map((row) => row.values.logId)).size, first.rows.length + second.rows.length);
  assert.ok(second.rows.every((row) => Number(row.values.logId.slice(2)) < 1000));
  const refreshed = await run(); assert.equal(refreshed.rows[0].values.logId, "ID1001");
}));

test("sparse filters replenish until sufficient matches, then resume without duplicates", () => fixture(async ({ run, file }) => {
  await writeFile(file, Array.from({ length: 1200 }, (_, i) => line(i, i % 7 === 0 ? "ERR" : "OK00000")).join(""));
  const filters = { status: "FAIL" };
  let cursor; const collected = [];
  do {
    const batch = await run({ cursor, filters, start: stamp(100), end: stamp(1100) });
    collected.push(...batch.rows); cursor = batch.cursor;
  } while (Object.values(cursor.files).some((file) => file.position > 0));
  const expected = await run({ filters, start: stamp(100), end: stamp(1100), paging: false, limit: 1000 });
  assert.deepEqual(collected, expected.rows);
}));

test("snapshot excludes partial last record and detects truncation or rotation", () => fixture(async ({ run, file }) => {
  await writeFile(file, Array.from({ length: 400 }, (_, i) => line(i)).join("") + line(400).trimEnd());
  const first = await run(); assert.equal(first.rows[0].values.logId, "ID399");
  await appendFile(file, "\n" + line(401));
  const second = await run({ cursor: first.cursor }); assert.ok(second.rows.every((row) => !["ID400", "ID401"].includes(row.values.logId)));
  await writeFile(file, line(1));
  await assert.rejects(run({ cursor: second.cursor }), /截断/);
  await rename(file, file + ".old"); await writeFile(file, line(2));
  await assert.rejects(run({ cursor: first.cursor }), /轮转/);
}));

test("time boundary lookback includes nearby out-of-order record and ties are not split", () => fixture(async ({ run, file }) => {
  const records = Array.from({ length: 400 }, (_, i) => line(i));
  records[195] = line(201);
  await writeFile(file, records.join(""));
  const batch = await run({ start: stamp(200), end: stamp(202), limit: 51 });
  assert.equal(batch.rows.length, 3);
  await writeFile(file, Array.from({ length: 300 }, (_, i) => `${stamp(300)} -> ID${i}|OK00000|\n`).join(""));
  const tied = await run(); assert.equal(tied.rows.length, 300);
  assert.equal(Number(Object.values(tied.cursor.files)[0].position), 0);
}));

test("lookback ends on a complete timestamp group, not in the middle of equal-time rows", () => fixture(async ({ run, file }) => {
  const groups = Array.from({ length: 8 }, (_, group) => Array.from({ length: 100 }, (_, i) => `${stamp(group)} -> ID${group}-${i}|OK00000|\n`).join(""));
  await writeFile(file, groups.join(""));
  const baseline = await run({ paging: false, limit: 1000 });
  let cursor; const rows = [];
  do {
    const batch = await run({ cursor }); rows.push(...batch.rows); cursor = batch.cursor;
  } while (Object.values(cursor.files).some((file) => Number(file.position) > 0));
  assert.deepEqual(rows, baseline.rows);
}));

test("literal prefilter avoids full parsing without changing field, Unicode or combined-filter semantics", () => fixture(async ({ run, file }) => {
  const rule = { ...source, stripAsyncSuffix: true, fields: { ...source.fields,
    txnNo: { index: 1 }, node: { index: 2 }, service: { index: 3 }, messageCode: { index: 4 },
    messageInfo: { index: 5 }, traceId: { regex: '"trace":"([^"]*)"' }, duration: { index: 7 },
    business: { index: 8 }, level: { index: 9 } } };
  const record = (i, id, node, info, code = "OK00000") =>
    `${stamp(i)} -> ${id}|流水甲|${node}|PAY.*[x]|${code}|${info}|{"trace":"TRACE-A","nested":["pipe|inside"]}|15|BUS-A|INFO|\n`;
  const records = Array.from({ length: 600 }, (_, i) => record(i, `OTHER${i}`, "elsewhere", "普通消息"));
  records.push(record(600, " TARGET-7 ", "NODE-A", "中文 ÉCOLE 已完成"));
  records.push(record(601, "DIFFERENT", "NODE-B", "target NODE-A 中文 école"));
  records.push(record(602, "TARGET-8", "NODE-A", "中文 ÉCOLE 已完成", "ERR42"));
  records.push(record(603, "OUTSIDE", "NODE-A", "中文 ÉCOLE 已完成"));
  await writeFile(file, records.join(""));
  const cases = [
    { txnId: "target" }, { txnId: "target", node: "node-a", messageInfo: "中文 école" },
    { txnId: "TARGET", node: "NODE-B" }, { txnNo: "流水甲", service: "pay.*[x]", traceId: "trace-a" },
    { business: "bus-a", level: "info", keyword: "pipe|inside" }, { messageCode: "err42", minDurationMs: 10, status: "FAIL" },
    { txnId: "nonexistent" }, { messageInfo: "target", node: "NODE-A" },
  ];
  for (const filters of cases) {
    const args = { filters, rules: [rule], end: stamp(603), limit: 1000 };
    const optimized = await run(args), baseline = await run({ ...args, prefilter: false });
    assert.deepEqual(optimized.rows, baseline.rows, JSON.stringify(filters));
    assert.deepEqual(optimized.cursor, baseline.cursor, "prefilter must not change scan boundaries");
    if (filters.txnId) assert.ok(optimized.partsCalls < baseline.partsCalls / 10);
  }
  const selected = await run({ rules: [rule], filters: { txnId: "TARGET", node: "NODE-A" }, end: stamp(603) });
  assert.deepEqual(selected.rows.map(row => row.values.logId), ["TARGET", "TARGET"]);
}));

test("text-prefiltered cursor pages preserve all matches and positions", () => fixture(async ({ run, file }) => {
  await writeFile(file, Array.from({ length: 1400 }, (_, i) => line(i, i % 7 === 0 ? "ERR42" : "OK00000")).join(""));
  const args = { filters: { txnId: "ID", messageCode: "err42" }, start: stamp(100), end: stamp(1300) };
  let cursor, baselineCursor; const rows = [];
  do {
    const actual = await run({ ...args, cursor });
    const baseline = await run({ ...args, cursor: baselineCursor, prefilter: false });
    assert.deepEqual(actual.rows, baseline.rows);
    assert.deepEqual(actual.cursor, baseline.cursor);
    rows.push(...actual.rows); cursor = actual.cursor; baselineCursor = baseline.cursor;
  } while (Object.values(cursor.files).some(file => Number(file.position) > 0));
  assert.equal(rows.length, Array.from({ length: 1200 }, (_, i) => i + 100).filter(i => i % 7 === 0).length);
}));
