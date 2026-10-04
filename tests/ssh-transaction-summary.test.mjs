import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const script = new URL("../server/ssh-scripts/transaction_summary.sh", import.meta.url);
const encode = (value) => value ? Buffer.from(value).toString("hex") : "-";

test("WEB and desktop reference the same SSH collection scripts", async () => {
  const web = await readFile(new URL("../server/ssh-log-source.ts", import.meta.url), "utf8");
  const desktop = await readFile(new URL("../src-tauri/src/ssh_log_source.rs", import.meta.url), "utf8");
  for (const name of ["transaction_list", "transaction_summary", "transaction_content", "log_search", "time_profile"]) {
    assert.ok(web.includes(`./ssh-scripts/${name}.sh`));
    assert.ok(desktop.includes(`../../server/ssh-scripts/${name}.sh`));
  }
  assert.ok(!web.includes("TRANSACTION_DETAIL_SCRIPT"), "unbounded legacy fallback must not return");
});

test("SSH summary fallback returns only records inside the selected interval", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "opslog-ssh-summary-"));
  try {
    const directory = join(root, "trc", "24");
    await mkdir(directory, { recursive: true });
    const file = join(directory, "transaction_sample.trc");
    await writeFile(file, [
      "[09-24 10:00:00,000] -> first.s_0_1234567890|BUS|before|x|10|",
      "[09-24 12:00:00,000] -> middle.s_0_1234567890|BUS|selected|x|120|",
      "[09-24 15:00:00,000] -> last.s_0_1234567890|BUS|after|x|30|",
      ""
    ].join("\n"));
    const modifiedAt = new Date("2026-09-24T12:00:00Z");
    await utimes(file, modifiedAt, modifiedAt);
    const args = [
      root, "24", "", "", "", "", "", "", "",
      "2026-09-24 11:00:00.000", "2026-09-24 13:00:00.000", "50", ""
    ].map(encode);
    const { stdout } = await execute("sh", [script.pathname, ...args]);
    const lines = stdout.trim().split("\n");
    assert.equal(lines[0], "@OPSLOG_SUMMARY_PARSED\t2");
    assert.deepEqual(lines.slice(1), [
      "@OPSLOG_DETAIL\t2026-09-24 12:00:00.000\tmiddle.s_0_1234567890\tBUS\tselected\t120"
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
