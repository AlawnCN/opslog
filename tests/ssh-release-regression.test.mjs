import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const encode = (value) => value ? Buffer.from(String(value)).toString("hex") : "-";
const run = async (name, args, root) => {
  let script = await readFile(`server/ssh-scripts/${name}.sh`, "utf8");
  if (script.includes("# OPSLOG_JSON_CODEC")) script = script.replace("# OPSLOG_JSON_CODEC", await readFile("server/ssh-scripts/json_codec.pl", "utf8"));
  const path = join(root, "script.sh");
  await writeFile(path, script);
  return (await execute("sh", [path, ...args.map(encode)], { timeout: 10_000, maxBuffer: 20 * 1024 * 1024 })).stdout;
};
const fixture = async (action) => {
  const root = await mkdtemp(join(tmpdir(), "opslog-release-"));
  try { await mkdir(join(root, "log")); await action(root); }
  finally { await rm(root, { recursive: true, force: true }); }
};

test("missing configured roots never fall back to a parent application", { skip: process.platform === "win32" }, async () => fixture(async (root) => {
  await mkdir(join(root, "trc"));
  const missing = join(root, root.split("/").at(-1));
  for (const script of ["transaction_list", "transaction_content", "transaction_summary", "log_search"]) {
    await assert.rejects(run(script, [missing], root), /Configured application directory does not exist/);
  }
}));

test("pyh search stays inside its root while preserving other calling source nodes", { skip: process.platform === "win32" }, async () => fixture(async (root) => {
  const pyh = join(root, "pyh"), cen = join(root, "cen");
  await mkdir(join(pyh, "log"), { recursive: true });
  await mkdir(join(cen, "log"), { recursive: true });
  const line = (id, node, caller) => `2026-10-09 12:00:00,123 -> ${id}|FT1|KE|${node}|transflow|sendMsgToSftp|27|09 12:00:00,096||{}|PYH00000|SUCCESS||${caller}|\n`;
  await writeFile(join(pyh, "log", "txn_pyh.lst"), line("PYH1", "pyh.u_0_151", "cen.u_0_152") + line("PYH2", "pyh.u_0_151", "das.das.u_0_151"));
  await writeFile(join(cen, "log", "txn_cen.lst"), line("CEN_OUTSIDE", "cen.u_0_152", "cen.u_0_152"));
  await symlink(join(cen, "log", "txn_cen.lst"), join(pyh, "log", "outside.lst"));
  await symlink(cen, join(pyh, "outside"));
  const source = { name: "summary", role: "transaction", pathMode: "regex", paths: ["^.*\\.lst$"], delimiter: "|", recordEnd: "newline", timestampStyle: "full", ordered: true, stripAsyncSuffix: false, fields: { timestamp: { regex: "^(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}[.,]\\d{3})" }, logId: { index: 0 }, node: { index: 3 }, sourceNode: { index: 13 } } };
  const raw = await run("configured_search", [pyh, "09", "2026-10-09 00:00:00.000", "2026-10-10 00:00:00.000", "100", "transaction", JSON.stringify([source]), "{}"], root);
  assert.match(raw, /PYH1/); assert.match(raw, /PYH2/);
  assert.match(raw, /cen\.u_0_152/); assert.match(raw, /das\.das\.u_0_151/);
  assert.doesNotMatch(raw, /CEN_OUTSIDE/);
  const builtIn = await run("transaction_list", [pyh, "09", "2026-10-09 00:00:00.000", "2026-10-10 00:00:00.000", "100", "", "", "", "", "", "", "", "", "ALL"], root);
  assert.match(builtIn, /PYH1/); assert.doesNotMatch(builtIn, /CEN_OUTSIDE/);
  await writeFile(join(cen, "log", "app.log"), "2026-10-09 12:00:00,123 INFO CEN_OUTSIDE\n");
  await symlink(join(cen, "log", "app.log"), join(pyh, "log", "outside.log"));
  assert.doesNotMatch(await run("log_search", [pyh, "09", "2026-10-09 00:00:00.000", "2026-10-10 00:00:00.000", "100", "", "", "", "PREVIEW"], root), /CEN_OUTSIDE/);
  await mkdir(join(pyh, "trc", "09"), { recursive: true });
  await writeFile(join(cen, "transaction_cen.trc"), "INFO[10-09 12:00:00,123] -> CEN_OUTSIDE|business|service|27\n");
  await symlink(join(cen, "transaction_cen.trc"), join(pyh, "trc", "09", "transaction_cen.trc"));
  const summary = await run("transaction_summary", [pyh, "09", "", "", "", "", "", "", "", "2026-10-09 00:00:00.000", "2026-10-10 00:00:00.000", "100", ""], root);
  assert.doesNotMatch(summary, /CEN_OUTSIDE/);
}));

