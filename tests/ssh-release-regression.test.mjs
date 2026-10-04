import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
