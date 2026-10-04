import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readJson = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

test("reader version control displays the running version and retains update action", async () => {
  const reader = await readFile("web/src/ReaderApp.tsx", "utf8");
  assert.match(reader, /getVersion\(\)/);
  assert.match(reader, /version as buildVersion/);
  assert.match(reader, /v\{currentVersion\}/);
  assert.match(reader, /点击版本号检查更新/);
  assert.match(reader, /onClick=\{\(\) => void appUpdater\.checkForUpdates\(\)\}/);
  assert.match(reader, /disabled=\{updateBusy\}/);
});

test("Reader opens into a loading workspace and shares the modern window chrome", async () => {
  const reader = await readFile("web/src/ReaderApp.tsx", "utf8");
  const titlebar = await readFile("web/src/components/ReaderTitlebar.tsx", "utf8");
  const config = await readJson("src-tauri/tauri.reader.conf.json");
  const window = (config.app as {windows:Array<Record<string,unknown>>}).windows[0];
  assert.match(reader, /useState\(desktopMode\)/);
  assert.match(reader, /if \(!document && !opening && !parsing\)/);
  assert.match(reader, /loading=\{opening \|\| parsing\}/);
  assert.match(titlebar, /startDragging\(\)/);
  for (const operation of ["minimize", "toggleMaximize", "close"]) assert.ok(titlebar.includes(`${operation}()`));
  assert.equal(window.titleBarStyle, "Overlay");
  assert.equal(window.hiddenTitle, true);
  assert.equal(window.visible, false, "restore geometry before showing the window");
});

test("Reader persists normal geometry separately from maximized bounds", async () => {
  const native = await readFile("src-tauri/src/reader_window.rs", "utf8");
  const startup = await readFile("src-tauri/src/lib.rs", "utf8");
  assert.match(startup, /reader_window::initialize\(app\)/);
  assert.match(native, /reader-window\.json/);
  assert.match(native, /WindowEvent::CloseRequested/);
  assert.match(native, /available_monitors\(\)/);
  assert.match(native, /scale \/ saved\.scale/);
  assert.match(native, /target_os = "windows"/);
  assert.match(native, /set_decorations\(false\)/);
});

test("standalone reader keeps a distinct app identity without forcing a global association", async () => {
  const config = await readJson("src-tauri/tauri.reader.conf.json");
  assert.equal(config.productName, "OpsLog Reader");
  assert.equal(config.identifier, "com.murong.opslog.reader");
  assert.equal(config.mainBinaryName, "opslog-reader");

  const app = config.app as { windows?: Array<{ decorations?: boolean; titleBarStyle?: string }> };
  assert.equal(app.windows?.[0]?.decorations, true);
  assert.equal(app.windows?.[0]?.titleBarStyle, "Overlay");

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
  assert.match(workflow, /GITEA_RELEASE_TOKEN/);
  assert.match(workflow, /GH_RELEASE_TOKEN/);
  assert.match(workflow, /publish-gitea-release\.mjs/);
  assert.match(workflow, /verify-github-release\.mjs/);
  assert.match(workflow, /promote-gitea-manifests\.mjs/);
  assert.match(workflow, /verify-public-release-boundary\.mjs/);
  assert.doesNotMatch(workflow, /Preserve old clients' GitHub update endpoint/);
});

test("standalone reader uses its own signed update channel", async () => {
  const config = await readJson("src-tauri/tauri.reader.conf.json");
  const plugins = config.plugins as { updater?: { endpoints?: string[] } };
  assert.deepEqual(plugins.updater?.endpoints, [
    "https://git.alawn.cn/Alawn/opslog-release/raw/branch/main/reader-latest.json",
    "https://github.com/AlawnCN/opslog-release/releases/latest/download/reader-latest.json"
  ]);

  const manifestGenerator = await readFile("scripts/generate-update-manifest.mjs", "utf8");
  assert.match(manifestGenerator, /writeManifest\("reader-latest\.json", "OpsLog_Reader"\)/);
});