test("built-in UAT list accepts both envelopes and retains per-service results and embedded pipes", { skip: process.platform === "win32" }, async () => fixture(async (root) => {
  const trace = "0123456789abcdef0123456789abcdef";
  const message = "BCP99999:based on the key [BSP|batch_details|default|service], no relevant records";
  for (const prefix of ["", "|"]) {
    const lines = [
      `2026-10-09 12:00:00,123 -> ${prefix}TX-123|FT1|KE|cte.u_0_71|transaction|tellerSignIn|8|09 12:00:00,115|${trace}|{"text":"a|b -> c"}|CMMP0448|The teller information does not exist||tlr.u_0_78|`,
      `2026-10-09 12:00:00,133 -> ${prefix}TX-123|FT1|KE|cte.u_0_71|transflow|dynamicCall|22|09 12:00:00,111|${trace}||SCM60001|${message}||cte.u_0_71|`
    ];
    await writeFile(join(root, "log", "summary.lst"), lines.join("\n") + "\n");
    const raw = await run("transaction_list", [root, "09", "2026-10-08 12:00:00.000", "2026-10-09 12:01:00.000", "100", "", "", "", "", "", "", "", "", "ALL"], root);
    assert.equal(raw.trim().split("\n").length, 2);
    assert.match(raw, /TX-123\|FT1\|KE\|cte.u_0_71\|transaction\|tellerSignIn\|8/);
    assert.ok(raw.includes(`|${trace}|{}|SCM60001|${message}|cte.u_0_71|`));
    assert.match(raw, /CMMP0448\|The teller information does not exist\|tlr.u_0_78\|/);
  }
}));

test("UAT summary envelope without leading pipe preserves ID and exact field positions", { skip: process.platform === "win32" }, async () => fixture(async (root) => {
  const fields = { timestamp: { regex: "^(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2},\\d{3})" }, logId: { index: 0 }, txnNo: { index: 1 }, business: { index: 4 }, service: { index: 5 }, duration: { index: 6 }, traceId: { index: 8 }, messageCode: { index: 10 }, messageInfo: { index: 11 } };
  fields.sourceNode = { index: 13 };
  const sources = [{ name: "summary", role: "transaction", delimiter: "|", recordEnd: "newline", timestampStyle: "full", fields, paths: ["log/*.lst"] }];
  const trace = "0123456789abcdef0123456789abcdef";
  for (const prefix of ["", "|"]) {
    await writeFile(join(root, "log", "summary.lst"), `2026-10-09 12:00:00,123 -> ${prefix}TX.u_0_151|FT1|KE|cte|transflow|dynamicCall|27|09 12:00:00,096|${trace}|{"text":"a|b -> c"}|BCP00000|Success||src|\n`);
    const raw = await run("configured_search", [root, "09", "2026-10-09 00:00:00.000", "2026-10-10 00:00:00.000", "100", "transaction", JSON.stringify(sources), "{}"], root);
    const row = JSON.parse(raw.split("\n").find(line => line.startsWith("@OPSLOG_ROW\t")).slice(12));
    assert.equal(row.values.logId, "TX.u_0_151");
    assert.equal(row.values.service, "dynamicCall");
    assert.equal(row.values.business, "transflow");
    assert.equal(row.values.traceId, trace);
    assert.equal(row.values.messageCode, "BCP00000");
    assert.equal(row.values.messageInfo, "Success");
    assert.equal(row.values.sourceNode, "src");
  }
}));

