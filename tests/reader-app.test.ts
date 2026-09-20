import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readJson = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

test("standalone reader keeps a distinct app identity without forcing a global association", async () => {
  const config = await readJson("src-tauri/tauri.reader.conf.json");
  assert.equal(config.productName, "OpsLog Reader");
  assert.equal(config.identifier, "com.murong.opslog.reader");
  assert.equal(config.mainBinaryName, "opslog-reader");

  const app = config.app as { windows?: Array<{ decorations?: boolean; titleBarStyle?: string }> };
  assert.equal(app.windows?.[0]?.decorations, true);
  assert.equal(app.windows?.[0]?.titleBarStyle, undefined);

  const bundle = config.bundle as { fileAssociations?: unknown; macOS?: { infoPlist?: string } };
  assert.equal(bundle.fileAssociations, undefined);
  assert.equal(bundle.macOS?.infoPlist, "reader.Info.plist");

  const macInfo = await readFile("src-tauri/reader.Info.plist", "utf8");
  assert.match(macInfo, /<string>trc<\/string>/);
  assert.match(macInfo, /<key>LSHandlerRank<\/key>\s*<string>Alternate<\/string>/);
  assert.doesNotMatch(macInfo, /<string>Owner<\/string>/);
});

test("reader asks before setting the trc default application", async () => {
  const readerApp = await readFile("web/src/ReaderApp.tsx", "utf8");
  const associationGuide = await readFile("web/src/components/TrcAssociationGuide.tsx", "utf8");
  const association = await readFile("src-tauri/src/reader_association.rs", "utf8");
  assert.match(associationGuide, /设置 TRC 默认打开方式/);
  assert.match(associationGuide, /稍后设置/);
  assert.match(readerApp, /ASSOCIATION_PROMPT_KEY/);
  assert.match(association, /associate_trc_files/);
});

test("release workflow builds both OpsLog applications", async () => {
  const workflow = await readFile(".github/workflows/build-windows.yml", "utf8");
  assert.match(workflow, /npm run desktop:windows:setup/);
  assert.match(workflow, /npm run reader:windows:setup/);
  assert.match(workflow, /npm run desktop:macos/);
  assert.match(workflow, /npm run reader:macos/);
  assert.match(workflow, /OpsLog_Reader_/);
  assert.match(workflow, /OpsLog_Reader_\$\{packageVersion\}_windows_x64_setup\.exe\.sig/);
  assert.match(workflow, /OpsLog_Reader_\$\{package_version\}_macos_\$\{\{ matrix\.arch \}\}\.app\.tar\.gz/);
});

test("standalone reader uses its own signed update channel", async () => {
  const config = await readJson("src-tauri/tauri.reader.conf.json");
  const plugins = config.plugins as { updater?: { endpoints?: string[] } };
  assert.deepEqual(plugins.updater?.endpoints, [
    "https://github.com/AlawnCN/opslog/releases/latest/download/reader-latest.json"
  ]);

  const manifestGenerator = await readFile("scripts/generate-update-manifest.mjs", "utf8");
  assert.match(manifestGenerator, /writeManifest\("reader-latest\.json", "OpsLog_Reader"\)/);
});
