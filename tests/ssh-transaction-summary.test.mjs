import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const script = new URL("../src-tauri/src/ssh_transaction_summary.sh", import.meta.url);
const encode = (value) => value ? Buffer.from(value).toString("hex") : "-";

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