test("equal-timestamp transaction pages retain a stable prefix without skips or repeats", { skip: process.platform === "win32" }, async () => fixture(async (root) => {
  const lines = Array.from({ length: 2000 }, (_, position) => {
    const i=(position*991)%2000;
    const hour=i<1200?"12":i<1600?"13":"11";
    return `2026-10-09 ${hour}:00:00,123 -> TX-${String(i).padStart(4,"0")}|FT1|KE|cte|transflow|dynamicCall|2|09 12:00:00,121|trace|{}|SCM00000|Success||src|`;
  });
  await writeFile(join(root,"log","summary.lst"),lines.join("\n")+"\n");
  const pages=[];
  for(const limit of [501,1001,2501]) {
    const raw=await run("transaction_list",[root,"09","2026-10-09 00:00:00.000","2026-10-10 00:00:00.000",String(limit),"","","","","","","","","ALL"],root);
    pages.push(raw.trim().split("\n"));
  }
  assert.deepEqual(pages[0],pages[2].slice(0,501));
  assert.deepEqual(pages[1],pages[2].slice(0,1001));
  const combined=[...pages[0].slice(0,500),...pages[1].slice(500,1000),...pages[2].slice(1000)];
  assert.equal(combined.length,2000);
  assert.equal(new Set(combined).size,2000);
  for(const role of ["transaction","transactionEvent"]) {
    const sources=[{name:"summary",role,paths:["log/*.lst"],delimiter:"|",recordEnd:"newline",timestampStyle:"full",stripAsyncSuffix:false,fields:{timestamp:{regex:"^(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2},\\d{3})"},logId:{index:0}}}];
    const configured=[];
    for(const limit of [501,1001,2501]) {
      const raw=await run("configured_search",[root,"09","2026-10-09 00:00:00.000","2026-10-10 00:00:00.000",String(limit),"transaction",JSON.stringify(sources),"{}"],root);
      configured.push(raw.split("\n").filter(line=>line.startsWith("@OPSLOG_ROW\t")).map(line=>JSON.parse(line.slice(12)).values.logId));
    }
    assert.deepEqual(configured[0],configured[2].slice(0,501),role);
    assert.deepEqual(configured[1],configured[2].slice(0,1001),role);
  }
}));

test("event configuration detail probe prefers complete native TRC and does not scan aggregates", { skip: process.platform === "win32" }, async () => fixture(async (root) => {
  await mkdir(join(root, "trc", "09"), { recursive: true });
  await writeFile(join(root, "trc", "09", "TX1.trc"), "INFO[10-09 12:00:00,000] -> native full transaction\n");
  await writeFile(join(root, "log", "txntrc_app.trc"), " §§ TX2 event fallback\n");
  const raw = await run("transaction_content", [root, "TX1", "09", "FILES_ONLY"], root);
  assert.match(raw, /OPSLOG SOURCE: TX1.trc/);
  assert.match(raw, /native full transaction/);
  assert.equal(await run("transaction_content", [root, "TX2", "09", "FILES_ONLY"], root), "");
  assert.equal(await run("transaction_content", [root, "TX2", "09"], root), "");
  await writeFile(join(root, "trc", "09", "TX1-99.trc"), "child transaction only\n");
  assert.doesNotMatch(await run("transaction_content", [root, "TX1", "09"], root), /child transaction/);
  assert.doesNotMatch(await run("transaction_content", [root, "TX1-99", "09"], root), /native full transaction/);
  assert.equal(await run("transaction_content", [root, "TX1-98", "09"], root), "");
}));

test("AI sampling preserves full long summary rows and recent tail results", { skip: process.platform === "win32" }, async () => fixture(async (root) => {
  const lines = Array.from({ length: 20 }, (_, index) => `2026-10-10 06:00:00.229 -> TX${index}|FT${index}|KE|das.s_0_138|business|service|25|10 06:00:00,204||{"context":"${"x".repeat(12000)}"}|RCLP6001|Result-${index}||src|`);
  await writeFile(join(root, "log", "summary.lst"), lines.join("\n") + "\n");
  const sample = JSON.parse((await run("sample", [root], root)).split("\n")[0]);
  const rows = sample.content.split("\n").filter(line => line.startsWith("2026-"));
  assert.ok(rows[0].includes("TX0|FT0|"));
  assert.ok(rows.at(-1).includes("TX19|FT19|"));
  assert.ok(rows.every(line => /\|RCLP6001\|Result-\d+\|\|src\|$/.test(line)));
}));

