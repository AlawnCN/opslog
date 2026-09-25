import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);

test("generates separate signed updater manifests for OpsLog and OpsLog Reader", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opslog-manifest-"));
  const assetDirectory = join(directory, "assets");
  await mkdir(assetDirectory);
  const version = "3.0.29";
  const prefixes = ["OpsLog", "OpsLog_Reader"];
  const suffixes = [
    "windows_x64_setup.exe",
    "macos_arm64.app.tar.gz",
    "macos_x64.app.tar.gz"
  ];
  for (const prefix of prefixes) {
    for (const suffix of suffixes) {
      const asset = join(assetDirectory, `${prefix}_${version}_${suffix}`);
      await writeFile(asset, "artifact");
      await writeFile(`${asset}.sig`, `${prefix}-${suffix}-signature\n`);
    }
  }
  const notesFile = join(directory, "release-notes.md");
  await writeFile(notesFile, "## 更新内容\n\n- Reader 自动更新\n");

  await execute(process.execPath, [
    "scripts/generate-update-manifest.mjs",
    assetDirectory,
    join(directory, "github"),
    version,
    "https://github.com/AlawnCN/opslog-release/releases/download",
    `v${version}`,
    notesFile,
    "2026-09-25T00:00:00Z"
  ]);

  const main = JSON.parse(await readFile(join(directory, "github/latest.json"), "utf8"));
  const reader = JSON.parse(await readFile(join(directory, "github/reader-latest.json"), "utf8"));
  assert.equal(main.notes, "## 更新内容\n\n- Reader 自动更新\n");
  assert.equal(reader.notes, main.notes);
  assert.match(main.platforms["windows-x86_64"].url, /OpsLog_3\.0\.29_windows_x64_setup\.exe$/);
  assert.match(reader.platforms["windows-x86_64"].url, /OpsLog_Reader_3\.0\.29_windows_x64_setup\.exe$/);
  assert.match(reader.platforms["darwin-aarch64"].url, /OpsLog_Reader_3\.0\.29_macos_arm64\.app\.tar\.gz$/);

  await execute(process.execPath, [
    "scripts/generate-update-manifest.mjs",
    assetDirectory,
    join(directory, "gitea"),
    version,
    "https://git.alawn.cn/Alawn/opslog-release/releases/download",
    `v${version}`,
    notesFile,
    "2026-09-25T00:00:00Z"
  ]);
  const gitea = JSON.parse(await readFile(join(directory, "gitea/latest.json"), "utf8"));
  assert.equal(gitea.notes, main.notes);
  assert.match(gitea.platforms["windows-x86_64"].url, /^https:\/\/git\.alawn\.cn\//);
  assert.equal(gitea.platforms["windows-x86_64"].signature, main.platforms["windows-x86_64"].signature);
  assert.equal(gitea.pub_date, main.pub_date);

  await execute(process.execPath, ["scripts/write-release-checksums.mjs", assetDirectory, join(directory, "github")]);
  await execute(process.execPath, ["scripts/write-release-checksums.mjs", assetDirectory, join(directory, "gitea")]);
  const githubSums = await readFile(join(directory, "github/SHA256SUMS"), "utf8");
  const giteaSums = await readFile(join(directory, "gitea/SHA256SUMS"), "utf8");
  assert.match(githubSums, /  latest\.json\n/);
  assert.match(githubSums, /  reader-latest\.json\n/);
  assert.notEqual(githubSums, giteaSums, "mirror-specific manifests must have separate checksums");
});
