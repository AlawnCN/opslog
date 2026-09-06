import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [, , releaseDirectory, version, repository, tag] = process.argv;

const fail = (message) => {
  throw new Error(`Updater manifest: ${message}`);
};

if (!releaseDirectory || !version || !repository || !tag) {
  fail("usage: node scripts/generate-update-manifest.mjs <release-dir> <version> <owner/repo> <tag>");
}
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) fail(`invalid version: ${version}`);
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) fail(`invalid repository: ${repository}`);
if (!/^v[0-9A-Za-z_.+-]+$/.test(tag)) fail(`invalid release tag: ${tag}`);

const asset = async (platform, filename) => {
  await access(join(releaseDirectory, filename));
  const signature = (await readFile(join(releaseDirectory, `${filename}.sig`), "utf8")).trim();
  if (!signature) fail(`empty signature for ${filename}`);
  return [platform, {
    signature,
    url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(filename)}`
  }];
};

const platforms = Object.fromEntries(await Promise.all([
  asset("windows-x86_64", `OpsLog_${version}_windows_x64_setup.exe`),
  asset("darwin-aarch64", `OpsLog_${version}_macos_arm64.app.tar.gz`),
  asset("darwin-x86_64", `OpsLog_${version}_macos_x64.app.tar.gz`)
]));

const manifest = {
  version,
  notes: `OpsLog ${version} 已发布。完整更新说明请查看 GitHub Release。`,
  pub_date: new Date().toISOString(),
  platforms
};

await writeFile(join(releaseDirectory, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
