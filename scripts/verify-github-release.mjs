import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

const [, , repository, tag, assetDirectory, manifestDirectory, notesFile] = process.argv;
const token = process.env.GH_TOKEN;
if (!repository || !tag || !assetDirectory || !manifestDirectory || !notesFile || !token) {
  throw new Error("repository, tag, asset paths, notes file and GH_TOKEN are required");
}
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("invalid repository");
const response = await fetch(`https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`, {
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "OpsLog-release-verifier"
  }
});
if (!response.ok) throw new Error(`GitHub Release lookup failed: HTTP ${response.status}`);
const release = await response.json();
if (release.body !== await readFile(notesFile, "utf8")) throw new Error("GitHub Release body differs from manifests");

const paths = [
  ...(assetDirectory === "-" ? [] : (await readdir(assetDirectory)).map((name) => join(assetDirectory, name))),
  ...(assetDirectory === "-" ? ["latest.json", "reader-latest.json"] : ["latest.json", "reader-latest.json", "SHA256SUMS"])
    .map((name) => join(manifestDirectory, name))
];
if (release.assets.length !== paths.length) throw new Error(`GitHub ${tag} contains unexpected extra assets`);
for (const path of paths) {
  const name = basename(path);
  const bytes = await readFile(path);
  const asset = release.assets.find((item) => item.name === name);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (!asset || asset.size !== bytes.length || asset.digest !== `sha256:${hash}`) {
    throw new Error(`GitHub asset verification failed: ${name}`);
  }
}
process.stdout.write(`Verified GitHub ${tag} with ${paths.length} assets\n`);