test("application search seeks historical time and filters the exclusive end boundary", { skip: process.platform === "win32" }, async () => fixture(async (root) => {
  const lines = Array.from({ length: 10_000 }, (_, i) => {
    const stamp = new Date(Date.UTC(2026, 9, 4, 0, 0, i)).toISOString().slice(5, 23).replace("T", " ").replace(".", ",");
    return `INFO[${stamp}][worker] -> event-${i}`;
  });
  await writeFile(join(root, "log", "app.log"), lines.join("\n") + "\n");
  const raw = await run("log_search", [root, "04", "2026-10-04 00:01:40.000", "2026-10-04 00:01:50.000", "100", "", "", "", "PREVIEW"], root);
  assert.equal(raw.split("\x1e").filter((record) => record.includes("\x1f")).length, 10);
  assert.match(raw, /event-100\x1e/);
  assert.doesNotMatch(raw, /event-110\x1e/);
}));

test("large unparseable application files stop at the scan budget with a warning", { skip: process.platform === "win32" }, async () => fixture(async (root) => {
  await writeFile(join(root, "log", "app.log"), "x".repeat(10 * 1024 * 1024));
  const raw = await run("log_search", [root, "04", "2026-10-04 00:00:00.000", "2026-10-05 00:00:00.000", "100", "", "", "", "PREVIEW"], root);
  assert.match(raw, /@OPSLOG_SCAN_LIMIT/);
  assert.ok(raw.length < 1000);
}));

test("structured log search seeks by record delimiters and preserves multiline UTF-8", { skip: process.platform === "win32" }, async () => fixture(async (root) => {
  const lines = Array.from({ length: 3000 }, (_, i) => {
    const stamp = new Date(Date.UTC(2026, 9, 4, 0, 0, i)).toISOString().slice(0, 23).replace("T", " ");
    return `app §§ ${stamp} §§ thread §§ INFO §§ node §§ 中文日志-${i}\n第二行 §§ logEnd`;
  });
  await writeFile(join(root, "log", "app.log"), lines.join(""));
  const raw = await run("log_search", [root, "04", "2026-10-04 00:01:40.000", "2026-10-04 00:01:50.000", "100", "", "", "", "PREVIEW"], root);
  assert.equal(raw.split("\x1e").filter((record) => record.includes("\x1f")).length, 10);
  assert.match(raw, /中文日志-100\n第二行/);
  assert.doesNotMatch(raw, /中文日志-110\n/);
}));

test("configured detail retains more than 100 records and reports explicit truncation", { skip: process.platform === "win32" }, async () => fixture(async (root) => {
  const rules = [{ name: "events", role: "transactionEvent", pathMode: "regex", paths: ["^log/events\\.log$"], delimiter: "|", recordEnd: "newline", timestampStyle: "full", ordered: true, fields: { timestamp: { index: 0 }, logId: { index: 1 } } }];
  await writeFile(join(root, "log", "events.log"), Array.from({ length: 201 }, (_, i) => `2026-10-04 12:00:00.${String(i).padStart(3, "0")}|TX1|event-${i}\n`).join(""));
  const args = [root, "04", "2026-10-04 00:00:00.000", "2026-10-05 00:00:00.000", "20000", "detail", JSON.stringify(rules), JSON.stringify({ txnId: "TX1" })];
  const raw = await run("configured_search", args, root);
  assert.equal(raw.split("\n").filter((line) => line.startsWith("@OPSLOG_ROW\t")).length, 201);
  assert.doesNotMatch(raw, /@OPSLOG_SCAN_LIMIT/);
  args[4] = "100";
  assert.match(await run("configured_search", args, root), /@OPSLOG_SCAN_LIMIT/);
}));

test("desktop AI and sampling use cancellable invoke and Reader saves on application exit", async () => {
  const api = await readFile("web/src/api.ts", "utf8");
  assert.match(api, /cancellableDesktopInvoke<SshLogSample\[\]>\("sample_ssh_logs"/);
  assert.match(api, /cancellableDesktopInvoke<AiAnalyzeResult>\("analyze_log_with_ai"/);
  const native = await readFile("src-tauri/src/lib.rs", "utf8");
  assert.match(native, /RunEvent::ExitRequested/);
  assert.match(native, /reader_window::save\(app_handle\)/);
});
