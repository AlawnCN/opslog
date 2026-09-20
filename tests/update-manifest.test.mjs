import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);

test("generates separate signed updater manifests for OpsLog and OpsLog Reader", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opslog-manifest-"));
  const version = "3.0.29";
  const prefixes = ["OpsLog", "OpsLog_Reader"];
  const suffixes = [
    "windows_x64_setup.exe",
    "macos_arm64.app.tar.gz",
    "macos_x64.app.tar.gz"
  ];
  for (const prefix of prefixes) {
    for (const suffix of suffixes) {
      const asset = join(directory, `${prefix}_${version}_${suffix}`);
      await writeFile(asset, "artifact");
      await writeFile(`${asset}.sig`, `${prefix}-${suffix}-signature\n`);
    }
  }
  const notesFile = join(directory, "release-notes.md");
  await writeFile(notesFile, "## 更新内容\n\n- Reader 自动更新\n");

  await execute(process.execPath, [
    "scripts/generate-update-manifest.mjs",
    directory,
    version,
    "AlawnCN/opslog",
    `v${version}`,
    notesFile
  ]);

  const main = JSON.parse(await readFile(join(directory, "latest.json"), "utf8"));
  const reader = JSON.parse(await readFile(join(directory, "reader-latest.json"), "utf8"));
  assert.equal(main.notes, "## 更新内容\n\n- Reader 自动更新");
  assert.equal(reader.notes, main.notes);
  assert.match(main.platforms["windows-x86_64"].url, /OpsLog_3\.0\.29_windows_x64_setup\.exe$/);
  assert.match(reader.platforms["windows-x86_64"].url, /OpsLog_Reader_3\.0\.29_windows_x64_setup\.exe$/);
  assert.match(reader.platforms["darwin-aarch64"].url, /OpsLog_Reader_3\.0\.29_macos_arm64\.app\.tar\.gz$/);
});
