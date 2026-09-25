import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [, , assetDirectory, outputDirectory, version, downloadBaseUrl, tag, releaseNotesFile, releaseDate] = process.argv;

const fail = (message) => {
  throw new Error(`Updater manifest: ${message}`);
};

if (!assetDirectory || !outputDirectory || !version || !downloadBaseUrl || !tag || !releaseNotesFile || !releaseDate) {
  fail("usage: node scripts/generate-update-manifest.mjs <asset-dir> <output-dir> <version> <download-base-url> <tag> <release-notes-file> <release-date>");
}
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) fail(`invalid version: ${version}`);
if (!/^v[0-9A-Za-z_.+-]+$/.test(tag)) fail(`invalid release tag: ${tag}`);
const base = new URL(downloadBaseUrl);
if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) fail("download base must be a public HTTPS URL");
const assetBase = `${base.toString().replace(/\/$/, "")}/${encodeURIComponent(tag)}`;
const pubDate = new Date(releaseDate);
if (Number.isNaN(pubDate.getTime())) fail("invalid release date");

const asset = async (platform, filename) => {
  await access(join(assetDirectory, filename));
  const signature = (await readFile(join(assetDirectory, `${filename}.sig`), "utf8")).trim();
  if (!signature) fail(`empty signature for ${filename}`);
  return [platform, {
    signature,
    url: `${assetBase}/${encodeURIComponent(filename)}`
  }];
};

const notes = await readFile(releaseNotesFile, "utf8");
if (!notes.trim()) fail("release notes are required and cannot be empty");

const writeManifest = async (filename, prefix) => {
  const platforms = Object.fromEntries(await Promise.all([
    asset("windows-x86_64", `${prefix}_${version}_windows_x64_setup.exe`),
    asset("darwin-aarch64", `${prefix}_${version}_macos_arm64.app.tar.gz`),
    asset("darwin-x86_64", `${prefix}_${version}_macos_x64.app.tar.gz`)
  ]));
  const manifest = { version, notes, pub_date: pubDate.toISOString(), platforms };
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(join(outputDirectory, filename), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
};

await Promise.all([
  writeManifest("latest.json", "OpsLog"),
  writeManifest("reader-latest.json", "OpsLog_Reader")
]);
